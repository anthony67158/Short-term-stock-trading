import test from 'node:test'
import assert from 'node:assert/strict'

import { tradeActivityContext } from '../shared/portfolioAccounting.js'
import {
  manualTradePairCandidates,
} from '../shared/tradePairing.js'
import { planStore } from '../src/planStore.js'

function localAt(hour, minute) {
  const value = new Date()
  value.setHours(hour, minute, 0, 0)
  return value.getTime()
}

function localDay() {
  const value = new Date()
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
}

test('手动做T配对只提供同股同日、方向相反且手数一致的未占用记录', () => {
  const records = [
    { id: 'sell', type: 'SELL', code: '600000', qty: 2, price: 11, at: localAt(14, 30) },
    { id: 'buy-ok', type: 'BUY', code: '600000', qty: 2, price: 10, at: localAt(10, 0) },
    { id: 'buy-wrong-code', type: 'BUY', code: '000001', qty: 2, price: 10, at: localAt(10, 0) },
    { id: 'buy-wrong-qty', type: 'BUY', code: '600000', qty: 1, price: 10, at: localAt(10, 0) },
    {
      id: 'buy-occupied',
      type: 'BUY',
      code: '600000',
      qty: 2,
      price: 9.8,
      at: localAt(11, 0),
      tPairTradeId: 'other-sell',
    },
  ]

  assert.deepEqual(
    manualTradePairCandidates(records, records[0]).map((item) => item.id),
    ['buy-ok'],
  )
})

test('用户指定的做T另一腿优先于时间FIFO并同步标记两条记录', () => {
  const buyEarly = {
    id: 'buy-early',
    type: 'BUY',
    tradeIntent: 'position',
    code: '600000',
    name: '浦发银行',
    qty: 1,
    price: 9,
    buyPrice: 9,
    fee: 5,
    cashFlow: -905,
    at: localAt(9, 35),
  }
  const buyChosen = {
    id: 'buy-chosen',
    type: 'BUY',
    tradeIntent: 'position',
    code: '600000',
    name: '浦发银行',
    qty: 1,
    price: 10,
    buyPrice: 10,
    fee: 5,
    cashFlow: -1005,
    at: localAt(10, 15),
  }
  const sell = {
    id: 'sell',
    type: 'SELL',
    tradeIntent: 'position',
    code: '600000',
    name: '浦发银行',
    qty: 1,
    price: 11,
    sellPrice: 11,
    fee: 5.56,
    cashFlow: 1094.44,
    at: localAt(14, 30),
  }
  planStore.setData({
    plan: [],
    holding: [],
    closed: [sell, buyChosen, buyEarly],
    account: null,
  })

  const result = planStore.updateClosedTrade('sell', {
    date: localDay(),
    price: 11,
    qty: 1,
    tradeIntent: 't',
    tPairTradeId: 'buy-chosen',
  })

  assert.equal(result.ok, true)
  const next = planStore.get().closed
  const pairedSell = next.find((item) => item.id === 'sell')
  const pairedBuy = next.find((item) => item.id === 'buy-chosen')
  assert.equal(pairedSell.tPairTradeId, 'buy-chosen')
  assert.equal(pairedBuy.tPairTradeId, 'sell')
  assert.equal(pairedSell.tradeIntent, 't')
  assert.equal(pairedBuy.tradeIntent, 't')

  const context = tradeActivityContext(next, '600000')
  assert.equal(context.t.classifiedPairCount, 1)
  assert.equal(context.t.pairRecords[0].buyPrice, 10)
  assert.equal(context.t.pairRecords[0].sellPrice, 11)
  assert.equal(context.t.pairRecords[0].manualPair, true)
})

test('成本价校准保持现金、持仓手数和历史成交不变', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'holding-1',
      code: '600000',
      name: '浦发银行',
      qty: 2,
      buyPrice: 10,
      buyFee: 5,
      buyAt: localAt(9, 35),
    }],
    closed: [{
      id: 'buy-1',
      type: 'BUY',
      code: '600000',
      qty: 2,
      price: 10,
      fee: 5,
      cashFlow: -2005,
      at: localAt(9, 35),
    }],
    account: { cash: 8000, totalAssets: 10000 },
  })

  const result = planStore.updateHoldingCost('holding-1', 12.345)

  assert.equal(result.ok, true)
  const book = planStore.get()
  const holding = book.holding[0]
  const feePerShare = holding.buyFee / (holding.qty * 100)
  assert.equal(+(holding.buyPrice + feePerShare).toFixed(3), 12.345)
  assert.equal(holding.qty, 2)
  assert.equal(book.account.cash, 8000)
  assert.equal(book.closed[0].price, 10)
  assert.ok(holding.costAdjustedAt > 0)
})

test('删除手动配对的一条腿会解除另一条腿的孤立关系', () => {
  const pairId = 'manual-t:buy:sell'
  planStore.setData({
    plan: [],
    holding: [],
    closed: [{
      id: 'buy',
      type: 'BUY',
      tradeIntent: 't',
      tPairId: pairId,
      tPairTradeId: 'sell',
      tPairPreviousIntent: 'position',
      code: '600000',
      qty: 1,
      price: 10,
      at: localAt(10, 0),
    }, {
      id: 'sell',
      type: 'SELL',
      tradeIntent: 't',
      tPairId: pairId,
      tPairTradeId: 'buy',
      tPairPreviousIntent: 'position',
      code: '600000',
      qty: 1,
      price: 11,
      at: localAt(14, 0),
    }],
    account: null,
  })

  planStore.removeClosed('buy')

  const remaining = planStore.get().closed[0]
  assert.equal(remaining.id, 'sell')
  assert.equal(remaining.tradeIntent, 'position')
  assert.equal(remaining.tPairId, undefined)
  assert.equal(remaining.tPairTradeId, undefined)
})
