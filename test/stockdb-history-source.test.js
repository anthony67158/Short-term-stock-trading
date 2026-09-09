import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STOCKDB_DAILY_FIELDS,
  STOCKDB_MINUTE_FIELDS,
  StockDbHistorySource,
  indexRowsByCode,
} from '../scripts/lib/stockdb-history-source.mjs'

function projected(fields, values) {
  return fields.map((field) => values[field] ?? null)
}

test('StockDB历史源按A股前缀批量读取并归一化字段', async () => {
  const calls = []
  const client = {
    async values(table, prefix, dateQuery, fields) {
      calls.push({ table, prefix, dateQuery, fields })
      if (table === '日k' && prefix === '6*') {
        return [projected(STOCKDB_DAILY_FIELDS, {
          date: 20260908,
          code: '600519',
          name: '贵州茅台',
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          pre_close: 100,
          volume: 1000,
          amount: 101_000,
          turnover: 1.2,
          vol_ratio: 1.1,
          float_share: 10_000,
          is_st: 0,
        })]
      }
      if (table === '资金流' && prefix === '6*') {
        return [{
          date: 20260908,
          sec_code: '600519',
          main_net: 200_000_000,
          small_net: -50_000_000,
        }]
      }
      if (table === '分钟k' && prefix === '6*') {
        return [projected(STOCKDB_MINUTE_FIELDS, {
          date: 20260908102000,
          code: '600519',
          name: '贵州茅台',
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          pre_close: 100,
          volume: 100,
          amount: 10_050,
        })]
      }
      return []
    },
  }
  const source = new StockDbHistorySource(client)

  const daily = await source.dailyRange('2026-09-08', '2026-09-08')
  const funds = await source.fundRange('20260908', '20260908')
  const minutes = await source.minuteDay('2026-09-08')

  assert.equal(calls.length, 12)
  assert.equal(daily[0].turnover, 1.2)
  assert.equal(funds[0].mainNetYi, 2)
  assert.equal(funds[0].retailNetYi, -0.5)
  assert.equal(minutes[0].timestamp, '20260908102000')
})

test('StockDB历史源拒绝倒置日期并按代码建立有序索引', async () => {
  const source = new StockDbHistorySource({
    values: async () => [],
  })
  await assert.rejects(
    () => source.dailyRange('20260909', '20260908'),
    /日期范围/,
  )

  const indexed = indexRowsByCode([
    { code: '600519', date: '20260909' },
    { code: '600519', date: '20260908' },
    { code: 'bad', date: '20260908' },
  ])
  assert.deepEqual(
    indexed.get('600519').map((row) => row.date),
    ['20260908', '20260909'],
  )
})
