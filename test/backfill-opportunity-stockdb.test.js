import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseStockDbBackfillArgs,
} from '../scripts/backfill-opportunity-stockdb.mjs'

test('StockDB回填命令限制日期、样本天数和股票池规模', () => {
  const options = parseStockDbBackfillArgs([
    '--stockdb-root',
    '/tmp/stockdb',
    '--work-dir',
    '/tmp/work',
    '--from',
    '20260101',
    '--to',
    '20260909',
    '--signal-days',
    '200',
    '--universe-size',
    '9000',
  ])

  assert.equal(options.from, '20260101')
  assert.equal(options.to, '20260909')
  assert.equal(options.signalDays, 120)
  assert.equal(options.universeSize, 2000)
})

test('StockDB回填命令拒绝未知参数和倒置日期', () => {
  assert.throws(
    () => parseStockDbBackfillArgs(['--unknown', 'value']),
    /未知/,
  )
  assert.throws(
    () => parseStockDbBackfillArgs([
      '--from',
      '20260909',
      '--to',
      '20260901',
    ]),
    /日期范围/,
  )
})
