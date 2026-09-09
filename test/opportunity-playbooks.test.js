import test from 'node:test'
import assert from 'node:assert/strict'

import {
  scoreOpportunityPlaybooks,
} from '../shared/opportunityPlaybooks.js'
import {
  buildMarketOpportunityContext,
} from '../shared/marketOpportunityContext.js'

function candidate(overrides = {}) {
  return {
    code: '000001',
    name: '样本股票',
    quote: {
      price: 10,
      pct: 3.8,
      amount: 900_000_000,
      turnover: 5,
      volumeRatio: 1.8,
      mainRatio: 4,
    },
    fund: { mainNetYi: 1.2, retailNetYi: -0.4 },
    sector: {
      phase: 'STARTUP',
      actionability: 'LAYOUT',
      nextScore: 72,
    },
    stockRole: 'leader',
    shadowFeatures: {
      orderImbalanceShort: 42,
      overheatReversalRisk: 20,
      liquidityComposite: 78,
      vwapDistancePct: 0.6,
    },
    ...overrides,
  }
}

test('strong market ranks momentum for a liquid leading stock', () => {
  const market = buildMarketOpportunityContext({
    marketGate: { regime: { score: 76 } },
    market: {
      breadth: { up: 3500, down: 1200, limitUp: 68, limitDown: 2 },
      sentiment: { breakRatePct: 14 },
    },
  })
  const result = scoreOpportunityPlaybooks(candidate(), market)

  assert.equal(result.selected.key, 'MOMENTUM_BREAKOUT')
  assert.ok(result.selected.score >= 70)
  assert.equal(result.alternatives.length, 2)
})

test('rotation market favors accumulation for a quiet inflow candidate', () => {
  const market = buildMarketOpportunityContext({
    marketGate: { regime: { score: 52 } },
    market: {
      breadth: { up: 2450, down: 2350, limitUp: 31, limitDown: 7 },
      sentiment: { breakRatePct: 24 },
    },
  })
  const result = scoreOpportunityPlaybooks(candidate({
    quote: {
      price: 10,
      pct: 0.4,
      amount: 600_000_000,
      turnover: 3.5,
      volumeRatio: 1.1,
      mainRatio: 5,
    },
    stockRole: 'front_row',
    shadowFeatures: {
      orderImbalanceShort: 22,
      overheatReversalRisk: 4,
      liquidityComposite: 70,
      vwapDistancePct: 0.1,
    },
  }), market)

  assert.equal(result.selected.key, 'ACCUMULATION')
})

test('official under-reaction candidate keeps catalyst route in weak market', () => {
  const market = buildMarketOpportunityContext({
    marketGate: { regime: { score: 38 } },
    market: {
      breadth: { up: 1200, down: 3300, limitUp: 18, limitDown: 19 },
      sentiment: { breakRatePct: 38 },
    },
  })
  const result = scoreOpportunityPlaybooks(candidate({
    origin: 'PRE_CATALYST',
    activationScore: 86,
    underReactionScore: 82,
    quote: {
      price: 10,
      pct: 0.2,
      amount: 420_000_000,
      turnover: 2.4,
      volumeRatio: 1,
      mainRatio: 2,
    },
    stockRole: 'unknown',
  }), market)

  assert.equal(result.selected.key, 'CATALYST')
  assert.ok(result.selected.score > 70)
})
