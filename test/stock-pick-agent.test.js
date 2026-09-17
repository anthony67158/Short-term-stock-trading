import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STOCK_PICK_AGENT_SCHEMA,
  topStockPickReferences,
  normalizeStockPickAgentSelection,
  unavailableStockPickAgentSelection,
} from '../shared/stockPickAgent.js'

const candidateSet = [
  {
    code: '600000', name: '浦发银行',
    quote: { price: 10, low: 9.8, high: 10.3 },
    ranking: { source: 'MODEL', score: 0.8 },
    recallReasons: ['当日涨幅 4%'],
  },
  {
    code: '600001', name: '测试二',
    quote: { price: 20, low: 19.5, high: 20.6 },
    ranking: { source: 'MODEL', score: 0.6 },
  },
]

test('Agent 精选：只接受候选池内 code，买入价须落在当日高低价带', () => {
  const result = normalizeStockPickAgentSelection({
    conclusion: 'SELECT',
    overallReason: '两只资金与量价共振',
    selections: [
      {
        code: '600000',
        rationale: '主力净流入且站上均价线',
        buyStrategy: { entryPrice: 10.1, positionPctMax: 5, plan: '回踩10元分两批' },
        timing: { trigger: '回踩10元企稳', window: '今日有效', nextSession: '次日看量能' },
        counterCase: '大盘跳水则放弃',
        invalidation: '跌破9.8元',
      },
      // 越界：编造超出价带的买入价 → entryPrice 回落现价
      {
        code: '600001',
        rationale: '突破确认',
        buyStrategy: { entryPrice: 999, positionPctMax: 50, plan: '' },
        timing: {},
      },
      // 不存在的 code → 丢弃
      { code: '999999', rationale: '不该出现' },
    ],
    limitations: ['样本不足'],
  }, { candidateSet, agentModel: 'claude', agentRunId: 'run-1' })

  assert.equal(result.schemaVersion, STOCK_PICK_AGENT_SCHEMA)
  assert.equal(result.conclusion, 'SELECT')
  assert.equal(result.selections.length, 2)
  assert.equal(result.selections[0].code, '600000')
  assert.equal(result.selections[0].rank, 1)
  assert.equal(result.selections[0].buyStrategy.entryPrice, 10.1)
  // 仓位上限被夹到 10%
  assert.equal(result.selections[1].buyStrategy.positionPctMax, 10)
  // 编造的越界价回落到候选现价 20
  assert.equal(result.selections[1].buyStrategy.entryPrice, 20)
  // 不存在的 code 未进入
  assert.ok(!result.selections.some((item) => item.code === '999999'))
})

test('Agent 精选：无有效选择时结论降级 NO_SELECTION', () => {
  const result = normalizeStockPickAgentSelection({
    conclusion: 'SELECT',
    selections: [{ code: '999999', rationale: 'x' }],
  }, { candidateSet })
  assert.equal(result.conclusion, 'NO_SELECTION')
  assert.equal(result.selections.length, 0)
})

test('缺少理由的候选不被放行', () => {
  const result = normalizeStockPickAgentSelection({
    conclusion: 'SELECT',
    selections: [{ code: '600000', rationale: '' }],
  }, { candidateSet })
  assert.equal(result.selections.length, 0)
})

test('Top 候选参考：用于 Agent 不选时的降级展示', () => {
  const refs = topStockPickReferences({ candidates: candidateSet }, 2)
  assert.equal(refs.length, 2)
  assert.equal(refs[0].code, '600000')
  assert.equal(refs[0].rankingSource, 'MODEL')
})

test('不可用快照明确 UNAVAILABLE', () => {
  const snapshot = unavailableStockPickAgentSelection({
    reasonCode: 'AGENT_TIMEOUT', reason: '响应超时',
  })
  assert.equal(snapshot.availability, 'UNAVAILABLE')
  assert.equal(snapshot.conclusion, 'NO_SELECTION')
  assert.equal(snapshot.selections.length, 0)
})
