import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TRAILING_EXIT_DEFAULTS,
  chandelierStop,
  peakHighSinceEntry,
  trailLockedProfit,
  trailingStopForHold,
} from '../shared/trailingExit.js'

test('chandelierStop 未创新高前保持初始硬止损', () => {
  // peak <= entry：不收紧，返回初始硬止损，避免刚进场被日内噪声洗出
  assert.equal(chandelierStop({ entryPrice: 10, initialStop: 9, peakHigh: 9.8 }), 9)
  assert.equal(chandelierStop({ entryPrice: 10, initialStop: 9, peakHigh: 10 }), 9)
})

test('chandelierStop 创新高后从峰值回吐 giveBackR 倍风险', () => {
  // risk = 1，giveBack 0.5 → 峰值 11.8 回吐 0.5 → 11.3
  assert.equal(chandelierStop({ entryPrice: 10, initialStop: 9, peakHigh: 11.8 }), 11.3)
  // 跟踪线绝不低于初始硬止损
  assert.equal(chandelierStop({ entryPrice: 10, initialStop: 9, peakHigh: 10.4 }), 9.9)
})

test('chandelierStop 非法入参回退到已知止损', () => {
  assert.equal(chandelierStop({ entryPrice: 0, initialStop: 9, peakHigh: 12 }), 9)
  assert.equal(chandelierStop({ entryPrice: 10, initialStop: 11, peakHigh: 12 }), 11)
})

test('peakHighSinceEntry 只统计入场当日及之后并合并当日盘中高', () => {
  const peak = peakHighSinceEntry({
    candles: [
      { date: '2026-08-01', high: 20 }, // 入场前，忽略
      { date: '2026-09-05', high: 11 },
    ],
    entryDayKey: '2026-09-01',
    quote: { high: 10.5 },
  })
  assert.equal(peak, 11)
})

test('peakHighSinceEntry 无有效数据返回 null', () => {
  assert.equal(peakHighSinceEntry({ candles: [], quote: {} }), null)
})

test('trailingStopForHold 强势上攻后把止损上移进盈利区', () => {
  const stop = trailingStopForHold({
    holdCost: 10,
    holdingStopPrice: 9,
    entryDayKey: '2026-09-01',
    candles: [{ date: '2026-09-02', high: 11.8 }],
    quote: { high: 11.5 },
  })
  assert.equal(stop, 11.3)
  assert.ok(trailLockedProfit({ entryPrice: 10, initialStop: 9, trailStop: stop }))
})

test('trailingStopForHold 未创新高时守住账本硬止损', () => {
  const stop = trailingStopForHold({
    holdCost: 10,
    holdingStopPrice: 9,
    candles: [{ date: '2026-09-02', high: 9.9 }],
    quote: { high: 9.8 },
  })
  assert.equal(stop, 9)
  assert.equal(trailLockedProfit({ entryPrice: 10, initialStop: 9, trailStop: stop }), false)
})

test('trailingStopForHold 采用价格计划里的 giveBackR，缺省回退默认值', () => {
  const custom = trailingStopForHold({
    holdCost: 10,
    holdingStopPrice: 9,
    candles: [{ date: '2026-09-02', high: 11.8 }],
    quote: {},
    trailingStop: { giveBackR: 0.3 },
  })
  // risk 1，giveBack 0.3 → 11.8-0.3=11.5
  assert.equal(custom, 11.5)

  const fallback = trailingStopForHold({
    holdCost: 10,
    holdingStopPrice: 9,
    candles: [{ date: '2026-09-02', high: 11.8 }],
    quote: {},
    trailingStop: { giveBackR: 'bad' },
  })
  assert.equal(
    fallback,
    +(11.8 - TRAILING_EXIT_DEFAULTS.giveBackR * 1).toFixed(6),
  )
})
