import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateAdaptiveOpportunity,
  rankAdaptiveOpportunities,
} from '../shared/adaptiveOpportunity.js'
import {
  buildMarketOpportunityContext,
} from '../shared/marketOpportunityContext.js'

const market = buildMarketOpportunityContext({
  marketGate: { regime: { score: 62 } },
  market: {
    breadth: { up: 2800, down: 1900, limitUp: 42, limitDown: 5 },
    sentiment: { breakRatePct: 21 },
  },
})

function candidate(overrides = {}) {
  return {
    code: '000001',
    name: '样本股票',
    state: 'AVOID',
    blockers: ['当前市场状态禁止新增风险', '未进入板块前瞻确认的主线方向'],
    quote: {
      price: 10,
      pct: 2.6,
      amount: 800_000_000,
      turnover: 4,
      volumeRatio: 1.6,
      mainRatio: 4,
    },
    fund: { mainNetYi: 1, retailNetYi: -0.2 },
    sector: { phase: 'STARTUP', actionability: 'LAYOUT', nextScore: 68 },
    stockRole: 'leader',
    entryPlan: { type: 'BREAKOUT', price: 10, trigger: '站稳10元' },
    exitPlan: { hardStopPrice: 9.7, takeProfitPrice: 10.6 },
    riskReward: 2,
    shadowFeatures: {
      orderImbalanceShort: 38,
      overheatReversalRisk: 16,
      liquidityComposite: 76,
      vwapDistancePct: 0.4,
    },
    ...overrides,
  }
}

test('market and sector objections become sizing cautions, not hard blockers', () => {
  const result = evaluateAdaptiveOpportunity(candidate(), market)

  assert.equal(result.hardBlockers.length, 0)
  assert.equal(result.cautions.length, 2)
  assert.equal(result.tier, 'PROBE')
  assert.ok(result.risk.riskPct > 0)
  assert.ok(result.risk.maxPositionPct > 0)
})

test('invalid execution prices remain a hard blocker', () => {
  const result = evaluateAdaptiveOpportunity(candidate({
    exitPlan: { hardStopPrice: 10.2, takeProfitPrice: 10.6 },
  }), market)

  assert.equal(result.tier, 'AVOID')
  assert.ok(result.hardBlockers.includes('买卖价格合同不完整'))
  assert.equal(result.risk.riskPct, 0)
})

test('calibrated negative expectation cannot be promoted by a strong playbook', () => {
  const result = evaluateAdaptiveOpportunity(candidate({
    blockers: [],
    opportunityScore: {
      state: 'READY',
      shadowOnly: false,
      productionEligible: true,
      outOfDistribution: false,
      pFill: 0.8,
      pWinGivenFill: 0.42,
      expectedNetR: -0.14,
      netRLowerBound: -0.42,
      calibration: { sampleCount: 500 },
    },
  }), market)

  assert.equal(result.tier, 'AVOID')
  assert.match(result.hardBlockers.join('；'), /费后期望/)
})

test('score for a different price route is not reused as calibrated evidence', () => {
  const result = evaluateAdaptiveOpportunity(candidate({
    blockers: [],
    opportunityScore: {
      state: 'READY',
      shadowOnly: false,
      productionEligible: true,
      outOfDistribution: false,
      pFill: 0.9,
      pWinGivenFill: 0.8,
      expectedNetR: 0.8,
      netRLowerBound: 0.4,
      calibration: { sampleCount: 800 },
      priceContract: {
        entryPrice: 12,
        stopPrice: 11,
        targetPrice: 14,
      },
    },
  }), market)

  assert.equal(result.estimate.source, 'RESEARCH_PRIOR')
  assert.equal(result.estimate.productionReady, false)
  assert.notEqual(result.tier, 'ATTACK')
})

test('ranking uses action value rather than source formula score', () => {
  const rows = rankAdaptiveOpportunities([
    candidate({
      code: '000001',
      score: 98,
      quote: {
        price: 10,
        pct: 8.8,
        amount: 800_000_000,
        turnover: 12,
        volumeRatio: 3.5,
        mainRatio: -2,
      },
      fund: { mainNetYi: -1, retailNetYi: 1 },
      shadowFeatures: {
        orderImbalanceShort: -30,
        overheatReversalRisk: 92,
        liquidityComposite: 76,
        vwapDistancePct: 4,
      },
    }),
    candidate({ code: '000002', score: 70 }),
  ], market)

  assert.equal(rows[0].code, '000002')
  assert.ok(rows[0].adaptive.utility > rows[1].adaptive.utility)
})
