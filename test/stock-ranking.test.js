import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANDIDATE_RANKING_VERSION,
  marketPageNumbers,
  normalizePickDecision,
  normalizeStoredPickSnapshot,
  rankCandidateShortlist,
  rankMarketCandidates,
  rerankQuantCandidates,
  stockPickSession,
  stockPickSavedLabel,
} from '../shared/stockRanking.js'

const row = (patch = {}) => ({
  code: '600000',
  name: '测试股份',
  price: 10,
  pct: 2,
  speed: 0.5,
  mainInflow: 150_000_000,
  mainRatio: 8,
  turnover: 5,
  volRatio: 1.8,
  amount: 800_000_000,
  ...patch,
})

test('候选初筛过滤风险名称、停牌、低流动性和过热标的', () => {
  const result = rankMarketCandidates([
    row({ code: '600001' }),
    row({ code: '600002', name: 'ST风险' }),
    row({ code: '600003', name: '退市整理' }),
    row({ code: '600004', price: 0 }),
    row({ code: '600005', amount: 20_000_000 }),
    row({ code: '600006', pct: 9.7 }),
    row({ code: '600007', turnover: 31 }),
  ])

  assert.deepEqual(result.list.map((item) => item.code), ['600001'])
  assert.equal(result.rankingVersion, CANDIDATE_RANKING_VERSION)
})

test('资金量能共振标的排在单纯高涨幅标的之前', () => {
  const result = rankMarketCandidates([
    row({
      code: '600001',
      pct: 3,
      mainRatio: 12,
      mainInflow: 500_000_000,
      volRatio: 2.2,
      turnover: 6,
    }),
    row({
      code: '600002',
      pct: 7,
      mainRatio: 0,
      mainInflow: 0,
      volRatio: 1,
      turnover: 2,
    }),
  ])

  assert.equal(result.list[0].code, '600001')
  assert.ok(result.list[0].marketScore > result.list[1].marketScore)
})

test('候选复排同时参考市场分、量化把握和预期收益', () => {
  const result = rerankQuantCandidates([
    row({
      code: '600001',
      marketScore: 80,
      quant: { score: 60, upProb: 58, expRet: 1.2 },
    }),
    row({
      code: '600002',
      marketScore: 60,
      quant: {
        score: 82,
        upProb: 70,
        expRet: 3,
        highConfFired: true,
      },
    }),
  ])

  assert.equal(result[0].code, '600002')
  assert.ok(result[0].combinedScore > result[1].combinedScore)
})

test('入场确认只由量价和量化硬条件决定', () => {
  const result = rankCandidateShortlist([
    row({
      code: '600001',
      marketScore: 70,
      quant: { score: 70, upProb: 65, expRet: 2 },
    }),
    row({
      code: '600002',
      marketScore: 52,
      quant: { score: 70, upProb: 65, expRet: 2 },
    }),
  ])

  assert.equal(result.list[0].entrySignal.passed, true)
  assert.equal(result.list[1].entrySignal.passed, false)
  assert.match(
    result.list[1].entrySignal.failedRules.join('；'),
    /市场分至少55/,
  )
})

test('缺少量化确认的候选只能进入等待名单', () => {
  const result = rankCandidateShortlist([
    row({ code: '600001', marketScore: 70, quant: null }),
  ])

  assert.equal(result.executable.length, 0)
  assert.equal(result.watchlist.length, 1)
  assert.equal(result.watchlist[0].entrySignal.passed, false)
})

test('模型不能把未通过入场确认的候选升级为可执行', () => {
  const result = normalizePickDecision({
    noTrade: false,
    picks: [
      { code: '600001', actionability: '可执行' },
      { code: '600002', actionability: '可执行' },
    ],
  }, ['600001', '600002'], [
    { code: '600001', entrySignal: { passed: true } },
    { code: '600002', entrySignal: { passed: false } },
  ])

  assert.equal(result.picks[0].actionability, '可执行')
  assert.equal(result.picks[1].actionability, '等待触发')
})

test('空模型结果使用确定性短名单生成条件候选', () => {
  const result = normalizePickDecision(
    { noTrade: true, noTradeReason: '当前不追高', picks: [] },
    ['600001'],
    [row({
      code: '600001',
      marketScore: 70,
      combinedScore: 72,
      quant: {
        score: 68,
        upProb: 61,
        buyPrice: 10,
        takeProfit: 10.6,
        stopLoss: 9.7,
      },
    })],
  )

  assert.equal(result.fallback, true)
  assert.equal(result.picks.length, 1)
  assert.match(result.picks[0].buyZone, /~/)
  assert.ok(result.picks[0].target > result.picks[0].stop)
})

test('已保存结果剔除短名单之外的股票', () => {
  const saved = normalizeStoredPickSnapshot({
    shortlist: [row({ code: '600001' })],
    result: {
      picks: [
        { code: '600001', actionability: '观察' },
        { code: '600999', actionability: '可执行' },
      ],
    },
  })

  assert.deepEqual(saved.result.picks.map((item) => item.code), ['600001'])
})

test('没有短名单的旧空结果自动失效以便重新生成', () => {
  const saved = normalizeStoredPickSnapshot({
    shortlist: [],
    result: { picks: [] },
  })

  assert.equal(saved.result, null)
  assert.equal(saved.legacyEmpty, true)
})

test('全市场总数展开为完整分页', () => {
  assert.deepEqual(marketPageNumbers(205, 100), [1, 2, 3])
})

test('休市仍可生成下一交易日观察池', () => {
  const state = stockPickSession(
    Date.parse('2026-08-23T04:00:00.000Z'),
  )
  assert.equal(state.canRun, true)
  assert.equal(state.mode, 'next_open')
})

test('保存标签明确区分盘中结果和开盘观察池', () => {
  assert.match(stockPickSavedLabel({
    savedSession: 'next_open',
    timeText: '08-23 12:00',
  }), /开盘观察池/)
})
