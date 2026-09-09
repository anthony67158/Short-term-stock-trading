import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHistoricalLedgerBatch,
  expandHistoricalLedgerBatch,
  mergeHistoricalOutcomes,
  settleHistoricalEvent,
} from '../scripts/lib/opportunity-history-backfill.mjs'

function decision(route, price) {
  return {
    action: 'WATCH_BUY',
    formulaId: 'UNKNOWN',
    playbookId: 'ACCUMULATION',
    playbookScore: 72,
    marketOpportunityFactor: 0.9,
    route,
    primaryPrice: price,
    priceType: route === 'PULLBACK'
      ? 'PULLBACK_WATCH'
      : 'IMMEDIATE',
    stopPrice: 9,
    targetPrice: 11,
    riskReward: 1,
    validUntil: Date.parse('2026-06-05T07:00:00+08:00'),
    timeStopTradingDays: 3,
    priceContractValid: true,
    marketAllowsRisk: true,
    executionState: 'PROBE',
  }
}

function batch() {
  const immediate = decision('IMMEDIATE', 10)
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
        cheapScore: 60,
        formulaEvaluations: [{
          formulaId: 'UNKNOWN',
          matched: false,
          score: 0,
        }],
        shadowFeatures: {},
        decision: immediate,
        counterfactualPlans: [
          immediate,
          decision('PULLBACK', 9.8),
        ],
        sector: null,
      }],
    },
  })
}

test('历史账本为每条反事实价格路径生成独立决策', () => {
  const value = batch()
  const events = expandHistoricalLedgerBatch(value)

  assert.equal(events.length, 2)
  assert.deepEqual(
    events.map((event) => event.decisionId),
    [
      'formula:2026-06-01:close:1510:600519:IMMEDIATE',
      'formula:2026-06-01:close:1510:600519:PULLBACK',
    ],
  )
})

test('历史结算复用生产费用和T加一结果合同', () => {
  const value = batch()
  const event = expandHistoricalLedgerBatch(value)[0]
  const outcome = settleHistoricalEvent({
    batch: value,
    event,
    evaluatedAt: Date.parse('2026-06-05T16:00:00+08:00'),
    bars: [
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
        tradeTime: '2026-06-02 15:00:00',
        open: 10.1,
        high: 10.5,
        low: 10,
        close: 10.4,
        volume: 1000,
      },
      {
        date: '2026-06-03',
        tradeTime: '2026-06-03 09:35:00',
        open: 11,
        high: 11.2,
        low: 10.8,
        close: 11.1,
        volume: 1000,
      },
    ],
  })

  assert.equal(outcome.maturity, 'MATURED')
  assert.equal(outcome.fillStatus, 'FILLED')
  assert.equal(outcome.scoreInput.schemaVersion, 'opportunity-score-feature.v3')
  assert.equal(outcome.route, 'IMMEDIATE')
  assert.equal(outcome.context.source, 'STOCKDB_CAUSAL_REPLAY')
  assert.equal(outcome.context.historicalBackfill, true)
})

test('历史样本合并按决策ID去重并保留最新值', () => {
  const first = {
    decisionId: 'a',
    tradeDate: '2026-06-01',
    maturity: 'MATURED',
    outcome: 'OLD',
  }
  const latest = { ...first, outcome: 'NEW' }
  const second = {
    decisionId: 'b',
    tradeDate: '2026-06-02',
    maturity: 'MATURED',
  }

  assert.deepEqual(
    mergeHistoricalOutcomes([first], { outcomes: [latest, second] }),
    [latest, second],
  )
})
