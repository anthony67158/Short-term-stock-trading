import test from 'node:test'
import assert from 'node:assert/strict'

import {
  listTradePeriods,
  summarizeTradePeriod,
} from '../shared/tradePeriodPerformance.js'

const at = (text) => new Date(`${text}+08:00`).getTime()

test('月收益率按已实现交易的真实成本基数计算且不受当月买入额干扰', () => {
  const records = [
    {
      type: 'SELL',
      code: '000001',
      qty: 1,
      costPrice: 10,
      buyFee: 5,
      sellFee: 6,
      realizedPnl: 89,
      at: at('2026-08-18T10:00:00'),
    },
    {
      type: 'T',
      code: '000002',
      qty: 1,
      buyPrice: 20,
      sellPrice: 21,
      buyFee: 5,
      sellFee: 6,
      realizedPnl: 89,
      at: at('2026-08-19T11:00:00'),
    },
    {
      type: 'BUY',
      code: '000003',
      qty: 10,
      price: 50,
      fee: 15,
      at: at('2026-08-19T13:00:00'),
    },
    {
      type: 'SELL',
      code: '000004',
      qty: 1,
      sellPrice: 8,
      sellFee: 4,
      realizedPnl: 50,
      at: at('2026-08-19T14:00:00'),
    },
  ]

  const summary = summarizeTradePeriod(records, {
    startKey: '2026-08-01',
    endKey: '2026-08-31',
    label: '2026年8月',
  })

  assert.deepEqual(summary, {
    startKey: '2026-08-01',
    endKey: '2026-08-31',
    label: '2026年8月',
    transactionCount: 4,
    realizedCount: 3,
    ratedCount: 2,
    realizedPnl: 228,
    ratedPnl: 178,
    costBasis: 3010,
    returnPct: 5.91,
    fee: 36,
  })
})

test('自然周列表按周一到周日分组并按最近周期倒序', () => {
  const periods = listTradePeriods([
    { type: 'BUY', at: at('2026-08-02T10:00:00') },
    { type: 'SELL', at: at('2026-08-03T10:00:00') },
    { type: 'T', at: at('2026-08-19T10:00:00') },
  ], 'week')

  assert.deepEqual(periods, [
    {
      key: '2026-08-17',
      startKey: '2026-08-17',
      endKey: '2026-08-23',
      label: '2026.08.17–08.23',
    },
    {
      key: '2026-08-03',
      startKey: '2026-08-03',
      endKey: '2026-08-09',
      label: '2026.08.03–08.09',
    },
    {
      key: '2026-07-27',
      startKey: '2026-07-27',
      endKey: '2026-08-02',
      label: '2026.07.27–08.02',
    },
  ])
})

test('月列表只返回有真实流水的月份并去重', () => {
  const periods = listTradePeriods([
    { type: 'BUY', at: at('2026-08-02T10:00:00') },
    { type: 'SELL', at: at('2026-08-19T10:00:00') },
    { type: 'T', at: at('2026-07-31T10:00:00') },
  ], 'month')

  assert.deepEqual(periods.map((period) => period.label), [
    '2026年8月',
    '2026年7月',
  ])
})
