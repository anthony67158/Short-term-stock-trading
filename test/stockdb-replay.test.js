import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateFiveMinuteBars,
  buildCausalSnapshot,
  buildCausalTrends,
  buildHistoricalMarketContext,
} from '../scripts/lib/stockdb-replay.mjs'

function minute(time, overrides = {}) {
  return {
    date: Number(`20260908${time}00`),
    code: '600519',
    name: '贵州茅台',
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    amount: 100_000,
    ...overrides,
  }
}

const daily = Array.from({ length: 6 }, (_, index) => ({
  date: 20260831 + index,
  code: '600519',
  name: '贵州茅台',
  open: 99,
  high: 101,
  low: 98,
  close: index === 5 ? 100 : 99,
  volume: 240_000,
  amount: 24_000_000,
  turnover_rate: 2.4,
}))

test('盘中快照严格排除信号时刻之后的数据', () => {
  const snapshot = buildCausalSnapshot({
    code: '600519',
    name: '贵州茅台',
    tradeDate: '2026-09-08',
    dailyHistory: daily,
    slot: '1020',
    minuteRows: [
      minute('0931', { close: 100, high: 100.5 }),
      minute('1020', { close: 101, high: 101.2 }),
      minute('1021', {
        close: 120,
        high: 120,
        amount: 999_999_999,
      }),
    ],
  })

  assert.equal(snapshot.price, 101)
  assert.equal(snapshot.high, 101.2)
  assert.equal(snapshot.amount, 200_000)
  assert.equal(snapshot.turnover, 0.02)
  assert.equal(snapshot.volumeRatio, 1)
})

test('盘中快照拒绝缺少目标时点分钟线的陈旧价格', () => {
  const snapshot = buildCausalSnapshot({
    code: '600519',
    name: '贵州茅台',
    tradeDate: '2026-09-08',
    dailyHistory: daily,
    slot: '1020',
    minuteRows: [
      minute('0931', { close: 100 }),
      minute('1019', { close: 101 }),
    ],
  })

  assert.equal(snapshot, null)
})

test('分时均价只累计信号时刻以前的成交', () => {
  const trends = buildCausalTrends([
    minute('0931', { close: 10, volume: 100, amount: 1000 }),
    minute('0932', { close: 12, volume: 100, amount: 1200 }),
    minute('1341', { close: 30, volume: 100, amount: 3000 }),
  ], '1020')

  assert.equal(trends.length, 2)
  assert.equal(trends.at(-1).avg, 11)
})

test('五分钟聚合遵循StockDB交易时段对齐规则', () => {
  const bars = aggregateFiveMinuteBars([
    minute('0931', { open: 10, close: 10, high: 10, low: 10 }),
    minute('0935', { open: 10, close: 11, high: 11, low: 10 }),
    minute('0936', { open: 11, close: 12, high: 12, low: 11 }),
    minute('1300', { open: 12, close: 13, high: 13, low: 12 }),
    minute('1305', { open: 13, close: 14, high: 14, low: 13 }),
  ])

  assert.deepEqual(
    bars.map((bar) => bar.tradeTime),
    [
      '2026-09-08 09:35:00',
      '2026-09-08 09:40:00',
      '2026-09-08 13:05:00',
    ],
  )
  assert.equal(bars[0].open, 10)
  assert.equal(bars[0].close, 11)
  assert.equal(bars[2].close, 14)
})

test('市场上下家数形成连续市场状态且不全局禁买', () => {
  const context = buildHistoricalMarketContext([
    { pct: 2, price: 10, limitUpPrice: 11, limitDownPrice: 9 },
    { pct: 1, price: 10, limitUpPrice: 11, limitDownPrice: 9 },
    { pct: -2, price: 10, limitUpPrice: 11, limitDownPrice: 9 },
  ])

  assert.equal(context.marketGate.allowed, true)
  assert.equal(context.marketGate.regime.breadth.up, 2)
  assert.equal(context.marketGate.regime.breadth.down, 1)
  assert.equal(context.marketGate.riskTier, 'STANDARD')
})
