import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStrategyPatternAnalysis } from '../shared/strategyPatternFeatures.js'
import { buildAdaptivePricePlans } from '../shared/adaptivePricePlans.js'

function candles() {
  return Array.from({ length: 60 }, (_, i) => {
    const close = 10 + i * 0.02
    return {
      date: new Date(Date.UTC(2026, 5, i + 1)).toISOString().slice(0, 10),
      open: close - 0.02, close, high: close + 0.08,
      low: close - 0.08, volume: 1000,
    }
  })
}

test('missing bars and intraday volume cannot become measured zero-volume evidence', () => {
  assert.doesNotThrow(() => buildStrategyPatternAnalysis({ candles: [null, {}] }))
  const rows = candles()
  const quote = { ...rows.at(-1), price: rows.at(-1).close, tradeDate: rows.at(-1).date, volume: 10 }
  const missing = buildStrategyPatternAnalysis({ candles: rows, quote, mode: 'intraday' })
  assert.equal(missing.features.patternDailyVolumeRatio5, 0)
  assert.equal(missing.patterns.find((p) => p.id === 'SUPPORT_PULLBACK').matched, false)
  assert.ok(missing.patterns.every((p) => !p.evidence.some((s) => /量能0.0倍|NaN/.test(s))))
  const live = buildStrategyPatternAnalysis({ candles: rows, quote: { ...quote, volRatio: 1.7 }, mode: 'intraday' })
  assert.equal(live.features.patternDailyVolumeRatio5, 1.7)
})

test('as-of normalization rejects future bars and deduplicates compact dates', () => {
  const rows = candles()
  const last = rows.at(-1)
  const quote = { ...last, price: last.close, tradeDate: last.date }
  const reference = buildStrategyPatternAnalysis({ candles: rows, quote, mode: 'close' })
  const future = { date: '2026-09-11', open: 40, close: 40, high: 41, low: 39, volume: 2000 }
  const result = buildStrategyPatternAnalysis({
    candles: [...rows.map((r) => ({ ...r, date: r.date.replaceAll('-', '') })), future],
    quote, mode: 'close',
  })
  assert.deepEqual(result.features, reference.features)
})

test('a zero-volume session never qualifies as a support pullback', () => {
  const rows = candles()
  rows[59] = { ...rows[59], open: 11, close: 11, high: 11, low: 11, volume: 0 }
  const result = buildStrategyPatternAnalysis({ candles: rows, mode: 'close' })
  assert.equal(result.patterns.some((p) => p.matched), false)
})

test('research policy does not add MA20 as an execution anchor', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    open: i < 10 ? 10.6 : 9, close: i < 10 ? 10.6 : 9,
    high: i < 10 ? 10.7 : 9.1, low: i < 10 ? 10.5 : 8.9,
  }))
  const result = buildAdaptivePricePlans({
    candidate: {
      quote: { price: 10 }, technical: { atr: 1 },
      strategyPatternPolicy: 'RESEARCH',
    },
    candles: rows,
  })
  assert.equal(result.find((p) => p.route === 'PULLBACK').entryPlan.price, 9.55)
})
