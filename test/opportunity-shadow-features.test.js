import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPPORTUNITY_SHADOW_FEATURE_NAMES,
  buildOpportunityShadowFeatures,
} from '../shared/opportunityShadowFeatures.js'

function candles() {
  return Array.from({ length: 24 }, (_, index) => {
    const close = 8.8 + index * 0.04
    return {
      open: close - 0.03,
      high: close + 0.08,
      low: close - 0.08,
      close,
    }
  })
}

test('影子特征只使用决策时点量价资金和板块证据', () => {
  const factors = buildOpportunityShadowFeatures({
    quote: {
      price: 10,
      preClose: 9.5,
      open: 9.6,
      high: 10.2,
      low: 9.4,
      pct: 5.26,
      amount: 600_000_000,
      turnover: 6,
      volumeRatio: 2,
      mainRatio: 10,
      limitUpPrice: 10.45,
    },
    candles: candles(),
    trends: Array.from({ length: 6 }, (_, index) => ({
      price: 9.8 + index * 0.04,
      avg: 9.76 + index * 0.03,
    })),
    fund: {
      mainNetYi: 1.2,
      retailNetYi: -0.5,
    },
    sectorOpportunity: {
      sector: {
        code: 'BK1000',
        name: '测试板块',
        pct: 1.1,
        rank: 2,
      },
    },
  })

  assert.deepEqual(
    Object.keys(factors),
    OPPORTUNITY_SHADOW_FEATURE_NAMES,
  )
  assert.equal(factors.flowDivergence, 1)
  assert.ok(factors.orderImbalanceShort >= 30)
  assert.equal(factors.signalOrderFlowContinuation, 1)
  assert.equal(factors.signalLiquidityConfirmed, 1)
  assert.equal(factors.signalSectorRelativeStrength, 1)
  assert.equal(factors.signalOverheatRisk, 0)
  assert.equal(factors.evidenceCompleteness, 1)
})

test('影子特征在证据缺失时使用有限中性值而不是NaN', () => {
  const factors = buildOpportunityShadowFeatures({
    quote: { price: 10 },
  })
  assert.equal(
    Object.values(factors).every(Number.isFinite),
    true,
  )
  assert.equal(factors.evidenceCompleteness, 0)
  assert.equal(factors.signalOrderFlowContinuation, 0)
})
