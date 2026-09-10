import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildOpportunityReviewFeatureInput,
  OPPORTUNITY_REVIEW_FEATURE_NAMES,
  OPPORTUNITY_REVIEW_FEATURE_SCHEMA_VERSION,
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
