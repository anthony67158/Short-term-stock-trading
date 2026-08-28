import test from 'node:test'
import assert from 'node:assert/strict'

import {
  simulateIntradayFirstBoard,
} from '../shared/backtest/strategies/intradayFirstBoard.js'

// 早盘站稳VWAP的强势分钟线
function strongMins() {
  const rows = []
  const times = ['0935', '0940', '0945', '0950', '0955', '1000', '1030', '1130', '1330', '1430', '1500']
  let base = 11.0
  for (const t of times) {
    const px = base + 0.15
    rows.push({ time: t, open: base, high: px + 0.05, low: base - 0.03, close: px, vol: 10000, amount: px * 10000 * 100 })
    base += 0.05
  }
  return rows
}

// 早盘破位的弱势分钟线
function weakMins() {
  const rows = []
  const times = ['0935', '0940', '0945', '0950', '0955', '1000']
  let base = 11.0
  for (const t of times) {
    const px = base - 0.2
    rows.push({ time: t, open: base, high: base + 0.02, low: px - 0.05, close: px, vol: 10000, amount: px * 10000 * 100 })
    base -= 0.1
  }
  return rows
}

test('早盘站稳VWAP+合理高开→进场并产出含费round-trip', () => {
  const r = simulateIntradayFirstBoard({
    entryMins: strongMins(),
    nextOpenPrice: 12.2, // D+2 开盘兑现
    prevClose: 10.6, // 高开约4%
  })
  assert.equal(r.entered, true)
  assert.ok(r.trade.netPnl > 0) // 11.15进→12.2出，扣费后仍盈利
  assert.equal(r.trade.holdingDays, 1)
  assert.ok(r.trade.entryPrice > 0 && r.trade.exitPrice > 0)
})

test('早盘破VWAP→不进场', () => {
  const r = simulateIntradayFirstBoard({
    entryMins: weakMins(),
    nextOpenPrice: 10,
    prevClose: 11.2,
  })
  assert.equal(r.entered, false)
  assert.match(r.reason, /未站稳VWAP/)
})

test('高开过高(疑一字)→放弃进场', () => {
  const r = simulateIntradayFirstBoard({
    entryMins: strongMins(),
    nextOpenPrice: 12,
    prevClose: 10, // 开盘约11.15→高开11.5%>6%上限
  })
  assert.equal(r.entered, false)
  assert.match(r.reason, /过高/)
})

test('缺分钟数据→不进场', () => {
  const r = simulateIntradayFirstBoard({ entryMins: [], nextOpenPrice: 10, prevClose: 9 })
  assert.equal(r.entered, false)
})
