import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeOpportunityScoreResponse,
  isExecutableOpportunityScore,
} from '../shared/opportunityScoreContract.js'
import { buildTradeExpectancy } from '../shared/tradeExpectancy.js'
import { deriveOpportunityLifecycle } from '../shared/opportunityLifecycle.js'

function model(overrides = {}) {
  return {
    schemaVersion: 'opportunity-score.v1',
    state: 'READY',
    code: '600001',
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    modelVersion: 'test-only',
    pFill: 0.6,
    pWinGivenFill: 0.6,
    expectedNetR: 0.3,
    netRLowerBound: -0.8,
    expectedShortfall10: -1.2,
    shadowOnly: false,
    productionEligible: true,
    calibration: { method: 'isotonic', sampleCount: 400 },
    ...overrides,
  }
}

function expectancy(score) {
  return buildTradeExpectancy({
    action: 'BUY',
    referencePrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    opportunityScore: {
      ...score,
      serverVerified: true,
      priceContract: { entryPrice: 10, stopPrice: 9, targetPrice: 12 },
    },
  })
}

test('研究标识经过服务端归一化后仍不能作为生产正期望', () => {
  const raw = model({ shadowOnly: true })
  const normalized = normalizeOpportunityScoreResponse(raw, raw)
  assert.equal(normalized.shadowOnly, true)
  assert.equal(normalized.productionEligible, false)
  assert.equal(isExecutableOpportunityScore(normalized), false)
  assert.equal(expectancy(normalized).state, 'PLAN_ONLY')
  assert.equal(expectancy(normalized).gate.allowsRiskIncrease, false)
})

test('未声明用途的外部评分不能默认成为生产模型', () => {
  const raw = model()
  delete raw.shadowOnly
  delete raw.productionEligible
  assert.equal(isExecutableOpportunityScore(
    normalizeOpportunityScoreResponse(raw, raw),
  ), false)
})

test('单次亏损尾部为负不等于均值期望为负', () => {
  const result = expectancy(model())
  assert.equal(result.gate.allowsRiskIncrease, true)
  assert.equal(result.expectancy.expectedNetRPerCandidate, 0.18)
  assert.equal(result.expectancy.lowerBoundKind, 'PREDICTION_P10')
  assert.equal(result.expectancy.meanConfidenceLowerBound, null)
  assert.equal(expectancy(model({ expectedNetR: 0 })).gate.allowsRiskIncrease, false)
})

test('减仓计划完成但仍有持仓必须继续管理', () => {
  const input = {
    holdQty: 2,
    sellableTodayQty: 2,
    executionPlan: { status: 'COMPLETED', side: 'SELL' },
  }
  assert.equal(deriveOpportunityLifecycle(input).stage, 'MANAGED')
  assert.equal(deriveOpportunityLifecycle(input).terminal, false)
  assert.equal(deriveOpportunityLifecycle({ ...input, holdQty: 0 }).stage, 'CLOSED')
})
