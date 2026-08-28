import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyTrailingExits,
  entriesOnly,
} from '../shared/backtest/trailingExit.js'
import { runSingleAssetBacktest } from '../shared/backtest/engine.js'

test('entriesOnly 只保留买入并剥离自带出场', () => {
  const only = entriesOnly([
    { date: '20260101', side: 'BUY', lots: 2, reason: 'x' },
    { date: '20260103', side: 'SELL', lots: 2, reason: '止盈' },
  ])
  assert.equal(only.length, 1)
  assert.equal(only[0].side, 'BUY')
  assert.equal(only[0].lots, 2)
})

test('浮盈创新高后回撤触发跟踪止损离场', () => {
  // 进场后一路上涨到高位，然后回撤超过 trailPct → 应在回撤日离场
  const bars = [
    { date: '20260101', open: 10, high: 10.2, low: 9.9, close: 10.1, volume: 1e6 }, // 信号日
    { date: '20260102', open: 10.1, high: 11, low: 10.0, close: 10.9, volume: 1e6 }, // 进场(开10.1)
    { date: '20260103', open: 11, high: 12, low: 10.9, close: 11.9, volume: 1e6 }, // 高点12
    { date: '20260104', open: 11.9, high: 12.1, low: 11.9, close: 12.0, volume: 1e6 }, // 高点12.1
    { date: '20260105', open: 12, high: 12, low: 11.2, close: 11.3, volume: 1e6 }, // 从12.1回撤>6%→止损
    { date: '20260106', open: 11.3, high: 11.4, low: 11.0, close: 11.1, volume: 1e6 },
  ]
  const entries = [{ date: '20260101', side: 'BUY', lots: 1 }]
  const signals = applyTrailingExits(entries, bars, { trailPct: 6, activateProfitPct: 3, initialStopPct: 5 })
  const sell = signals.find((s) => s.side === 'SELL')
  assert.ok(sell, '应产生跟踪止损卖出')
  assert.match(sell.reason, /跟踪止损/)

  // 端到端可回测，且为盈利单（高位离场）
  const result = runSingleAssetBacktest({ security: { code: 'X' }, bars, signals })
  assert.equal(result.trades.length, 1)
  assert.ok(result.trades[0].netPnl > 0)
})

test('未创足够浮盈前用初始止损保护', () => {
  const bars = [
    { date: '20260101', open: 10, high: 10.1, low: 9.9, close: 10, volume: 1e6 },
    { date: '20260102', open: 10, high: 10.1, low: 9.9, close: 10, volume: 1e6 }, // 进场10
    { date: '20260103', open: 10, high: 10.1, low: 9.3, close: 9.4, volume: 1e6 }, // 跌破初始止损(5%→9.5)
    { date: '20260104', open: 9.4, high: 9.5, low: 9.2, close: 9.3, volume: 1e6 },
  ]
  const entries = [{ date: '20260101', side: 'BUY', lots: 1 }]
  const signals = applyTrailingExits(entries, bars, { initialStopPct: 5, activateProfitPct: 3 })
  const sell = signals.find((s) => s.side === 'SELL')
  assert.ok(sell)
  assert.match(sell.reason, /初始止损/)
})
