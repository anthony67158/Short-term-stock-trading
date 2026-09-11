import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  OPPORTUNITY_SCORE_FEATURE_NAMES,
  OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION,
  OPPORTUNITY_SCORE_SCHEMA_VERSION,
  buildOpportunityScoreInput,
  isOpportunityScoreInput,
  isExecutableOpportunityScore,
  normalizeOpportunityScoreResponse,
  unavailableOpportunityScore,
} from '../shared/opportunityScoreContract.js'

const contractManifest = JSON.parse(readFileSync(
  new URL(
    '../qlib-service/contracts/opportunity-score-features.json',
    import.meta.url,
  ),
  'utf8',
))

function event(overrides = {}) {
  return {
    decisionId: 'formula:2026-09-02:intraday:0600:600001',
    asOf: 1_788_320_000_000,
    code: '600001',
    name: '测试股份',
    mode: 'INTRADAY',
    stageReached: 'DISPLAYED',
    displayedRank: 1,
    cheapScore: 42,
    quote: {
      price: 10.2,
      pct: 2.5,
      amount: 600_000_000,
      turnover: 4.2,
      volumeRatio: 1.6,
      mainRatio: 8.5,
    },
    formulaEvaluations: [{
      formulaId: 'INTRADAY_VWAP_PULLBACK',
      score: 88,
    }],
    shadowFeatures: {
      ret2dPct: 3.2,
      fundCurrentAvailable: 1,
      fundHistoryAvailable: 1,
      fundHistoryDayCount: 5,
      fundHistoryComplete: 1,
      main5dYi: 2.4,
      retail5dYi: -1.1,
      mainStreak5: 3,
      retailStreak5: -2,
      sectorMainNetYi: 1.2,
      sectorBreadthPct: 63,
      sectorMemberCount: 42,
      sectorFlowRankPct: 0.9,
      orderImbalanceShort: 46,
      overheatReversalRisk: 18,
      liquidityComposite: 72,
      signalOrderFlowContinuation: 1,
      signalLiquidityConfirmed: 1,
      dailyTechnicalAvailable: 1,
      intradayTechnicalAvailable: 1,
      sectorContextAvailable: 1,
    },
    recall: {
      primarySource: 'ACCUMULATION',
      sources: ['ACCUMULATION', 'LIQUIDITY'],
      momentumPct: 0.62,
      accumulationPct: 0.94,
      reversalPct: 0.18,
      liquidityPct: 0.88,
      cheapScorePct: 0.81,
      exploration: false,
    },
    decision: {
      formulaId: 'INTRADAY_VWAP_PULLBACK',
      priceType: 'PULLBACK_WATCH',
      primaryPrice: 10,
      stopPrice: 9.6,
      targetPrice: 10.9,
      riskReward: 2.25,
      priceContractValid: true,
    },
    sector: {
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
    },
    outcome: {
      netR: 99,
    },
    ...overrides,
  }
}

function batch(overrides = {}) {
  return {
    mode: 'INTRADAY',
    slot: '0600',
    marketGate: {
      allowed: true,
      riskTier: 'STANDARD',
    },
    ...overrides,
  }
}

test('机会评分特征只使用决策时点数据并保持固定顺序', () => {
  const input = buildOpportunityScoreInput({
    event: event(),
    batch: batch(),
  })

  assert.equal(
    input.schemaVersion,
    OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION,
  )
  assert.equal(
    input.inputContextVersion,
    'opportunity-score-input-context.v3',
  )
  assert.equal(input.code, '600001')
  assert.equal(input.formulaId, 'INTRADAY_VWAP_PULLBACK')
  assert.deepEqual(
    Object.keys(input.factors),
    OPPORTUNITY_SCORE_FEATURE_NAMES,
  )
  assert.equal(input.factors.cheapScore, 42)
  assert.equal(input.factors.formulaScore, 88)
  assert.equal(input.factors.marketAllowed, 1)
  assert.equal(input.factors.recallAccumulationPct, 0.94)
  assert.equal(input.factors.recallSourceCount, 2)
  assert.equal(input.factors.explorationSample, 0)
  assert.equal(input.factors.ret2dPct, 3.2)
  assert.equal(input.factors.fundHistoryDayCount, 5)
  assert.equal(input.factors.main5dYi, 2.4)
  assert.equal(input.factors.retailStreak5, -2)
  assert.equal(input.factors.orderImbalanceShort, 46)
  assert.equal(input.factors.signalOrderFlowContinuation, 1)
  assert.equal(input.factors.signalLiquidityConfirmed, 1)
  assert.equal('displayed' in input.factors, false)
  assert.equal(input.factors.entryDistancePct, -1.961)
  assert.equal(input.factors.stopDistancePct, 4)
  assert.equal(input.factors.targetDistancePct, 9)
  assert.equal(input.factors.formula_INTRADAY_VWAP_PULLBACK, 1)
  assert.equal(input.factors.market_STANDARD, 1)
  assert.equal(input.factors.sector_ACCUMULATION, 1)
  assert.equal(input.factors.recall_ACCUMULATION, 1)
  assert.equal(input.factors.time_INTRADAY_OPEN, 1)
  assert.equal(input.factors.liquidity_HIGH, 1)
  assert.equal('netR' in input.factors, false)
  assert.equal(isOpportunityScoreInput(input), true)
  assert.equal(isOpportunityScoreInput({
    ...input,
    factors: {
      ...input.factors,
      futureReturn: 9,
    },
  }), false)
})

test('未知公式保留最高接近度而不是把公式分清零', () => {
  const input = buildOpportunityScoreInput({
    event: event({
      formulaEvaluations: [
        { formulaId: 'INTRADAY_VWAP_PULLBACK', score: 40 },
        { formulaId: 'INTRADAY_ACCUMULATION', score: 64 },
      ],
      decision: {
        ...event().decision,
        formulaId: 'UNKNOWN',
      },
    }),
    batch: batch(),
  })

  assert.equal(input.factors.formulaScore, 64)
})

test('未经过市场召回的单股评估按探索样本编码', () => {
  const source = event()
  delete source.recall
  const input = buildOpportunityScoreInput({
    event: source,
    batch: batch({ mode: 'CLOSE', slot: 'manual' }),
  })

  assert.equal(input.dimensions.recallSource, 'EXPLORATION')
  assert.equal(input.factors.recall_EXPLORATION, 1)
  assert.equal(input.factors.recall_UNKNOWN, 0)
  assert.equal(input.factors.recallSourceCount, 1)
  assert.equal(input.factors.explorationSample, 1)
})

test('前后端机会评分特征清单与版本保持一致', () => {
  assert.equal(
    contractManifest.featureSchemaVersion,
    OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION,
  )
  assert.equal(
    contractManifest.scoreSchemaVersion,
    OPPORTUNITY_SCORE_SCHEMA_VERSION,
  )
  assert.deepEqual(
    contractManifest.featureNames,
    OPPORTUNITY_SCORE_FEATURE_NAMES,
  )
})

test('未知类别落入显式UNKNOWN特征而不是静默映射到其它类别', () => {
  const input = buildOpportunityScoreInput({
    event: event({
      mode: 'OTHER',
      formulaEvaluations: [],
      decision: {
        ...event().decision,
        formulaId: 'NEW_FORMULA',
        priceType: 'OTHER',
      },
      sector: {
        phase: 'OTHER',
        actionability: 'OTHER',
      },
    }),
    batch: batch({
      mode: 'OTHER',
      slot: 'manual',
      marketGate: null,
    }),
  })

  assert.equal(input.factors.formula_UNKNOWN, 1)
  assert.equal(input.factors.mode_UNKNOWN, 1)
  assert.equal(input.factors.priceType_UNKNOWN, 1)
  assert.equal(input.factors.market_UNKNOWN, 1)
  assert.equal(input.factors.sector_UNKNOWN, 1)
  assert.equal(input.factors.sectorAction_UNKNOWN, 1)
  assert.equal(input.factors.time_INTRADAY_MANUAL, 1)
})

test('模型未就绪和分布外结果必须保持概率为空', () => {
  const fallback = unavailableOpportunityScore({
    code: '600001',
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    asOf: 1_788_320_000_000,
  }, 'MODEL_NOT_READY')
  const outOfDistribution = normalizeOpportunityScoreResponse({
    schemaVersion: OPPORTUNITY_SCORE_SCHEMA_VERSION,
    state: 'OUT_OF_DISTRIBUTION',
    modelVersion: 'opportunity-score.v1',
    code: '600001',
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    pFill: 0.9,
    pWinGivenFill: 0.8,
    expectedNetR: 0.5,
    netRLowerBound: 0.1,
    expectedShortfall10: -0.8,
    calibration: {
      method: 'isotonic',
      sampleCount: 100,
      bucket: 'STANDARD:ACCUMULATION:INTRADAY_OPEN',
    },
    outOfDistribution: true,
  }, {
    code: '600001',
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    asOf: 1_788_320_000_000,
  })

  assert.equal(fallback.state, 'NOT_READY')
  assert.equal(fallback.pFill, null)
  assert.equal(outOfDistribution.state, 'OUT_OF_DISTRIBUTION')
  assert.equal(outOfDistribution.pWinGivenFill, null)
  assert.equal(outOfDistribution.expectedNetR, null)
})

test('直接使用响应保留分布外预测和真实晋级记录', () => {
  const expected = { code: '600001', formulaId: 'UNKNOWN', asOf: 1788320000000 }
  const result = normalizeOpportunityScoreResponse({
    ...expected, schemaVersion: OPPORTUNITY_SCORE_SCHEMA_VERSION,
    state: 'READY', modelVersion: 'opportunity-score.direct',
    usagePolicy: 'DIRECT', shadowOnly: true, productionEligible: false,
    outOfDistribution: true, pFill: 0.7, pWinGivenFill: 0.6,
    expectedNetR: 0.2, netRLowerBound: -0.2, expectedShortfall10: -1.1,
  }, expected)
  assert.equal(result.state, 'READY')
  assert.equal(result.productionEligible, false)
  assert.equal(result.pFill, 0.7)
  assert.equal(isExecutableOpportunityScore(result), true)
  assert.throws(() => normalizeOpportunityScoreResponse({
    ...result, pFill: 1.2,
  }, expected), /概率无效/)
})

test('就绪评分验证代码、概率范围和完整数值合同', () => {
  const result = normalizeOpportunityScoreResponse({
    schemaVersion: OPPORTUNITY_SCORE_SCHEMA_VERSION,
    state: 'READY',
    modelVersion: 'opportunity-score.20260902',
    code: '600001',
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    pFill: 0.74,
    pWinGivenFill: 0.61,
    expectedNetR: 0.18,
    netRLowerBound: 0.03,
    rankingScore: 0.87,
    expectedShortfall10: -1.12,
    calibration: {
      method: 'isotonic',
      sampleCount: 426,
      bucket: 'STANDARD:ACCUMULATION:INTRADAY_OPEN',
    },
    outOfDistribution: false,
  }, {
    code: '600001',
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    asOf: 1_788_320_000_000,
  })

  assert.equal(result.state, 'READY')
  assert.equal(result.pFill, 0.74)
  assert.equal(result.rankingScore, 0.87)
  assert.equal(result.calibration.sampleCount, 426)
  assert.throws(() => normalizeOpportunityScoreResponse({
    ...result,
    pFill: 1.2,
  }, result), /评分概率无效/)
  assert.throws(() => normalizeOpportunityScoreResponse({
    ...result,
    code: '600002',
  }, result), /评分股票不匹配/)
  assert.throws(() => normalizeOpportunityScoreResponse({
    ...result,
    modelVersion: '',
  }, result), /模型版本无效/)
})
