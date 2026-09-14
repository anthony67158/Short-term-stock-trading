import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHistoricalLedgerBatch,
  expandHistoricalLedgerBatch,
  settleHistoricalEvent,
} from '../scripts/lib/opportunity-history-backfill.mjs'

function replayBatch(candidatePatch = {}) {
  const plan = {
    action: 'WATCH_BUY',
    formulaId: 'UNKNOWN',
    playbookId: 'ACCUMULATION',
    playbookScore: 72,
    marketOpportunityFactor: 0.9,
    route: 'IMMEDIATE',
    primaryPrice: 10,
    priceType: 'IMMEDIATE',
    stopPrice: 9,
    targetPrice: 11,
    riskReward: 1,
    validUntil: Date.parse('2026-06-05T15:00:00+08:00'),
    timeStopTradingDays: 3,
    priceContractValid: true,
    marketAllowsRisk: true,
    executionState: 'PROBE',
  }
  return buildHistoricalLedgerBatch({
    mode: 'close',
    tradeDate: '2026-06-01',
    slot: '1510',
    generatedAt: Date.parse('2026-06-01T15:10:00+08:00'),
    marketContext: {
      marketGate: {
        allowed: true,
        riskTier: 'STANDARD',
        regime: { label: '轮动' },
      },
    },
    scan: {
      universe: {
        total: 1,
        inspectedCount: 1,
        prefilterCount: 1,
        technicalCandidateCount: 1,
        formulaMatchCount: 1,
      },
      candidateEvents: [{
        code: '600519',
        name: '贵州茅台',
        stageReached: 'DISPLAYED',
        displayedRank: 1,
        quote: {
          price: 10,
          preClose: 9.8,
          open: 9.9,
          high: 10.1,
          low: 9.8,
          pct: 2.04,
          amount: 100_000_000,
          turnover: 2,
          tradeDate: '2026-06-01',
        },
        formulaEvaluations: [{
          formulaId: 'UNKNOWN',
          matched: false,
          score: 0,
        }],
        decision: plan,
        counterfactualPlans: [plan],
        ...candidatePatch,
      }],
    },
  })
}

const prefixBars = [
  {
    date: '2026-06-02',
    tradeTime: '2026-06-02 09:35:00',
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 1000,
    preClose: 9.9,
  },
  {
    date: '2026-06-02',
    tradeTime: '2026-06-02 09:40:00',
    open: 10,
    high: 10.2,
    low: 9.9,
    close: 10.1,
    volume: 1000,
  },
  {
    date: '2026-06-02',
    tradeTime: '2026-06-02 09:45:00',
    open: 10.1,
    high: 10.3,
    low: 10,
    close: 10.2,
    volume: 1200,
  },
  {
    date: '2026-06-02',
    tradeTime: '2026-06-02 09:50:00',
    open: 10.2,
    high: 10.4,
    low: 10.1,
    close: 10.3,
    volume: 1100,
  },
  {
    date: '2026-06-02',
    tradeTime: '2026-06-02 15:00:00',
    open: 10.3,
    high: 10.5,
    low: 10.2,
    close: 10.4,
    volume: 1000,
  },
]

test('完整未来行情不能改变同一历史时点的结算结果', () => {
  const batch = replayBatch()
  const event = expandHistoricalLedgerBatch(batch)[0]
  const evaluatedAt = Date.parse('2026-06-02T16:00:00+08:00')
  const futureBars = [{
    date: '2026-06-03',
    tradeTime: '2026-06-03 09:35:00',
    open: 8.8,
    high: 8.9,
    low: 8.5,
    close: 8.6,
    volume: 1000,
    preClose: 10.4,
  }]

  const prefix = settleHistoricalEvent({
    batch,
    event,
    bars: prefixBars,
    evaluatedAt,
  })
  const complete = settleHistoricalEvent({
    batch,
    event,
    bars: [...prefixBars, ...futureBars],
    evaluatedAt,
  })

  assert.deepEqual(complete, prefix)
  assert.equal(prefix.maturity, 'PENDING')
  assert.equal(prefix.outcome, 'OPEN_T1_LOCKED')
})

test('后续财报修订字段不会回写已冻结的历史特征', () => {
  const original = replayBatch()
  const revised = replayBatch({
    financialReport: {
      availableAt: Date.parse('2026-06-10T18:00:00+08:00'),
      netProfit: 9_999_999_999,
      revision: 2,
    },
  })

  assert.deepEqual(revised, original)
  assert.equal(
    Object.hasOwn(revised.events[0], 'financialReport'),
    false,
  )
})
