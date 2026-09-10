import test from 'node:test'
import assert from 'node:assert/strict'

import {
  scoreCandidatesWithDirectV3,
} from '../api/_opportunity_candidate_v3.js'

const NOW = Date.parse('2026-09-10T10:20:00+08:00')

function candidate(overrides = {}) {
  return {
    code: '600001',
    name: '测试股份',
    quote: {
      price: 10,
      pct: 1.2,
      amount: 300_000_000,
      turnover: 3,
      volumeRatio: 1.4,
      mainRatio: 2,
    },
    fund: {
      mainNetYi: 0.2,
      retailNetYi: -0.1,
    },
    sector: {
      code: 'BK001',
      name: '测试板块',
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
    },
    shadowFeatures: {
      evidenceCompleteness: 1,
      liquidityComposite: 70,
    },
    pricePlans: [{
      route: 'IMMEDIATE',
      entryPlan: {
        type: 'IMMEDIATE',
        price: 10,
        validUntil: NOW + 60_000,
      },
      exitPlan: {
        hardStopPrice: 9.7,
        takeProfitPrice: 10.8,
        timeStopTradingDays: 3,
      },
      riskReward: 2.67,
    }, {
      route: 'PULLBACK',
      entryPlan: {
        type: 'PULLBACK',
        price: 9.9,
        validUntil: NOW + 60_000,
      },
      exitPlan: {
        hardStopPrice: 9.6,
        takeProfitPrice: 10.6,
        timeStopTradingDays: 3,
      },
      riskReward: 2.33,
    }],
    ...overrides,
  }
}

function directScore(input, overrides = {}) {
  return {
    schemaVersion: 'opportunity-score.v1',
    state: 'READY',
    usagePolicy: 'DIRECT',
    modelVersion: 'v3-production',
    code: input.code,
    formulaId: input.formulaId,
    pFill: 0.7,
    pWinGivenFill: 0.6,
    expectedNetR: 0.3,
    netRLowerBound: 0.1,
    expectedShortfall10: -0.8,
    calibration: { sampleCount: 1000 },
    ...overrides,
  }
}

test('今日作战候选使用生产V3比较价格路径并保留同源分数', async () => {
  const calls = []
  const [result] = await scoreCandidatesWithDirectV3([candidate()], {
    now: NOW,
    mode: 'INTRADAY',
    marketGate: { allowed: true, riskTier: 'STANDARD' },
    scoreOpportunities: async (inputs) => {
      calls.push(inputs)
      return new Map(inputs.map((input) => [
        input.code,
        directScore(input, input.dimensions.route === 'PULLBACK'
          ? { pFill: 0.8, expectedNetR: 0.5, netRLowerBound: 0.2 }
          : {}),
      ]))
    },
  })

  assert.equal(calls.length, 2)
  assert.equal(result.entryPlan.type, 'PULLBACK')
  assert.equal(result.opportunityScore.usagePolicy, 'DIRECT')
  assert.equal(result.opportunityScore.modelVersion, 'v3-production')
  assert.equal(result.opportunityScore.priceContract.entryPrice, 9.9)
  assert.equal(result.adaptive.estimate.source, 'V3_DIRECT')
  assert.equal(result.v3Scoring.scoredRoutes, 2)
})

test('今日作战拒绝影子分数且不生成研究先验概率', async () => {
  const [result] = await scoreCandidatesWithDirectV3([candidate()], {
    now: NOW,
    mode: 'INTRADAY',
    marketGate: { allowed: true, riskTier: 'STANDARD' },
    scoreOpportunities: async (inputs) => new Map(inputs.map((input) => [
      input.code,
      directScore(input, {
        usagePolicy: 'QUALIFIED',
        shadowOnly: true,
      }),
    ])),
  })

  assert.equal(result.state, 'AVOID')
  assert.equal(result.adaptive.estimate.source, 'V3_UNAVAILABLE')
  assert.equal(result.adaptive.estimate.pWinGivenFill, null)
  assert.match(result.blockers.join('；'), /V3评分不可用/)
})
