import test from 'node:test'
import assert from 'node:assert/strict'

import {
  vwapSeries,
  sliceSession,
  intradayFeatures,
} from '../shared/backtest/intradaySignals.js'

// 构造一段升序5分钟线：早盘高开冲高后回落。
function day({ strong = true } = {}) {
  const rows = []
  const times = ['0935', '0940', '0945', '0950', '0955', '1000', '1030', '1130', '1330', '1430', '1500']
  let base = strong ? 11.2 : 10.4
  for (const t of times) {
    // 强势：早盘一路在均价上；弱势：早盘就破位
    const px = strong ? base + 0.1 : base - 0.1
    rows.push({ time: t, open: base, high: px + 0.05, low: base - 0.08, close: px, vol: 10000, amount: px * 10000 * 100 })
    base = strong ? base + 0.03 : base - 0.05
  }
  return rows
}

test('vwapSeries 累计成交额/成交量，量纲为元/股', () => {
  const s = vwapSeries([
    { time: '0935', close: 10, vol: 100, amount: 10 * 100 * 100 },
    { time: '0940', close: 12, vol: 100, amount: 12 * 100 * 100 },
  ])
  assert.equal(s[0].vwap, 10)
  assert.equal(s[1].vwap, 11) // (10+12)/2
})

test('sliceSession 按HHMM时段切片', () => {
  const early = sliceSession(day(), '0935', '1000')
  assert.ok(early.every((b) => b.time <= '1000'))
  assert.ok(early.length >= 5)
})

test('强势日：早盘站稳VWAP、收在均价上、回撤小', () => {
  const f = intradayFeatures(day({ strong: true }), { prevClose: 10.5 })
  assert.equal(f.available, true)
  assert.equal(f.heldVwapEarly, true)
  assert.ok(f.openGapPct > 0)
  assert.ok(f.closeVsVwapPct >= 0)
})

test('弱势日：早盘破VWAP占比高、不算站稳', () => {
  const f = intradayFeatures(day({ strong: false }), { prevClose: 10.5 })
  assert.equal(f.heldVwapEarly, false)
  assert.ok(f.earlyBelowVwapRatio > 0.3)
})

test('空数据返回 available:false', () => {
  assert.equal(intradayFeatures([]).available, false)
})
