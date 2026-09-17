import test from 'node:test'
import assert from 'node:assert/strict'

import {
  capturePositionPrediction,
  captureStockPickAgentSelection,
  captureStockPickPrediction,
} from '../api/_learning_capture.js'

function captureStore() {
  const events = []
  return {
    events,
    async saveEvent(event) {
      events.push(event)
      return event
    },
  }
}

test('选股召回仅采集排序训练字段并保留全候选顺序', async () => {
  const store = captureStore()
  await captureStockPickPrediction({
    availability: 'READY',
    tradeDate: '2026-09-17',
    generatedAt: Date.parse('2026-09-17T07:10:00Z'),
    rankingSource: 'MODEL',
    modelVersion: 'ranking-v1',
    universe: { total: 5000, inspected: 4880 },
    candidates: [{
      code: '600000',
      name: '不应写入训练账本',
      rank: 1,
      ranking: { source: 'MODEL', score: 0.81 },
      model: {
        pFill: 0.7,
        pWinGivenFill: 0.62,
        expectedNetR: 0.3,
      },
      quote: {
        price: 10.2,
        pct: 3.2,
        tradeDate: '2026-09-17',
      },
      recallScore: 72,
      recallReasons: ['不应写入训练账本'],
    }],
  }, { store })

  assert.equal(store.events.length, 1)
  assert.deepEqual(store.events[0].payload.candidates, [{
    code: '600000',
    rank: 1,
    rankingSource: 'MODEL',
    rankingScore: 0.81,
    pFill: 0.7,
    pWinGivenFill: 0.62,
    expectedNetR: 0.3,
    price: 10.2,
    pct: 3.2,
    amount: null,
    turnover: null,
    volumeRatio: null,
    mainInflow: null,
    mainRatio: null,
    recallScore: 72,
    tradeDate: '2026-09-17',
  }])
  assert.equal(
    JSON.stringify(store.events[0]).includes('不应写入训练账本'),
    false,
  )
})

test('Agent 精选绑定召回版本和脱敏账户', async () => {
  const store = captureStore()
  await captureStockPickAgentSelection({
    availability: 'READY',
    agentRunId: 'agent-run-1',
    generatedAt: Date.parse('2026-09-17T07:15:00Z'),
    mode: 'INTRADAY',
    conclusion: 'SELECT',
    agentModel: 'agent-v1',
    selections: [{
      code: '600000',
      decision: 'BUY_NOW',
      buyStrategy: { entryPrice: 10.1, positionPctMax: 5 },
      invalidation: '跌破9.8',
      rationale: '不进入训练账本',
    }],
  }, {
    store,
    accountScope: 'private-account',
    snapshot: {
      tradeDate: '2026-09-17',
      generatedAt: 1,
      modelVersion: 'ranking-v1',
    },
  })

  const json = JSON.stringify(store.events[0])
  assert.equal(json.includes('private-account'), false)
  assert.equal(json.includes('不进入训练账本'), false)
  assert.equal(store.events[0].payload.modelVersion, 'ranking-v1')
})

test('持仓预测保存模型Agent版本与动作参数但不写解释文本', async () => {
  const store = captureStore()
  await capturePositionPrediction({
    code: '600000',
    mode: 'holding',
    accountScope: 'private-account',
    now: Date.parse('2026-09-17T07:20:00Z'),
    guidance: {
      availability: 'READY',
      agentRunId: 'position-run-1',
      generatedAt: Date.parse('2026-09-17T07:20:00Z'),
      modelVersion: 'position-v1',
      agentModel: 'agent-v1',
      rationale: '不进入训练账本',
    },
    advice: {
      action: '减仓',
      currentPrice: 10.2,
      stop: 9.8,
      target: 10.8,
      decisionPlan: { decisionId: 'decision-1' },
      decisionSource: {
        pFill: 0.8,
        pWinGivenFill: 0.6,
        expectedNetR: 0.2,
      },
    },
  }, { store })

  const event = store.events[0]
  assert.equal(event.payload.action, '减仓')
  assert.equal(event.payload.modelVersion, 'position-v1')
  assert.equal(event.sourceId, 'decision-1')
  assert.equal(event.lineage.agentRunId, 'position-run-1')
  assert.equal(JSON.stringify(event).includes('不进入训练账本'), false)
})
