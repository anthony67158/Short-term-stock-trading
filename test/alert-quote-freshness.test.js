import test from 'node:test'
import assert from 'node:assert/strict'

import { isFreshAlertQuote } from '../shared/alertQuotePolicy.js'

const now = Date.parse('2026-08-21T02:00:00Z')

test('盯盘预警只接受北京时间当日行情', () => {
  assert.equal(
    isFreshAlertQuote({ price: 10, tradeDate: '2026-08-21' }, now),
    true,
  )
  assert.equal(
    isFreshAlertQuote({ price: 10, tradeDate: '2026-08-20' }, now),
    false,
  )
})

test('收盘后即使报价日期为当天也不触发盘中预警', () => {
  const afterClose = Date.parse('2026-08-21T07:30:00Z')

  assert.equal(
    isFreshAlertQuote(
      { price: 10, tradeDate: '2026-08-21' },
      afterClose,
    ),
    false,
  )
})

test('缺失交易日期或无效价格不能触发预警', () => {
  assert.equal(isFreshAlertQuote({ price: 10 }, now), false)
  assert.equal(
    isFreshAlertQuote({ price: 0, tradeDate: '2026-08-21' }, now),
    false,
  )
  assert.equal(
    isFreshAlertQuote({ price: 'bad', tradeDate: '2026-08-21' }, now),
    false,
  )
})

test('竞价或最近收盘展示价不得触发盘中预警', () => {
  assert.equal(
    isFreshAlertQuote({
      price: 10,
      tradeDate: '2026-08-21',
      priceStatus: 'AUCTION',
      isLivePrice: false,
    }, now),
    false,
  )
  assert.equal(
    isFreshAlertQuote({
      price: 10,
      tradeDate: '2026-08-21',
      priceStatus: 'PREVIOUS_CLOSE',
      isLivePrice: false,
    }, now),
    false,
  )
})
