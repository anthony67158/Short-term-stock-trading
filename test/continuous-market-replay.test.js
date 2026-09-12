import test from 'node:test'
import assert from 'node:assert/strict'

import {
  executionFromBar,
  minuteSlot,
  minuteTimestamp,
  pricePathOf,
} from '../scripts/lib/continuous-market-replay.mjs'

test('历史分钟时间按北京时间转换且保留交易时点', () => {
  assert.equal(
    new Date(minuteTimestamp('20260824093500')).toISOString(),
    '2026-08-24T01:35:00.000Z',
  )
  assert.equal(minuteSlot('2026-08-24 14:55:00'), '1455')
})

test('虚拟交易成交沿用A股整手、费用、涨跌停和T+1规则', () => {
  const buy = executionFromBar({
    side: 'BUY',
    security: { code: '000001', name: '平安银行' },
    tradeDate: '20260824',
    bar: {
      open: 10,
      volume: 100_000,
      pre_close: 9.9,
    },
    lots: 2,
  })
  assert.equal(buy.fillable, true)
  assert.equal(buy.quantity, 200)
  assert.ok(buy.fees.total >= 5)
  assert.ok(buy.cashFlow < 0)

  const sameDaySell = executionFromBar({
    side: 'SELL',
    security: { code: '000001', name: '平安银行' },
    tradeDate: '20260824',
    acquiredDate: '20260824',
    bar: {
      open: 10.2,
      volume: 100_000,
      pre_close: 9.9,
    },
    lots: 1,
  })
  assert.equal(sameDaySell.fillable, false)
  assert.equal(sameDaySell.reason, 'T_PLUS_ONE_LOCKED')
})

test('五分钟K线转换为不使用未来数据的确定性价格路径', () => {
  assert.deepEqual(
    pricePathOf({ open: 10, high: 11, low: 9, close: 10.5 }),
    [10, 9, 11, 10.5],
  )
  assert.deepEqual(
    pricePathOf({ open: 10, high: 11, low: 9, close: 9.5 }),
    [10, 11, 9, 9.5],
  )
})
