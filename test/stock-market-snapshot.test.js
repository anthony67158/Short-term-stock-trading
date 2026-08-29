import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStockMarketSnapshot,
} from '../shared/stockMarketSnapshot.js'

const candles = [
  { date: '2026-08-21', close: 60, turnover: 1 },
  { date: '2026-08-24', close: 61, turnover: 2 },
  { date: '2026-08-25', close: 62, turnover: 3 },
  { date: '2026-08-26', close: 63, turnover: 4 },
  { date: '2026-08-27', close: 64, turnover: 5 },
  { date: '2026-08-28', close: 66, turnover: 6 },
]

test('盘后快照保留最近收盘指标并汇总近5个交易日', () => {
  const result = buildStockMarketSnapshot({
    quote: {
      tradeDate: '2026-08-28',
      isLivePrice: false,
      turnover: 6,
      volRatio: 1.4,
      mainInflow: 180_000_000,
      retailInflow: -120_000_000,
    },
    candles,
    fund: {
      asOfDate: '2026-08-28',
      mainNetYi: 1.8,
      retailNetYi: -1.2,
      main5dYi: 5.5,
      retail5dYi: -3.1,
      historyDayCount: 5,
      historyComplete: true,
      inflowDays: 4,
      retailInflowDays: 1,
    },
  })

  assert.equal(result.label, '最近收盘')
  assert.equal(result.asOfDate, '2026-08-28')
  assert.equal(result.latest.turnover, 6)
  assert.equal(result.latest.volumeRatio, 1.4)
  assert.equal(result.latest.mainNetYi, 1.8)
  assert.equal(result.latest.retailNetYi, -1.2)
  assert.equal(result.recent5.dayCount, 5)
  assert.equal(result.recent5.priceChangePct, 10)
  assert.equal(result.recent5.mainNetYi, 5.5)
  assert.equal(result.recent5.retailNetYi, -3.1)
  assert.equal(result.recent5.mainInflowDays, 4)
})

test('盘中快照明确标记实时且资金优先使用实时快照', () => {
  const result = buildStockMarketSnapshot({
    quote: {
      tradeDate: '2026-08-28',
      isLivePrice: true,
      turnover: 3.2,
      volRatio: 1.8,
      mainInflow: 90_000_000,
      retailInflow: -40_000_000,
    },
    candles,
    fund: {
      asOfDate: '2026-08-28',
      mainNetYi: 1.1,
      retailNetYi: -0.6,
      historyDayCount: 4,
      historyComplete: false,
    },
  })

  assert.equal(result.label, '盘中快照')
  assert.equal(result.latest.mainNetYi, 1.1)
  assert.equal(result.latest.retailNetYi, -0.6)
  assert.equal(result.recent5.mainNetYi, null)
  assert.equal(result.recent5.retailNetYi, null)
})

test('资金缺失时保持未知且不足5日不伪装成五日累计', () => {
  const result = buildStockMarketSnapshot({
    quote: {
      isLivePrice: false,
      turnover: null,
      volRatio: null,
      mainInflow: null,
      retailInflow: null,
    },
    candles: candles.slice(-3),
    fund: null,
  })

  assert.equal(result.latest.turnover, 6)
  assert.equal(result.latest.volumeRatio, null)
  assert.equal(result.latest.mainNetYi, null)
  assert.equal(result.latest.retailNetYi, null)
  assert.equal(result.recent5.dayCount, 3)
  assert.equal(result.recent5.mainNetYi, null)
  assert.equal(result.recent5.retailNetYi, null)
})

test('资金日期落后时不把历史值伪装成当前快照', () => {
  const result = buildStockMarketSnapshot({
    quote: {
      tradeDate: '2026-08-28',
      isLivePrice: true,
      mainInflow: 90_000_000,
      retailInflow: -40_000_000,
    },
    candles,
    fund: {
      asOfDate: '2026-08-27',
      mainNetYi: -8,
      retailNetYi: 9,
      main5dYi: -20,
      retail5dYi: 21,
      historyDayCount: 5,
      historyComplete: true,
      inflowDays: 1,
      retailInflowDays: 4,
    },
  })

  assert.equal(result.latest.mainNetYi, 0.9)
  assert.equal(result.latest.retailNetYi, -0.4)
  assert.equal(result.recent5.mainNetYi, null)
  assert.equal(result.recent5.retailNetYi, null)
})
