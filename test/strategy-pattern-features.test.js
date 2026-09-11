import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STRATEGY_PATTERN_FEATURE_NAMES,
  buildStrategyPatternAnalysis,
} from '../shared/strategyPatternFeatures.js'

function bar(index, overrides = {}) {
  const close = 10 + index * 0.02
  return {
    date: `2026-06-${String(index + 1).padStart(2, '0')}`,
    open: close - 0.02,
    high: close + 0.08,
    low: close - 0.08,
    close,
    volume: 1_000,
    ...overrides,
  }
}

test('strategy pattern features stay finite when history is missing', () => {
  const analysis = buildStrategyPatternAnalysis({
    quote: { price: 10 },
  })

  assert.deepEqual(
    Object.keys(analysis.features),
    STRATEGY_PATTERN_FEATURE_NAMES,
  )
  assert.equal(
    Object.values(analysis.features).every(Number.isFinite),
    true,
  )
  assert.equal(analysis.features.patternHistoryCoverage, 0)
})

test('detects a compressed platform with a confirmed volume breakout', () => {
  const candles = Array.from({ length: 11 }, (_, index) =>
    bar(index, {
      open: 10,
      high: 10.1,
      low: 9.9,
      close: 10,
    })
  )
  const analysis = buildStrategyPatternAnalysis({
    candles,
    quote: {
      tradeDate: '2026-07-01',
      open: 10.02,
      high: 10.25,
      low: 10,
      price: 10.2,
      volume: 2_000,
    },
    mode: 'close',
  })

  assert.ok(analysis.features.patternPlatformRange10Pct < 3)
  assert.ok(analysis.features.patternBreakoutDistance10Pct > 0)
  assert.equal(analysis.strongest.id, 'PLATFORM_BREAKOUT')
  assert.ok(analysis.strongest.score >= 90)
})

test('detects volume-price confirmation on an MA20 cross', () => {
  const candles = Array.from({ length: 20 }, (_, index) =>
    bar(index, {
      open: 9.98,
      high: 10.05,
      low: 9.85,
      close: index === 19 ? 9.9 : 10,
    })
  )
  const analysis = buildStrategyPatternAnalysis({
    candles,
    quote: {
      tradeDate: '2026-07-01',
      open: 9.95,
      high: 10.6,
      low: 9.92,
      price: 10.5,
      volumeRatio: 2.5,
      volume: 100,
    },
    mode: 'intraday',
  })

  assert.equal(analysis.features.patternMa20CrossUp, 1)
  assert.equal(analysis.features.patternDailyVolumeRatio5, 2.5)
  assert.ok(analysis.features.patternVolumePriceSurgeScore >= 90)
})

test('detects support pullback and low-volatility trend structure', () => {
  const candles = Array.from({ length: 60 }, (_, index) =>
    bar(index, {
      close: 9.5 + index * 0.02,
      open: 9.49 + index * 0.02,
      high: 9.54 + index * 0.02,
      low: 9.46 + index * 0.02,
      volume: 1_000,
    })
  )
  const current = candles.at(-1)
  candles[candles.length - 1] = {
    ...current,
    volume: 600,
  }
  const analysis = buildStrategyPatternAnalysis({
    candles,
    mode: 'close',
  })

  assert.equal(analysis.features.patternHistoryCoverage, 1)
  assert.ok(analysis.features.patternMomentum20Pct > 0)
  assert.ok(analysis.features.patternAnnualVol20Pct < 30)
  assert.ok(analysis.features.patternSupportPullbackScore >= 70)
  assert.ok(analysis.features.patternLowVolTrendScore >= 70)
})

test('detects a long lower shadow after a five-day decline', () => {
  const candles = Array.from({ length: 20 }, (_, index) =>
    bar(index, {
      close: index < 14 ? 12 : 12 - (index - 13) * 0.3,
      open: index < 14 ? 12 : 12.05 - (index - 13) * 0.3,
      high: index < 14 ? 12.1 : 12.1 - (index - 13) * 0.3,
      low: index < 14 ? 11.9 : 11.8 - (index - 13) * 0.3,
    })
  )
  const analysis = buildStrategyPatternAnalysis({
    candles,
    quote: {
      tradeDate: '2026-07-01',
      open: 10,
      high: 10.25,
      low: 9.35,
      price: 10.15,
      volume: 1_500,
    },
    mode: 'close',
  })

  assert.ok(analysis.features.patternLowerShadowPct >= 5)
  assert.ok(analysis.features.patternCloseLocationPct >= 80)
  assert.ok(analysis.features.patternLowerShadowReversalScore >= 70)
})

test('intraday pattern volume uses the as-of quote ratio', () => {
  const candles = Array.from({ length: 21 }, (_, index) => bar(index))
  const analysis = buildStrategyPatternAnalysis({
    candles,
    quote: {
      tradeDate: '2026-07-01',
      open: 10.4,
      high: 10.6,
      low: 10.3,
      price: 10.5,
      volume: 10,
      volumeRatio: 1.7,
    },
    mode: 'intraday',
  })

  assert.equal(analysis.features.patternDailyVolumeRatio5, 1.7)
})
