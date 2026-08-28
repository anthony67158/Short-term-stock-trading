import test from 'node:test'
import assert from 'node:assert/strict'

import { runSingleAssetBacktest } from '../shared/backtest/engine.js'

// 构造一段连续上涨的普通主板日线（10% 涨跌停），preClose 自动兜底。
function bars() {
  return [
    { date: '20260803', open: 10.0, high: 10.3, low: 9.9, close: 10.2, volume: 1e6 },
    { date: '20260804', open: 10.2, high: 10.6, low: 10.1, close: 10.5, volume: 1e6 },
    { date: '20260805', open: 10.5, high: 10.9, low: 10.4, close: 10.8, volume: 1e6 },
    { date: '20260806', open: 10.8, high: 11.2, low: 10.7, close: 11.1, volume: 1e6 },
    { date: '20260807', open: 11.1, high: 11.5, low: 11.0, close: 11.4, volume: 1e6 },
  ]
}

test('信号在下一根K线开盘成交，不使用当日未来信息', () => {
  const result = runSingleAssetBacktest({
    security: { code: '600000', name: '浦发银行' },
    bars: bars(),
    signals: [{ date: '20260803', side: 'BUY', lots: 1 }],
  })

  assert.equal(result.fills.length, 1)
  const fill = result.fills[0]
  assert.equal(fill.date, '20260804') // 次日成交
  assert.equal(fill.signalDate, '20260803')
  assert.equal(fill.side, 'BUY')
  // 开盘 10.2 + 5bps 滑点
  assert.ok(fill.fillPrice >= 10.2)
})

test('完整买卖配对产出含费后round-trip盈亏与收益率', () => {
  const result = runSingleAssetBacktest({
    security: { code: '600000', name: '浦发银行' },
    bars: bars(),
    signals: [
      { date: '20260803', side: 'BUY', lots: 1 },
      { date: '20260806', side: 'SELL', lots: 1 },
    ],
  })

  assert.equal(result.trades.length, 1)
  const trade = result.trades[0]
  assert.equal(trade.entryDate, '20260804')
  assert.equal(trade.exitDate, '20260807')
  assert.equal(trade.lots, 1)
  // 买入约10.2、卖出约11.1，扣两端费用后仍应为正
  assert.ok(trade.netPnl > 0)
  assert.ok(trade.returnPct > 0)
  assert.equal(result.openLots, 0)
})

test('当日买入次日卖出受T+1拦截而非静默成交', () => {
  // 信号日买入→次日(20260804)成交建仓；同日想卖出→再次日(20260805)执行，
  // 但 acquiredDate=20260804 < tradeDate=20260805 其实是可卖的。
  // 用同一执行日买+卖来验证 T+1：两个信号都落在 20260804 执行。
  const result = runSingleAssetBacktest({
    security: { code: '600000', name: '浦发银行' },
    bars: bars(),
    signals: [
      { date: '20260803', side: 'BUY', lots: 1 },
      { date: '20260803', side: 'SELL', lots: 1 },
    ],
  })

  // 买入成交，同执行日卖出被 T+1 锁定拒绝
  assert.equal(result.fills.length, 1)
  assert.equal(result.fills[0].side, 'BUY')
  const t1Reject = result.rejections.find(
    (item) => item.reason === 'T_PLUS_ONE_LOCKED',
  )
  assert.ok(t1Reject, '应存在T+1锁定拒绝记录')
  assert.equal(result.openLots, 1)
})

test('一字涨停开盘买入不可成交被拒绝', () => {
  // 次日开盘=前收*1.1 视为涨停开盘，买入应被拒。
  const limitBars = [
    { date: '20260803', open: 10.0, high: 10.0, low: 10.0, close: 10.0, volume: 1e6 },
    { date: '20260804', open: 11.0, high: 11.0, low: 11.0, close: 11.0, volume: 1e6 },
    { date: '20260805', open: 11.5, high: 12.0, low: 11.3, close: 11.9, volume: 1e6 },
  ]
  const result = runSingleAssetBacktest({
    security: { code: '600000', name: '浦发银行' },
    bars: limitBars,
    signals: [{ date: '20260803', side: 'BUY', lots: 1 }],
  })

  assert.equal(result.fills.length, 0)
  assert.equal(result.rejections[0].reason, 'LIMIT_UP_UNFILLED')
})

test('无持仓时的卖出信号被拒绝且不产生负持仓', () => {
  const result = runSingleAssetBacktest({
    security: { code: '600000', name: '浦发银行' },
    bars: bars(),
    signals: [{ date: '20260803', side: 'SELL', lots: 1 }],
  })

  assert.equal(result.fills.length, 0)
  assert.equal(result.openLots, 0)
  assert.equal(result.rejections[0].reason, 'NO_POSITION')
})

test('部分卖出按FIFO逐层结算并保留剩余持仓', () => {
  const result = runSingleAssetBacktest({
    security: { code: '600000', name: '浦发银行' },
    bars: bars(),
    signals: [
      { date: '20260803', side: 'BUY', lots: 3 },
      { date: '20260806', side: 'SELL', lots: 2 },
    ],
  })

  assert.equal(result.trades.length, 1)
  assert.equal(result.trades[0].lots, 2)
  assert.equal(result.openLots, 1)
})
