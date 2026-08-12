import test from 'node:test'
import assert from 'node:assert/strict'

import { computePortfolio as computeServerPortfolio } from '../api/_portfolio.js'
import {
  calcBuyFee,
  calcSellFee,
  computePortfolio,
  sortHoldingsByProfit,
  planStore,
} from '../src/planStore.js'

const baseAccount = {
  initialCapital: 10000,
  totalAssets: 10000,
  cash: 9000,
  goal: 20000,
}

test('总资产随持仓市值变化而变化，不再被设置金额固定', () => {
  const holding = [{
    id: 'hold_1',
    code: '000001',
    name: '平安银行',
    qty: 1,
    buyPrice: 10,
    buyFee: 0,
  }]
  const quotes = { '000001': { price: 11 } }

  const frontend = computePortfolio(holding, quotes, baseAccount)
  const backend = computeServerPortfolio(holding, quotes, baseAccount)

  for (const portfolio of [frontend, backend]) {
    assert.equal(portfolio.available, 9000)
    assert.equal(portfolio.holdMktValue, 1100)
    assert.equal(portfolio.totalAssets, 10100)
    assert.equal(portfolio.totalPnl, 100)
    assert.equal(portfolio.totalPnlPct, 1)
  }
})

test('买入后自动扣减可用现金并把手续费计入总资产亏损', () => {
  planStore.setData({
    plan: [{ code: '000001', name: '平安银行' }],
    holding: [],
    closed: [],
    account: { ...baseAccount, cash: 10000 },
  })

  planStore.buy('000001', 10, 1)

  const expectedCash = +(10000 - 1000 - calcBuyFee(1000)).toFixed(2)
  const account = planStore.get().account
  const portfolio = computePortfolio(
    planStore.get().holding,
    { '000001': { price: 10 } },
    account,
  )

  assert.equal(account.cash, expectedCash)
  assert.equal(portfolio.totalAssets, +(expectedCash + 1000).toFixed(2))
  assert.equal(portfolio.totalPnl, -calcBuyFee(1000))
  assert.equal(planStore.get().closed[0].cashApplied, true)
})

test('卖出后自动增加可用现金并保留扣费后的已实现盈亏', () => {
  const startingCash = +(10000 - 1000 - calcBuyFee(1000)).toFixed(2)
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_1',
      code: '000001',
      name: '平安银行',
      qty: 1,
      buyPrice: 10,
      buyFee: calcBuyFee(1000),
      buyAt: Date.now() - 86400000,
    }],
    closed: [],
    account: { ...baseAccount, cash: startingCash },
  })

  const result = planStore.sell('hold_1', 11, 1)

  const expectedCash = +(startingCash + 1100 - calcSellFee(1100)).toFixed(2)
  const portfolio = computePortfolio(
    planStore.get().holding,
    {},
    planStore.get().account,
  )

  assert.equal(result.ok, true)
  assert.equal(planStore.get().account.cash, expectedCash)
  assert.equal(portfolio.totalAssets, expectedCash)
  assert.equal(
    portfolio.totalPnl,
    +(100 - calcBuyFee(1000) - calcSellFee(1100)).toFixed(2),
  )
  assert.equal(planStore.get().closed[0].cashApplied, true)
})

test('做T买卖腿实时更新现金，结算归档不重复记账', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_1',
      code: '000001',
      name: '平安银行',
      qty: 1,
      buyPrice: 10,
      buyFee: calcBuyFee(1000),
      buyAt: Date.now() - 86400000,
    }],
    closed: [],
    account: { ...baseAccount, cash: 9000 },
  })

  planStore.addTFlow('hold_1', 'buy', 9, 1)
  planStore.addTFlow('hold_1', 'sell', 10, 1)

  const expectedCash = +(
    9000
    - 900
    - calcBuyFee(900)
    + 1000
    - calcSellFee(1000)
  ).toFixed(2)
  assert.equal(planStore.get().account.cash, expectedCash)

  planStore.settleTFlows('hold_1')

  assert.equal(planStore.get().account.cash, expectedCash)
  assert.equal(planStore.get().closed[0].type, 'T')
  assert.equal(planStore.get().closed[0].cashApplied, true)
})

test('删除尚未结算的做T腿会恢复已应用现金', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_1',
      code: '000001',
      name: '平安银行',
      qty: 1,
      buyPrice: 10,
      buyFee: calcBuyFee(1000),
      buyAt: Date.now() - 86400000,
    }],
    closed: [],
    account: { ...baseAccount, cash: 9000 },
  })

  planStore.addTFlow('hold_1', 'buy', 9, 1)
  const flowId = planStore.get().holding[0].tFlows[0].id
  assert.equal(
    planStore.get().account.cash,
    +(9000 - 900 - calcBuyFee(900)).toFixed(2),
  )

  planStore.removeTFlow('hold_1', flowId)

  assert.equal(planStore.get().account.cash, 9000)
})

test('未结算做T净头寸立即计入持仓市值和总资产', () => {
  const holding = [{
    id: 'hold_1',
    code: '000001',
    name: '平安银行',
    qty: 1,
    buyPrice: 10,
    buyFee: calcBuyFee(1000),
    tFlows: [{
      id: 'flow_1',
      side: 'buy',
      price: 9,
      qty: 1,
      fee: calcBuyFee(900),
      cashApplied: true,
      cashFlow: -(900 + calcBuyFee(900)),
      at: Date.now(),
    }],
  }]
  const account = {
    ...baseAccount,
    cash: +(9000 - 900 - calcBuyFee(900)).toFixed(2),
  }
  const quote = { '000001': { price: 10 } }

  for (const portfolio of [
    computePortfolio(holding, quote, account),
    computeServerPortfolio(holding, quote, account),
  ]) {
    assert.equal(portfolio.positions[0].qty, 2)
    assert.equal(portfolio.holdMktValue, 2000)
    assert.equal(portfolio.totalAssets, 10094.99)
  }
})

test('删除已应用现金的建仓记录会同时恢复现金和持仓', () => {
  planStore.setData({
    plan: [{ code: '000001', name: '平安银行' }],
    holding: [],
    closed: [],
    account: { ...baseAccount, cash: 10000 },
  })

  planStore.buy('000001', 10, 1)
  const transactionId = planStore.get().closed[0].id

  planStore.removeClosed(transactionId)

  assert.equal(planStore.get().account.cash, 10000)
  assert.equal(planStore.get().holding.length, 0)
  assert.equal(planStore.get().closed.length, 0)
})

test('持仓卡按实时浮盈金额从高到低排序而不是按收益率', () => {
  const holdings = [
    { id: 'high-rate', code: '000001', qty: 1, buyPrice: 10, buyFee: 0 },
    { id: 'high-profit', code: '600000', qty: 10, buyPrice: 10, buyFee: 0 },
    { id: 'loss', code: '300001', qty: 2, buyPrice: 10, buyFee: 0 },
  ]
  const quotes = {
    '000001': { price: 11 },
    '600000': { price: 10.3 },
    '300001': { price: 9 },
  }

  const sorted = sortHoldingsByProfit(holdings, quotes, null)

  assert.deepEqual(sorted.map((holding) => holding.id), [
    'high-profit',
    'high-rate',
    'loss',
  ])
})
