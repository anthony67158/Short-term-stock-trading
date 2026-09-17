import test from 'node:test'
import assert from 'node:assert/strict'

import {
  settleLearningEvents,
} from '../api/_learning_settlement.js'
import {
  captureAccountLearningEvents,
} from '../api/_learning_capture.js'
import {
  LEARNING_EVENT_KIND,
  buildLearningEvent,
} from '../shared/learningEvent.js'
import {
  settleStockPickCandidate,
} from '../shared/learningSettlement.js'

function eventStore(initial = []) {
  const values = [...initial]
  return {
    values,
    async saveEvent(event) {
      const current = values.find((item) =>
        item.eventId === event.eventId
      )
      if (current) return current
      values.push(event)
      return event
    },
    async listEvents({ kind }) {
      return values.filter((event) => !kind || event.kind === kind)
    },
  }
}

test('选股样本必须观察满五个后续交易日才成熟', () => {
  const input = {
    prediction: { tradeDate: '2026-09-10' },
    candidate: { price: 10 },
    evaluatedAt: 100,
  }
  assert.equal(settleStockPickCandidate({
    ...input,
    bars: [
      { date: '2026-09-11', close: 10.1 },
      { date: '2026-09-14', close: 10.2 },
    ],
  }).maturity, 'PENDING')

  const result = settleStockPickCandidate({
    ...input,
    bars: [
      { date: '2026-09-11', high: 10.2, low: 9.9, close: 10.1 },
      { date: '2026-09-14', high: 10.5, low: 10, close: 10.4 },
      { date: '2026-09-15', high: 10.6, low: 10.2, close: 10.5 },
      { date: '2026-09-16', high: 10.7, low: 10.3, close: 10.6 },
      { date: '2026-09-17', high: 10.8, low: 10.4, close: 10.7 },
    ],
  })
  assert.equal(result.maturity, 'MATURED')
  assert.equal(result.feeAdjusted, true)
  assert.equal(result.feePolicyId, 'A_SHARE_STANDARD_V1')
  assert.equal(result.quantity, 100)
  assert.equal(result.grossReturnPct, 7)
  assert.equal(result.totalFees, 10.56)
  assert.equal(result.returnPct, 5.9144)
  assert.equal(result.mfePct, 6.9094)
  assert.equal(result.maePct, -2.0408)
  assert.equal(result.positive2PctHit, true)
})

test('选股方向命中使用双边费用后的净收益', () => {
  const result = settleStockPickCandidate({
    prediction: { tradeDate: '2026-09-10' },
    candidate: { price: 10 },
    bars: [
      { date: '2026-09-11', high: 10.08, low: 9.98, close: 10.02 },
      { date: '2026-09-14', high: 10.08, low: 9.98, close: 10.03 },
      { date: '2026-09-15', high: 10.08, low: 9.98, close: 10.04 },
      { date: '2026-09-16', high: 10.08, low: 9.98, close: 10.05 },
      { date: '2026-09-17', high: 10.08, low: 9.98, close: 10.06 },
    ],
  })

  assert.equal(result.grossReturnPct, 0.6)
  assert.ok(result.returnPct < 0)
  assert.equal(result.directionHit, false)
  assert.equal(result.positive2PctHit, false)
})

test('账户学习只采集人工执行和已完成实际归因', async () => {
  const store = eventStore()
  const result = await captureAccountLearningEvents({
    nick: 'private-account',
    data: {
      decisionLog: [
        {
          id: 'exec-1',
          kind: 'execution',
          source: 'manual',
          code: '600000',
          side: 'sell',
          price: 10.5,
          qty: 2,
          at: Date.parse('2026-09-17T07:00:00Z'),
          transactionId: 'txn-1',
        },
        {
          id: 'sim-1',
          kind: 'execution',
          source: 'simulation',
          code: '600001',
          at: Date.parse('2026-09-17T07:00:00Z'),
        },
      ],
      executionAttributions: [
        {
          planId: 'plan-1',
          decisionId: 'decision-1',
          code: '600000',
          side: 'SELL',
          status: 'COMPLETED',
          learningEligible: true,
          validationComplete: true,
          filledLots: 2,
          fillRatePct: 100,
          netPnl: 120,
          plannedExpectedNetR: 0.4,
          realizedNetR: 0.6,
          expectancyErrorR: 0.2,
          transactionIds: ['txn-1'],
          updatedAt: Date.parse('2026-09-17T08:00:00Z'),
        },
        {
          planId: 'plan-pending',
          learningEligible: false,
          validationComplete: false,
        },
      ],
    },
  }, { store })

  assert.deepEqual(result, { executions: 1, outcomes: 1 })
  assert.deepEqual(
    store.values.map((event) => event.kind).sort(),
    ['execution', 'outcome'],
  )
  assert.equal(
    JSON.stringify(store.values).includes('private-account'),
    false,
  )
})

test('每日结算将T5结果写成不可变结果并可幂等重跑', async () => {
  const prediction = buildLearningEvent({
    kind: LEARNING_EVENT_KIND.STOCK_PICK_PREDICTION,
    sourceId: 'stock-pick:2026-09-10:1',
    tradeDate: '2026-09-10',
    occurredAt: 1,
    payload: {
      modelVersion: 'ranking-v1',
      candidates: [{ code: '600000', price: 10, rankingScore: 0.8 }],
    },
  })
  const store = eventStore([prediction])
  const options = {
    store,
    accounts: async () => [],
    fetchBars: async () => [
      { date: '2026-09-11', high: 10.2, low: 9.9, close: 10.1 },
      { date: '2026-09-14', high: 10.3, low: 10, close: 10.2 },
      { date: '2026-09-15', high: 10.4, low: 10.1, close: 10.3 },
      { date: '2026-09-16', high: 10.5, low: 10.2, close: 10.4 },
      { date: '2026-09-17', high: 10.6, low: 10.3, close: 10.5 },
    ],
    now: Date.parse('2026-09-17T09:10:00Z'),
  }

  const first = await settleLearningEvents(options)
  const second = await settleLearningEvents(options)

  assert.equal(first.stockPick.matured, 1)
  assert.equal(second.stockPick.candidates, 0)
  assert.equal(
    store.values.filter((event) =>
      event.payload?.outcomeType === 'STOCK_PICK_T5'
    ).length,
    1,
  )
})
