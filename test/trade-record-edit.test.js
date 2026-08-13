import test from 'node:test'
import assert from 'node:assert/strict'

import {
  calcBuyFee,
  calcSellFee,
  planStore,
} from '../src/planStore.js'

const today = () => {
  const value = new Date()
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
}

test('编辑买入流水会重算成交、现金、持仓并进入云端保存载荷', async () => {
  const oldFee = calcBuyFee(2000)
  const oldCashFlow = -(2000 + oldFee)
  let saved = null
  planStore.registerSaver((data) => { saved = data; return true })
  planStore.setData({
    plan: [],
    holding: [{
      id: 'holding-buy',
      code: '600000',
      name: '浦发银行',
      buyPrice: 10,
      buyAt: Date.now() - 86400000,
      qty: 2,
      buyFee: oldFee,
    }],
    closed: [{
      id: 'buy-1',
      type: 'BUY',
      code: '600000',
      name: '浦发银行',
      holdingId: 'holding-buy',
      qty: 2,
      price: 10,
      fee: oldFee,
      amount: 2000,
      cashFlow: oldCashFlow,
      cashApplied: true,
      at: Date.now() - 86400000,
    }],
    decisionLog: [{
      id: 'execution:buy-1',
      kind: 'execution',
      transactionId: 'buy-1',
      side: 'buy',
      price: 10,
      qty: 2,
      at: Date.now() - 86400000,
    }],
    account: { initialCapital: 10000, totalAssets: 10000, cash: 10000 + oldCashFlow },
  })

  const result = planStore.updateClosedTrade('buy-1', {
    date: today(),
    price: 11,
    qty: 3,
  })

  assert.equal(result.ok, true)
  const record = planStore.get().closed[0]
  const holding = planStore.get().holding[0]
  const nextFee = calcBuyFee(3300)
  const nextCashFlow = -(3300 + nextFee)
  assert.deepEqual(
    {
      price: record.price,
      qty: record.qty,
      amount: record.amount,
      fee: record.fee,
      cashFlow: record.cashFlow,
    },
    { price: 11, qty: 3, amount: 3300, fee: nextFee, cashFlow: nextCashFlow },
  )
  assert.deepEqual(
    { qty: holding.qty, buyPrice: holding.buyPrice, buyFee: holding.buyFee },
    { qty: 3, buyPrice: 11, buyFee: nextFee },
  )
  assert.equal(new Date(holding.buyAt).toDateString(), new Date().toDateString())
  assert.equal(planStore.get().account.cash, +(10000 + nextCashFlow).toFixed(2))
  assert.equal(planStore.get().decisionLog[0].price, 11)
  assert.equal(planStore.get().decisionLog[0].qty, 3)

  await new Promise((resolve) => setTimeout(resolve, 850))
  assert.equal(saved.closed[0].price, 11)
  assert.equal(saved.closed[0].qty, 3)
  assert.equal(saved.holding[0].buyPrice, 11)
  assert.equal(saved.account.cash, +(10000 + nextCashFlow).toFixed(2))
  planStore.registerSaver(null)
})

test('编辑卖出流水会重算手续费盈亏现金并修正剩余持仓', () => {
  const oldSellFee = calcSellFee(1100)
  const oldCashFlow = +(1100 - oldSellFee).toFixed(2)
  planStore.setData({
    plan: [],
    holding: [{
      id: 'holding-sell',
      code: '000001',
      name: '平安银行',
      buyPrice: 10,
      buyAt: Date.now() - 86400000 * 3,
      qty: 2,
      buyFee: 3.36,
    }],
    closed: [{
      id: 'sell-1',
      type: 'SELL',
      code: '000001',
      name: '平安银行',
      holdingId: 'holding-sell',
      qty: 1,
      price: 11,
      sellPrice: 11,
      costPrice: 10,
      buyPrice: 10,
      buyFee: 1.68,
      fee: oldSellFee,
      sellFee: oldSellFee,
      amount: 1100,
      cashFlow: oldCashFlow,
      cashApplied: true,
      realizedPnl: +(100 - 1.68 - oldSellFee).toFixed(2),
      at: Date.now() - 86400000,
    }],
    account: { initialCapital: 10000, totalAssets: 10000, cash: 5000 },
  })

  const result = planStore.updateClosedTrade('sell-1', {
    date: today(),
    price: 12,
    qty: 2,
  })

  assert.equal(result.ok, true)
  const record = planStore.get().closed[0]
  const sellFee = calcSellFee(2400)
  const buyFee = 3.36
  const expectedPnl = +(400 - buyFee - sellFee).toFixed(2)
  assert.deepEqual(
    {
      price: record.price,
      qty: record.qty,
      amount: record.amount,
      fee: record.fee,
      realizedPnl: record.realizedPnl,
    },
    { price: 12, qty: 2, amount: 2400, fee: sellFee, realizedPnl: expectedPnl },
  )
  assert.equal(planStore.get().holding[0].qty, 1)
  assert.equal(planStore.get().holding[0].buyFee, 1.68)
  assert.equal(
    planStore.get().account.cash,
    +(5000 + (2400 - sellFee) - oldCashFlow).toFixed(2),
  )
})

test('编辑已归档做T流水会按新买卖价和手数重算双边费用与净收益', () => {
  const oldBuyFee = calcBuyFee(900)
  const oldSellFee = calcSellFee(1000)
  const oldNet = +(100 - oldBuyFee - oldSellFee).toFixed(2)
  planStore.setData({
    plan: [],
    holding: [],
    closed: [{
      id: 't-1',
      type: 'T',
      kind: 'T',
      code: '600000',
      name: '浦发银行',
      qty: 1,
      buyPrice: 9,
      sellPrice: 10,
      buyFee: oldBuyFee,
      sellFee: oldSellFee,
      grossPnl: 100,
      netPnl: oldNet,
      realizedPnl: oldNet,
      cashFlow: oldNet,
      cashApplied: true,
      at: Date.now() - 86400000,
    }],
    account: { initialCapital: 10000, totalAssets: 10000, cash: 5000 },
  })

  const result = planStore.updateClosedTrade('t-1', {
    date: today(),
    buyPrice: 8.5,
    sellPrice: 10.5,
    qty: 2,
  })

  assert.equal(result.ok, true)
  const record = planStore.get().closed[0]
  const buyFee = calcBuyFee(1700)
  const sellFee = calcSellFee(2100)
  const netPnl = +(400 - buyFee - sellFee).toFixed(2)
  assert.deepEqual(
    {
      qty: record.qty,
      buyPrice: record.buyPrice,
      sellPrice: record.sellPrice,
      buyFee: record.buyFee,
      sellFee: record.sellFee,
      grossPnl: record.grossPnl,
      netPnl: record.netPnl,
      cashFlow: record.cashFlow,
    },
    { qty: 2, buyPrice: 8.5, sellPrice: 10.5, buyFee, sellFee, grossPnl: 400, netPnl, cashFlow: netPnl },
  )
  assert.equal(planStore.get().account.cash, +(5000 + netPnl - oldNet).toFixed(2))
})

test('流水编辑拒绝未来日期、非整数手数和超出持仓的卖出修正', () => {
  planStore.setData({
    plan: [],
    holding: [],
    closed: [{
      id: 'sell-invalid',
      type: 'SELL',
      code: '000001',
      name: '平安银行',
      qty: 1,
      price: 11,
      costPrice: 10,
      at: Date.now(),
    }],
  })

  assert.equal(planStore.updateClosedTrade('sell-invalid', { date: '2999-01-01', price: 11, qty: 1 }).ok, false)
  assert.equal(planStore.updateClosedTrade('sell-invalid', { date: today(), price: 11, qty: 1.5 }).ok, false)
  assert.equal(planStore.updateClosedTrade('sell-invalid', { date: today(), price: 11, qty: 2 }).ok, false)
})

test('旧卖出记录不会误改后来重新买入的同股持仓', () => {
  const currentBuyAt = Date.now() - 3600000
  const oldSellAt = Date.now() - 86400000 * 3
  planStore.setData({
    plan: [],
    holding: [{
      id: 'reopened',
      code: '000001',
      name: '平安银行',
      qty: 2,
      buyPrice: 12,
      buyFee: calcBuyFee(2400),
      buyAt: currentBuyAt,
    }],
    closed: [{
      id: 'old-sell',
      type: 'SELL',
      code: '000001',
      name: '平安银行',
      qty: 2,
      price: 11,
      costPrice: 10,
      buyPrice: 10,
      buyFee: calcBuyFee(2000),
      at: oldSellAt,
    }],
  })

  const result = planStore.updateClosedTrade('old-sell', {
    date: today(),
    price: 11,
    qty: 1,
  })

  assert.equal(result.ok, true)
  assert.equal(planStore.get().holding.find((item) => item.id === 'reopened').qty, 2)
  assert.equal(planStore.get().holding.length, 2)
})
