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
      mainTrend5: [0.2, 0.4, 0.8, 1, 1.2],
      retailTrend5: [-0.1, -0.2, -0.3, -0.4, -0.5],
      historyDayCount: 5,
      historyComplete: true,
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
  assert.equal(factors.fundCurrentAvailable, 1)
  assert.equal(factors.fundHistoryComplete, 1)
  assert.equal(factors.mainInflowDays5, 5)
  assert.equal(factors.retailInflowDays5, 0)
  assert.equal(factors.mainStreak5, 5)
  assert.equal(factors.retailStreak5, -5)
  assert.equal(factors.flowDivergenceBalance5, 5)
  assert.ok(factors.mainTrendSlope5 > 0)
  assert.ok(factors.retailTrendSlope5 < 0)
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
  assert.equal(factors.fundCurrentAvailable, 0)
  assert.equal(factors.fundHistoryAvailable, 0)
  assert.equal(factors.fundHistoryComplete, 0)
  assert.equal(factors.dailyTechnicalAvailable, 0)
  assert.equal(factors.intradayTechnicalAvailable, 0)
  assert.equal(factors.sectorContextAvailable, 0)
  assert.equal(factors.signalOrderFlowContinuation, 0)
})

test('单日资金与完整五日资金使用独立可用性标识', () => {
  const factors = buildOpportunityShadowFeatures({
    quote: { price: 10, preClose: 9.8 },
    candles: candles(),
    fund: {
      mainNetYi: 0,
      retailNetYi: 0,
      mainTrend5: [0],
      retailTrend5: [0],
      historyDayCount: 1,
      historyComplete: true,
    },
  })

  assert.equal(factors.mainNetYi, 0)
  assert.equal(factors.retailNetYi, 0)
  assert.equal(factors.fundCurrentAvailable, 1)
  assert.equal(factors.fundHistoryAvailable, 1)
  assert.equal(factors.fundHistoryDayCount, 1)
  assert.equal(factors.fundHistoryComplete, 0)
  assert.equal(factors.main5dYi, 0)
  assert.equal(factors.retail5dYi, 0)
})
