import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMarketBoardGuidance,
  buildSentimentGuidance,
} from '../shared/marketGuidance.js'

test('指数偏弱但上涨家数占优时解释为结构性赚钱行情', () => {
  const guidance = buildMarketBoardGuidance({
    regime: {
      regime: 'TRANSITION',
      targetPositionPct: { min: 20, max: 40 },
    },
    indices: [
      { name: '上证指数', pct: 0.08 },
      { name: '深证成指', pct: -0.14 },
      { name: '创业板指', pct: -0.32 },
      { name: '北证50', pct: -0.45 },
    ],
    breadth: {
      up: 3219,
      down: 2238,
    },
    limitUp: 63,
    limitDown: 1,
    topSector: { name: '通信网络设备及器件' },
  })

  assert.match(guidance.conclusion, /指数偏弱.*多数个股上涨/)
  assert.match(guidance.evidence, /上涨3219家、下跌2238家/)
  assert.match(guidance.action, /20~40%/)
  assert.match(guidance.action, /不追/)
})

test('指数与个股同步走弱时明确防守并暂停新增风险', () => {
  const guidance = buildMarketBoardGuidance({
    regime: {
      regime: 'RISK_OFF',
      targetPositionPct: { min: 0, max: 20 },
    },
    indices: [
      { name: '上证指数', pct: -1.2 },
      { name: '深证成指', pct: -1.8 },
    ],
    breadth: {
      up: 900,
      down: 4300,
    },
    limitUp: 12,
    limitDown: 28,
  })

  assert.match(guidance.conclusion, /同步偏弱/)
  assert.match(guidance.action, /暂停普通新增仓位/)
  assert.match(guidance.action, /0~20%/)
})

test('情绪火热且封板质量尚可时强调赚钱效应与追高风险并存', () => {
  const guidance = buildSentimentGuidance({
    score: 75,
    ztCount: 63,
    zbCount: 13,
    breakRate: 17,
    maxBoard: 7,
    lianban: 16,
    b: { limitDown: 1 },
  })

  assert.match(guidance.conclusion, /赚钱效应较强/)
  assert.match(guidance.evidence, /63家涨停/)
  assert.match(guidance.evidence, /炸板率17%/)
  assert.match(guidance.action, /不要追/)
  assert.match(guidance.action, /低位启动/)
})

test('炸板率过高时明确封板质量下降并限制追涨', () => {
  const guidance = buildSentimentGuidance({
    score: 38,
    ztCount: 20,
    zbCount: 15,
    breakRate: 43,
    maxBoard: 3,
    lianban: 4,
    b: { limitDown: 12 },
  })

  assert.match(guidance.conclusion, /封板质量下降/)
  assert.match(guidance.action, /暂停追涨/)
})

test('开盘前涨跌家数均为零时安全降级为涨跌比暂缺', () => {
  const guidance = buildMarketBoardGuidance({
    regime: { regime: 'UNKNOWN' },
    breadth: { up: 0, down: 0 },
  })

  assert.match(guidance.evidence, /涨跌比暂缺/)
  assert.match(guidance.action, /暂停新增风险/)
})

test('情绪数据缺失时不编造赚钱效应结论', () => {
  const guidance = buildSentimentGuidance()

  assert.equal(guidance.tone, 'muted')
  assert.match(guidance.conclusion, /数据不足/)
  assert.match(guidance.action, /等待涨跌停与炸板数据恢复/)
})
