import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHistoricalFund,
  groupMinuteRows,
  pendingFromBatch,
  scanHistoricalSlot,
} from '../scripts/lib/stockdb-backfill-runtime.mjs'

function day(offset) {
  const date = new Date('2026-07-01T00:00:00Z')
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function dailyRows() {
  return Array.from({ length: 70 }, (_, index) => ({
    date: day(index),
    code: '600519',
    name: '贵州茅台',
    open: 99 + index * 0.02,
    high: 101 + index * 0.02,
    low: 98 + index * 0.02,
    close: 100 + index * 0.02,
    preClose: 99.98 + index * 0.02,
    volume: 1_000_000,
    amount: 100_000_000,
    turnover: 2,
    isSt: false,
  }))
}

function minute(time, close) {
  return {
    timestamp: `20260908${time}00`,
    date: '20260908',
    code: '600519',
    name: '贵州茅台',
    open: close - 0.05,
    high: close + 0.1,
    low: close - 0.1,
    close,
    preClose: 101.36,
    volume: 100_000,
    amount: close * 100_000,
  }
}

test('盘中资金特征不读取当日盘后资金', () => {
  const rows = [
    {
      date: '20260907',
      mainNetYi: 1,
      retailNetYi: -0.5,
      mainRatio: 2,
    },
    {
      date: '20260908',
      mainNetYi: 9,
      retailNetYi: -4,
      mainRatio: 8,
    },
  ]

  const intraday = buildHistoricalFund(rows, '20260908', 'intraday')
  const close = buildHistoricalFund(rows, '20260908', 'close')
  assert.equal(intraday.mainNetYi, null)
  assert.equal(intraday.main5dYi, 1)
  assert.equal(close.mainNetYi, 9)
  assert.equal(close.main5dYi, 10)
})

test('历史时点可复用生产扫描器生成三路径账本', async () => {
  const minutes = [
    minute('0931', 101.4),
    minute('1000', 101.5),
    minute('1020', 101.6),
    minute('1330', 101.7),
    minute('1455', 101.8),
    minute('1500', 101.9),
  ]
  const minutesByCode = groupMinuteRows(minutes)
  const batch = await scanHistoricalSlot({
    tradeDate: '20260908',
    mode: 'close',
    slot: '1510',
    universeCodes: ['600519'],
    minutesByCode,
    dailyByCode: new Map([['600519', dailyRows()]]),
    fundByCode: new Map([['600519', [{
      date: '20260908',
      code: '600519',
      mainNetYi: 1,
      retailNetYi: -0.5,
      mainRatio: 2,
    }]]]),
  })

  assert.equal(batch.tradeDate, '2026-09-08')
  assert.equal(batch.events.length, 1)
  assert.ok(batch.events[0].quote.mainRatio > 0)
  assert.ok(batch.events[0].counterfactualPlans.length >= 1)
  assert.ok(pendingFromBatch(batch).length >= 1)
})
