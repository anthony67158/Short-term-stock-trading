import test from 'node:test'
import assert from 'node:assert/strict'

import {
  editableTradeIntent,
  tradeIntentLabel,
  tradeIntentOf,
  tradeIntentOptions,
} from '../shared/tradeIntent.js'
import {
  calcBuyFee,
  calcSellFee,
  planStore,
  t1StatusOf,
} from '../src/planStore.js'
import {
  tradeAnalyticsRecords,
  tradeActivityContext,
} from '../shared/portfolioAccounting.js'
import {
  buildHoldPayload,
} from '../api/_portfolio.js'

const DAY = Date.parse('2026-08-17T02:00:00.000Z')

function localDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

test('交易意图兼容旧数据并按买卖方向提供有限选项', () => {
  const buy = { type: 'BUY' }
  const sell = { type: 'SELL', tradeIntent: 't' }
  const paired = { type: 'T', tDir: 'reverse' }

  assert.equal(tradeIntentOf(buy), 'position')
  assert.equal(tradeIntentOf(sell), 't')
  assert.equal(tradeIntentOf(paired), 't')
  assert.equal(editableTradeIntent(buy), true)
  assert.equal(editableTradeIntent(paired), false)
  assert.deepEqual(tradeIntentOptions(buy), [
    { value: 'position', label: '建仓 / 加仓' },
    { value: 't', label: '做T买入' },
  ])
  assert.equal(tradeIntentLabel(sell), '做T卖出')
  assert.equal(tradeIntentLabel(paired), '反T')
})

test('修改为做T买腿只改分类，不改变现金、持仓和T+1真实成交口径', () => {
  const fee = calcBuyFee(1000)
  const cash = 5000
  planStore.setData({
    plan: [],
    holding: [{
      id: 'holding-1',
      code: '000001',
      name: '平安银行',
      buyPrice: 10,
      buyAt: DAY,
      qty: 1,
      buyFee: fee,
    }],
    closed: [{
      id: 'buy-1',
      type: 'BUY',
      tradeIntent: 'position',
      code: '000001',
      name: '平安银行',
      holdingId: 'holding-1',
      qty: 1,
      price: 10,
      fee,
      amount: 1000,
      cashFlow: -(1000 + fee),
      cashApplied: true,
      at: Date.now(),
    }],
    decisionLog: [{
      id: 'exec-1',
      kind: 'execution',
      transactionId: 'buy-1',
      side: 'buy',
      price: 10,
      qty: 1,
      at: Date.now(),
    }],
    account: { cash },
  })

  const result = planStore.updateClosedTrade('buy-1', {
    date: localDateKey(),
    price: 10,
    qty: 1,
    tradeIntent: 't',
  })

  assert.equal(result.ok, true)
  assert.equal(planStore.get().closed[0].tradeIntent, 't')
  assert.equal(planStore.get().holding[0].qty, 1)
  assert.equal(planStore.get().account.cash, cash)
  assert.equal(planStore.get().decisionLog[0].tradeIntent, 't')
  assert.equal(t1StatusOf('000001').buys[0].kind, '做T买腿')
})

test('卖出改为做T腿会同步决策日志并取消普通卖出收益验证', () => {
  const fee = calcSellFee(1100)
  planStore.setData({
    plan: [],
    holding: [{
      id: 'holding-sell',
      code: '000001',
      name: '平安银行',
      buyPrice: 10,
      buyAt: DAY - 86400000,
      qty: 1,
      buyFee: calcBuyFee(2000) / 2,
    }],
    closed: [{
      id: 'sell-1',
      type: 'SELL',
      tradeIntent: 'position',
      code: '000001',
      name: '平安银行',
      holdingId: 'holding-sell',
      qty: 1,
      price: 11,
      costPrice: 10,
      fee,
      realizedPnl: 100 - fee,
      at: Date.now() - 1000,
    }],
    decisionLog: [{
      id: 'exec-sell',
      kind: 'execution',
      transactionId: 'sell-1',
      side: 'sell',
      price: 11,
      qty: 1,
      at: Date.now() - 1000,
      outcome: {
        pnl: 100 - fee,
        validationComplete: true,
      },
    }],
  })

  const result = planStore.updateClosedTrade('sell-1', {
    date: localDateKey(),
    price: 11,
    qty: 1,
    tradeIntent: 't',
  })

  assert.equal(result.ok, true)
  const execution = planStore.get().decisionLog[0]
  assert.equal(execution.tradeIntent, 't')
  assert.equal(execution.outcome.validationComplete, false)
  assert.equal(
    execution.outcome.pnl,
    planStore.get().closed[0].realizedPnl,
  )
})

test('做T分类按同股同交易日FIFO配对且保留未配对净腿', () => {
  const buyFee = calcBuyFee(1800)
  const sellFee = calcSellFee(1000)
  const trades = [{
    id: 't-buy',
    type: 'BUY',
    tradeIntent: 't',
    code: '600000',
    qty: 2,
    price: 9,
    fee: buyFee,
    at: DAY,
  }, {
    id: 't-sell',
    type: 'SELL',
    tradeIntent: 't',
    code: '600000',
    qty: 1,
    price: 10,
    fee: sellFee,
    at: DAY + 3600000,
  }, {
    id: 'reduce',
    type: 'SELL',
    tradeIntent: 'position',
    code: '600000',
    qty: 1,
    price: 11,
    fee: calcSellFee(1100),
    at: DAY + 7200000,
  }]

  const context = tradeActivityContext(trades, '600000')

  assert.equal(context.t.pairCount, 1)
  assert.equal(context.t.openBuyQty, 1)
  assert.equal(context.t.openSellQty, 0)
  assert.equal(
    context.t.realizedPnl,
    +(100 - buyFee / 2 - sellFee).toFixed(2),
  )
  assert.equal(context.recent[0].label, '减仓 / 清仓')
  assert.equal(context.recent[1].label, '做T卖出')

  const analytics = tradeAnalyticsRecords(trades)
  assert.equal(
    analytics.some((record) => record.id === 't-buy'),
    false,
  )
  assert.equal(
    analytics.some((record) => record.id === 't-sell'),
    false,
  )
  assert.equal(
    analytics.filter((record) => record.type === 'T').length,
    1,
  )
  assert.equal(
    analytics.find((record) => record.type === 'T').realizedPnl,
    context.t.realizedPnl,
  )
})

test('跨交易日的做T腿不会错误互相配对', () => {
  const context = tradeActivityContext([{
    id: 'day-one-buy',
    type: 'BUY',
    tradeIntent: 't',
    code: '600000',
    qty: 1,
    price: 9,
    at: DAY,
  }, {
    id: 'day-two-sell',
    type: 'SELL',
    tradeIntent: 't',
    code: '600000',
    qty: 1,
    price: 10,
    at: DAY + 86400000,
  }], '600000')

  assert.equal(context.t.pairCount, 0)
  assert.equal(context.t.openBuyQty, 1)
  assert.equal(context.t.openSellQty, 1)
})

test('流水编辑拒绝非法意图且不允许改写已配对做T类型', () => {
  planStore.setData({
    plan: [],
    holding: [],
    closed: [{
      id: 'paired-t',
      type: 'T',
      kind: 'T',
      code: '600000',
      qty: 1,
      buyPrice: 9,
      sellPrice: 10,
      buyFee: calcBuyFee(900),
      sellFee: calcSellFee(1000),
      at: DAY,
    }],
  })

  assert.equal(planStore.updateClosedTrade('paired-t', {
    date: '2026-08-17',
    buyPrice: 9,
    sellPrice: 10,
    qty: 1,
    tradeIntent: 'position',
  }).ok, false)
})

test('服务端军师载荷携带做T分类、配对收益和待配对手数', () => {
  const holding = [{
    id: 'h1',
    code: '600000',
    name: '浦发银行',
    qty: 2,
    buyPrice: 10,
    buyAt: DAY - 86400000,
  }]
  const closed = [{
    id: 't-buy',
    type: 'BUY',
    tradeIntent: 't',
    code: '600000',
    qty: 1,
    price: 9,
    fee: calcBuyFee(900),
    at: DAY,
  }]
  const payload = buildHoldPayload(
    holding,
    '600000',
    '浦发银行',
    { positions: [], totalAssets: 10000 },
    { cash: 8000 },
    closed,
  )

  assert.equal(payload.tradeContext.t.openBuyQty, 1)
  assert.equal(payload.tradeContext.recent[0].label, '做T买入')
})
