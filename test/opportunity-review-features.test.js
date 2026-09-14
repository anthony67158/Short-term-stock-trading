import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildOpportunityReviewFeatureInput,
  buildOpportunityReviewFeatureInputV2,
  OPPORTUNITY_REVIEW_FEATURE_NAMES,
  OPPORTUNITY_REVIEW_FEATURE_SCHEMA_VERSION,
  OPPORTUNITY_REVIEW_V2_FEATURE_NAMES,
  OPPORTUNITY_REVIEW_V2_FEATURE_SCHEMA_VERSION,
} from '../shared/opportunityReviewFeatures.js'


test('触发后复核特征只读取观察窗口路径', () => {
  const value = buildOpportunityReviewFeatureInput({
    code: '600001',
    asOf: 1_788_320_060_000,
    triggerPrice: 10,
    direction: 'BREAKOUT',
    initialScore: {
      pFill: 0.6,
      pWinGivenFill: 0.55,
      expectedNetR: 0.2,
    },
    rows: [
      { price: 9.95, high: 10.02, low: 9.9, volume: 100, avg: 10 },
      { price: 10.1, high: 10.15, low: 9.98, volume: 180, avg: 10.02 },
      { price: 10.2, high: 10.25, low: 10.08, volume: 200, avg: 10.05 },
    ],
  })

  assert.equal(
    value.schemaVersion,
    OPPORTUNITY_REVIEW_FEATURE_SCHEMA_VERSION,
  )
  assert.deepEqual(
    Object.keys(value.factors),
    OPPORTUNITY_REVIEW_FEATURE_NAMES,
  )
  assert.equal(value.factors.observationBars, 3)
  assert.equal(value.factors.changeFromTriggerPct, 2)
  assert.equal(value.factors.reclaimedVwap, 1)
  assert.equal(value.factors.heldAboveVwap, 1)
  assert.equal(value.factors.direction_BREAKOUT, 1)
})

test('复核特征合同与Python清单一致', () => {
  const manifest = JSON.parse(readFileSync(
    new URL(
      '../qlib-service/contracts/opportunity-review-features.json',
      import.meta.url,
    ),
    'utf8',
  ))

  assert.equal(
    manifest.featureSchemaVersion,
    OPPORTUNITY_REVIEW_FEATURE_SCHEMA_VERSION,
  )
  assert.deepEqual(manifest.featureNames, OPPORTUNITY_REVIEW_FEATURE_NAMES)
})

test('复核V2把价格风险与交易规则纳入模型输入', () => {
  const value = buildOpportunityReviewFeatureInputV2({
    code: '600001',
    asOf: 1_788_320_060_000,
    triggerPrice: 10,
    direction: 'BREAKOUT',
    priceContract: {
      entryPrice: 10.2,
      stopPrice: 9.8,
      feeRateBps: 6.1,
      slippageBps: 5,
      lotSize: 100,
      tPlusOne: true,
    },
    initialScore: {
      pFill: 0,
      pWinGivenFill: 0,
      expectedNetR: 0,
    },
    rows: [
      { price: 10.1, high: 10.15, low: 10.02, volume: 100, vwap: 10.08 },
      { price: 10.2, high: 10.25, low: 10.08, volume: 200, vwap: 10.12 },
    ],
  })

  assert.equal(value.schemaVersion, OPPORTUNITY_REVIEW_V2_FEATURE_SCHEMA_VERSION)
  assert.deepEqual(Object.keys(value.factors), OPPORTUNITY_REVIEW_V2_FEATURE_NAMES)
  assert.equal(value.factors.entryPrice, 10.2)
  assert.equal(value.factors.stopPrice, 9.8)
  assert.equal(value.factors.priceRiskPerShare, 0.4)
  assert.equal(value.factors.stopDistancePct, 3.921569)
  assert.equal(value.factors.feeRateBps, 6.1)
  assert.equal(value.factors.slippageBps, 5)
  assert.equal(value.factors.lotSize, 100)
  assert.equal(value.factors.tPlusOne, 1)
})

test('复核V2用缺失掩码区分未知值与真实零', () => {
  const base = {
    code: '600001',
    asOf: 1_788_320_060_000,
    triggerPrice: 10,
    direction: 'PULLBACK',
    priceContract: {
      entryPrice: 10,
      stopPrice: 9.5,
      feeRateBps: 0,
      slippageBps: 0,
      lotSize: 100,
      tPlusOne: false,
    },
    rows: [
      { price: 10, high: 10.1, low: 9.9 },
      { price: 10, high: 10.1, low: 9.9 },
    ],
  }
  const missing = buildOpportunityReviewFeatureInputV2(base)
  const zero = buildOpportunityReviewFeatureInputV2({
    ...base,
    initialScore: {
      pFill: 0,
      pWinGivenFill: 0,
      expectedNetR: 0,
    },
  })

  assert.equal(missing.factors.volumeContinuationMissing, 1)
  assert.equal(missing.factors.vwapMissing, 1)
  assert.equal(missing.factors.initialPFillMissing, 1)
  assert.equal(missing.factors.initialPWinGivenFillMissing, 1)
  assert.equal(missing.factors.initialExpectedNetRMissing, 1)
  assert.equal(zero.factors.initialPFill, 0)
  assert.equal(zero.factors.initialPFillMissing, 0)
  assert.equal(zero.factors.initialPWinGivenFillMissing, 0)
  assert.equal(zero.factors.initialExpectedNetRMissing, 0)
})

test('复核V2关键价格风险无效时失败关闭', () => {
  const base = {
    code: '600001',
    asOf: 1_788_320_060_000,
    triggerPrice: 10,
    rows: [{ price: 10, high: 10.1, low: 9.9 }],
  }
  assert.equal(buildOpportunityReviewFeatureInputV2(base), null)
  assert.equal(buildOpportunityReviewFeatureInputV2({
    ...base,
    priceContract: {
      entryPrice: 10,
      stopPrice: 10,
      feeRateBps: 6.1,
      slippageBps: 5,
      lotSize: 100,
      tPlusOne: true,
    },
  }), null)
})

test('复核V2 JSON合同与JS清单一致', () => {
  const manifest = JSON.parse(readFileSync(
    new URL(
      '../qlib-service/contracts/opportunity-review-features-v2.json',
      import.meta.url,
    ),
    'utf8',
  ))

  assert.equal(
    manifest.featureSchemaVersion,
    OPPORTUNITY_REVIEW_V2_FEATURE_SCHEMA_VERSION,
  )
  assert.deepEqual(manifest.featureNames, OPPORTUNITY_REVIEW_V2_FEATURE_NAMES)
})
