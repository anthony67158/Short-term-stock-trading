import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  OPPORTUNITY_SCORE_FEATURE_NAMES,
  OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION,
  OPPORTUNITY_SCORE_SCHEMA_VERSION,
  buildOpportunityScoreInput,
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
  assert.equal(input.code, '600001')
  assert.equal(input.formulaId, 'INTRADAY_VWAP_PULLBACK')
  assert.deepEqual(
    Object.keys(input.factors),
    OPPORTUNITY_SCORE_FEATURE_NAMES,
  )
  assert.equal(input.factors.cheapScore, 42)
  assert.equal(input.factors.formulaScore, 88)
  assert.equal(input.factors.marketAllowed, 1)
  assert.equal(input.factors.displayed, 1)
  assert.equal(input.factors.entryDistancePct, -1.961)
  assert.equal(input.factors.stopDistancePct, 4)
  assert.equal(input.factors.targetDistancePct, 9)
  assert.equal(input.factors.formula_INTRADAY_VWAP_PULLBACK, 1)
  assert.equal(input.factors.market_STANDARD, 1)
  assert.equal(input.factors.sector_ACCUMULATION, 1)
  assert.equal(input.factors.time_INTRADAY_OPEN, 1)
  assert.equal(input.factors.liquidity_HIGH, 1)
  assert.equal('netR' in input.factors, false)
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
  assert.equal(result.calibration.sampleCount, 426)
  assert.throws(() => normalizeOpportunityScoreResponse({
    ...result,
    pFill: 1.2,
  }, result), /评分概率无效/)
  assert.throws(() => normalizeOpportunityScoreResponse({
    ...result,
    code: '600002',
  }, result), /评分股票不匹配/)
})
