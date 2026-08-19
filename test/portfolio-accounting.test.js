import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWatchPayload,
  computePortfolio as computeServerPortfolio,
} from '../api/_portfolio.js'
import {
  calcBuyFee,
  calcSellFee,
  computeTFlows,
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

test('军师账户上下文包含现金储备与行业集中度', () => {
  const holding = [
    { id: 'h1', code: '600487', industry: '通信设备', buyPrice: 50, qty: 3 },
    { id: 'h2', code: '600522', industry: '通信设备', buyPrice: 30, qty: 2 },
    { id: 'h3', code: '605358', industry: '半导体', buyPrice: 40, qty: 2 },
  ]
  const quoteMap = {
    '600487': { price: 60 },
    '600522': { price: 35 },
    '605358': { price: 45 },
  }
  const portfolio = computeServerPortfolio(holding, quoteMap, { cash: 6000 })
  const payload = buildWatchPayload('000001', '候选股', portfolio, { cash: 6000 })

  assert.equal(payload.account.cashReservePct, 15)
  assert.equal(payload.account.maxStockWeight, 45)
  assert.deepEqual(payload.account.industryWeights, [
    { industry: '通信设备', weight: 62.5 },
    { industry: '半导体', weight: 22.5 },
  ])
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

test('现金不足时拒绝建仓、加仓和做T买腿且账本保持不变', () => {
  planStore.setData({
    plan: [{ code: '000001', name: '平安银行' }],
    holding: [{
      id: 'hold_1',
      code: '600000',
      name: '浦发银行',
      qty: 1,
      buyPrice: 10,
      buyFee: calcBuyFee(1000),
      buyAt: Date.now() - 86400000,
    }],
    closed: [],
    account: { ...baseAccount, cash: 500 },
  })

  const buy = planStore.buy('000001', 10, 1)
  const add = planStore.addToHolding('hold_1', 10, 1)
  const tBuy = planStore.addTFlow('hold_1', 'buy', 10, 1)

  assert.equal(buy.ok, false)
  assert.equal(add.ok, false)
  assert.equal(tBuy.ok, false)
  assert.match(buy.error, /现金不足/)
  assert.equal(planStore.get().account.cash, 500)
  assert.equal(planStore.get().plan.length, 1)
  assert.equal(planStore.get().holding[0].qty, 1)
  assert.equal(planStore.get().closed.length, 0)
  assert.equal((planStore.get().holding[0].tFlows || []).length, 0)
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

test('做T已实现收益摊薄有效成本，浮盈金额与百分比使用同一成本口径', () => {
  const portfolio = computePortfolio([{
    id: 'hold_t_cost',
    code: '003036',
    name: '泰坦股份',
    qty: 1,
    buyPrice: 52.8,
    buyFee: 2.6,
    tRealizedPnl: 135,
  }], {
    '003036': { price: 54.7 },
  }, { cash: 0 })

  const position = portfolio.positions[0]
  assert.equal(position.costValue, 5147.6)
  assert.equal(position.floatPnl, 322.4)
  assert.equal(position.floatPct, 6.26)
})

test('加载旧版已结算做T记录时恢复缺失的成本摊薄收益', () => {
  const settledAt = Date.now() - 3600000
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_t_legacy',
      code: '003036',
      name: '泰坦股份',
      qty: 1,
      buyPrice: 52.8,
      buyFee: 2.6,
      buyAt: settledAt - 3600000,
    }],
    closed: [{
      id: 'legacy_t_record',
      type: 'T',
      holdingId: 'hold_t_legacy',
      code: '003036',
      qty: 1,
      netPnl: 135,
      realizedPnl: 135,
      at: settledAt,
    }],
  })

  const holding = planStore.get().holding[0]
  const position = computePortfolio(planStore.get().holding, {
    '003036': { price: 54.7 },
  }, { cash: 0 }).positions[0]

  assert.equal(holding.tRealizedPnl, 135)
  assert.equal(position.costWithFees, 51.476)
  assert.equal(position.floatPnl, 322.4)
})

test('删除已结算做T记录时恢复剩余持仓的原始成本', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_t_delete',
      code: '003036',
      name: '泰坦股份',
      qty: 1,
      buyPrice: 52.8,
      buyFee: 2.6,
      tRealizedPnl: 135,
    }],
    closed: [{
      id: 'settled_t_record',
      type: 'T',
      holdingId: 'hold_t_delete',
      code: '003036',
      qty: 1,
      netPnl: 135,
      realizedPnl: 135,
      at: Date.now() - 3600000,
    }],
  })

  planStore.removeClosed('settled_t_record')

  const holding = planStore.get().holding[0]
  const position = computePortfolio(planStore.get().holding, {
    '003036': { price: 54.7 },
  }, { cash: 0 }).positions[0]

  assert.equal(holding.tRealizedPnl, 0)
  assert.equal(position.costWithFees, 52.826)
  assert.equal(position.floatPnl, 187.4)
})

test('编辑已结算做T记录时同步更新剩余持仓的成本摊薄收益', () => {
  const now = new Date()
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_t_edit',
      code: '003036',
      name: '泰坦股份',
      qty: 1,
      buyPrice: 52.8,
      buyFee: 2.6,
      tRealizedPnl: 135,
    }],
    closed: [{
      id: 'settled_t_edit',
      type: 'T',
      holdingId: 'hold_t_edit',
      code: '003036',
      qty: 1,
      buyPrice: 50,
      sellPrice: 51.4,
      buyFee: 2.6,
      sellFee: 2.6,
      netPnl: 135,
      realizedPnl: 135,
      at: Date.now() - 3600000,
    }],
  })

  const result = planStore.updateClosedTrade('settled_t_edit', {
    date,
    buyPrice: 50,
    sellPrice: 52,
    qty: 1,
  })

  const record = planStore.get().closed[0]
  const holding = planStore.get().holding[0]
  assert.equal(result.ok, true)
  assert.equal(holding.tRealizedPnl, record.realizedPnl)
})

test('结算做T后保留结算前的有效成本和浮盈', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_t_settle',
      code: '003036',
      name: '泰坦股份',
      qty: 1,
      buyPrice: 52.8,
      buyFee: 2.6,
      buyAt: Date.now() - 86400000,
    }],
    closed: [],
  })

  planStore.addTFlow('hold_t_settle', 'buy', 50, 1)
  planStore.addTFlow('hold_t_settle', 'sell', 51.4, 1)
  const beforeHolding = planStore.get().holding[0]
  const realized = computeTFlows(beforeHolding.tFlows).realized
  const before = computePortfolio(planStore.get().holding, {
    '003036': { price: 54.7 },
  }, { cash: 0 }).positions[0]

  planStore.settleTFlows('hold_t_settle')

  const afterHolding = planStore.get().holding[0]
  const after = computePortfolio(planStore.get().holding, {
    '003036': { price: 54.7 },
  }, { cash: 0 }).positions[0]

  assert.equal(afterHolding.tRealizedPnl, realized)
  assert.equal(after.costValue, before.costValue)
  assert.equal(after.floatPnl, before.floatPnl)
  assert.equal(after.floatPct, before.floatPct)
})

test('结算做T后减仓按剩余手数分摊累计做T收益', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_t_reduce',
      code: '003036',
      name: '泰坦股份',
      qty: 2,
      buyPrice: 52.8,
      buyFee: 5.2,
      buyAt: Date.now() - 86400000,
      tRealizedPnl: 135,
    }],
    closed: [],
  })

  const before = computePortfolio(planStore.get().holding, {
    '003036': { price: 54.7 },
  }, { cash: 0 }).positions[0]

  planStore.sell('hold_t_reduce', 54.7, 1)

  const afterHolding = planStore.get().holding[0]
  const after = computePortfolio(planStore.get().holding, {
    '003036': { price: 54.7 },
  }, { cash: 0 }).positions[0]

  assert.equal(afterHolding.tRealizedPnl, 67.5)
  assert.equal(after.costValue, +(before.costValue / 2).toFixed(2))
  assert.equal(after.costWithFees, before.costWithFees)
  assert.equal(after.floatPct, before.floatPct)
})

test('修改做T后显示成本不会重复扣减累计做T收益', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_t_adjust',
      code: '003036',
      name: '泰坦股份',
      qty: 1,
      buyPrice: 52.8,
      buyFee: 2.6,
      tRealizedPnl: 135,
    }],
    closed: [],
  })

  const result = planStore.updateHoldingCost('hold_t_adjust', 51.476)
  const position = computePortfolio(planStore.get().holding, {
    '003036': { price: 54.7 },
  }, { cash: 0 }).positions[0]

  assert.equal(result.ok, true)
  assert.equal(position.costWithFees, 51.476)
  assert.equal(position.floatPnl, 322.4)
})

test('未配平做T净腿结算后同步维护持仓买入手续费', () => {
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold_buy',
      code: '000001',
      name: '平安银行',
      qty: 2,
      buyPrice: 10,
      buyFee: 6,
      buyAt: Date.now() - 86400000,
    }, {
      id: 'hold_sell',
      code: '600000',
      name: '浦发银行',
      qty: 2,
      buyPrice: 10,
      buyFee: 6,
      buyAt: Date.now() - 86400000,
    }],
    closed: [],
    account: { ...baseAccount, cash: 10000 },
  })

  planStore.addTFlow('hold_buy', 'buy', 9, 1)
  planStore.settleTFlows('hold_buy')
  planStore.addTFlow('hold_sell', 'sell', 11, 1)
  planStore.settleTFlows('hold_sell')

  const buyPosition = planStore.get().holding.find((item) => item.id === 'hold_buy')
  const sellPosition = planStore.get().holding.find((item) => item.id === 'hold_sell')
  assert.equal(buyPosition.buyFee, +(6 + calcBuyFee(900)).toFixed(2))
  assert.equal(sellPosition.buyFee, 3)
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
