import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAdaptivePricePlans,
  chooseAdaptivePricePlan,
} from '../shared/adaptivePricePlans.js'
import {
  buildMarketOpportunityContext,
} from '../shared/marketOpportunityContext.js'
import {
  scoreOpportunityPlaybooks,
} from '../shared/opportunityPlaybooks.js'

const marketContext = buildMarketOpportunityContext({
  marketGate: { regime: { score: 66 } },
  market: {
    breadth: { up: 3000, down: 1700, limitUp: 48, limitDown: 4 },
    sentiment: { breakRatePct: 18 },
  },
})

const candles = Array.from({ length: 20 }, (_, index) => ({
  high: 9.3 + index * 0.05,
  low: 9.05 + index * 0.045,
  close: 9.2 + index * 0.047,
}))

const candidate = {
  code: '000001',
  name: '样本股票',
  quote: {
    price: 10.1,
    high: 10.22,
    low: 9.88,
    limitUpPrice: 11,
    limitDownPrice: 9,
    pct: 2.4,
    amount: 700_000_000,
    turnover: 4,
    volumeRatio: 1.5,
    mainRatio: 3,
  },
  fund: { mainNetYi: 0.8, retailNetYi: -0.2 },
  sector: { phase: 'STARTUP', actionability: 'LAYOUT', nextScore: 70 },
  stockRole: 'leader',
  shadowFeatures: {
    orderImbalanceShort: 34,
    overheatReversalRisk: 18,
    liquidityComposite: 74,
    vwapDistancePct: 0.5,
  },
}

test('builds competing immediate, pullback and breakout plans', () => {
  const plans = buildAdaptivePricePlans({
    candidate,
    candles,
    trends: [{ price: 10.1, avg: 10.03 }],
    marketContext,
    now: 1_000,
  })

  assert.deepEqual(
    new Set(plans.map((item) => item.route)),
    new Set(['IMMEDIATE', 'PULLBACK', 'BREAKOUT']),
  )
  for (const plan of plans) {
    assert.ok(plan.exitPlan.hardStopPrice < plan.entryPlan.price)
    assert.ok(plan.exitPlan.takeProfitPrice > plan.entryPlan.price)
    assert.ok(plan.riskReward >= 1.15)
  }
})

test('selects the plan with the highest net action utility', () => {
  const decision = chooseAdaptivePricePlan({
    candidate,
    candles,
    trends: [{ price: 10.1, avg: 10.03 }],
    marketContext,
    now: 1_000,
  })

  assert.ok(decision.selected)
  assert.ok(decision.alternatives.length >= 1)
  assert.ok(
    decision.selected.adaptive.utility
      >= decision.alternatives[0].adaptive.utility,
  )
})

test('keeps multi-day targets above todays limit while entry remains legal', () => {
  const plans = buildAdaptivePricePlans({
    candidate: {
      ...candidate,
      quote: {
        ...candidate.quote,
        price: 10.95,
        high: 10.99,
      },
    },
    candles,
    marketContext,
  })

  assert.ok(plans.length >= 1)
  for (const plan of plans) {
    assert.ok(plan.entryPlan.price <= 11)
    assert.ok(plan.exitPlan.hardStopPrice >= 9)
  }
  assert.ok(plans.some((plan) => plan.exitPlan.takeProfitPrice > 11))
})

test('uses the strongest validated pattern in route confirmation text', () => {
  const plans = buildAdaptivePricePlans({
    candidate: {
      ...candidate,
      strategyPatternPolicy: 'ACTIVE',
      shadowFeatures: {
        ...candidate.shadowFeatures,
        patternHistoryCoverage: 1,
        patternSupportPullbackScore: 92,
        patternPlatformBreakoutScore: 20,
        patternVolumePriceSurgeScore: 30,
        patternLowerShadowReversalScore: 10,
        patternLowVolTrendScore: 70,
      },
    },
    candles,
    trends: [{ price: 10.1, avg: 10.03 }],
    marketContext,
  })
  const pullback = plans.find((item) => item.route === 'PULLBACK')

  assert.equal(pullback.patternContext.id, 'SUPPORT_PULLBACK')
  assert.match(pullback.entryPlan.trigger, /MA20|结构支撑/)
})

test('direct price anchors do not require playbook blending', () => {
  const directCapabilities = {
    schemaVersion: 'strategy-pattern-capabilities.v1',
    recall: true,
    priceAnchors: true,
    confirmation: true,
    display: true,
    playbookBlend: false,
    modelFeatures: false,
  }
  const patternedCandidate = {
    ...candidate,
    strategyPatternCapabilities: directCapabilities,
    shadowFeatures: {
      ...candidate.shadowFeatures,
      patternHistoryCoverage: 1,
      patternMa20DistancePct: 1,
      patternSupportPullbackScore: 92,
      patternPlatformBreakoutScore: 20,
      patternVolumePriceSurgeScore: 30,
      patternLowerShadowReversalScore: 10,
      patternLowVolTrendScore: 70,
    },
  }
  const baselinePlaybook = scoreOpportunityPlaybooks(candidate, marketContext)
  const directPlaybook = scoreOpportunityPlaybooks(
    patternedCandidate,
    marketContext,
  )
  const plans = buildAdaptivePricePlans({
    candidate: patternedCandidate,
    candles,
    trends: [{ price: 10.1, avg: 10.03 }],
    marketContext,
  })
  const pullback = plans.find((item) => item.route === 'PULLBACK')

  assert.equal(directPlaybook.selected.key, baselinePlaybook.selected.key)
  assert.equal(directPlaybook.selected.score, baselinePlaybook.selected.score)
  assert.equal(pullback.entryPlan.price, 10)
  assert.equal(pullback.patternContext.id, 'SUPPORT_PULLBACK')
  assert.equal(
    pullback.entryPlan.strategyPatternConfirmation.patternId,
    'SUPPORT_PULLBACK',
  )
  assert.match(
    pullback.entryPlan.strategyPatternConfirmation.summary,
    /分时低点抬高/,
  )
})
