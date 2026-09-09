import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMarketOpportunityContext,
} from '../shared/marketOpportunityContext.js'

test('strong broad market favors momentum without becoming a global gate', () => {
  const context = buildMarketOpportunityContext({
    market: {
      breadth: {
        up: 3600,
        down: 1200,
        flat: 200,
        limitUp: 72,
        limitDown: 3,
      },
      sentiment: { breakRatePct: 12 },
    },
    marketGate: { regime: { score: 76 } },
  })

  assert.equal(context.phase, 'TREND_EXPANSION')
  assert.ok(context.playbookWeights.MOMENTUM_BREAKOUT > 1)
  assert.ok(context.opportunityFactor > 1)
  assert.equal(context.hardRisk, false)
})

test('weak market switches playbook instead of disabling every opportunity', () => {
  const context = buildMarketOpportunityContext({
    market: {
      breadth: {
        up: 900,
        down: 3900,
        limitUp: 18,
        limitDown: 24,
      },
      sentiment: { breakRatePct: 42 },
    },
    marketGate: { regime: { score: 34 } },
  })

  assert.equal(context.phase, 'RETREAT')
  assert.ok(context.playbookWeights.PANIC_REVERSAL > 1)
  assert.ok(context.playbookWeights.MOMENTUM_BREAKOUT < 1)
  assert.ok(context.baseRiskPct > 0)
  assert.equal(context.hardRisk, false)
})

test('hard market risk reduces budget but keeps strategy context available', () => {
  const context = buildMarketOpportunityContext({
    marketGate: {
      regime: {
        score: 28,
        hardRiskOff: true,
        hardRiskSignals: ['跌停扩散'],
      },
    },
  })

  assert.equal(context.phase, 'PANIC')
  assert.equal(context.hardRisk, true)
  assert.deepEqual(context.hardRiskSignals, ['跌停扩散'])
  assert.ok(context.opportunityFactor >= 0.35)
})
