import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cancelDecisionOrder,
  createDecisionAccount,
  markDecisionAccount,
  processDecisionBar,
  submitDecisionOrder,
} from '../backtest/decision/accountEngine.mjs'
import {
  auditDecisionAccount,
} from '../backtest/decision/ledgerAudit.mjs'

const SECURITY = { code: '600001', name: '主板样本' }

function order(overrides = {}) {
  return {
    orderId: 'order-1',
    code: SECURITY.code,
    security: SECURITY,
    side: 'BUY',
    submittedDate: '20260901',
    quantityShares: 100,
    referencePrice: 10,
    ...overrides,
  }
}

function bar(overrides = {}) {
  return {
    date: '20260901',
    code: SECURITY.code,
    previousClose: 10,
    open: 10,
    low: 9.8,
    close: 10.1,
    volume: 100000,
    ...overrides,
  }
}

function buyPosition({
  initialCash = 100000,
  policy,
  buyOrder = {},
  buyBar = {},
} = {}) {
  let state = createDecisionAccount({ initialCash, policy })
  state = submitDecisionOrder(state, order(buyOrder))
  return processDecisionBar(state, bar(buyBar))
}

test('未完成买单冻结现金，撤单后释放且不改变现金余额', () => {
  const initial = createDecisionAccount({ initialCash: 100000 })
  const submitted = submitDecisionOrder(initial, order())

  assert.equal(submitted.cashCents, 10000000)
  assert.equal(submitted.reservedCashCents, 100551)
  assert.equal(submitted.availableCashCents, 9899449)

  const canceled = cancelDecisionOrder(
    submitted,
    'order-1',
    '20260901',
  )
  assert.equal(canceled.cashCents, 10000000)
  assert.equal(canceled.reservedCashCents, 0)
  assert.equal(canceled.availableCashCents, 10000000)
})

test('买入只接受整数手且科创板首次买入至少200股，卖出允许零股', () => {
  const state = createDecisionAccount()
  assert.throws(
    () => submitDecisionOrder(state, order({ quantityShares: 150 })),
    /INVALID_DECISION_ORDER/,
  )
  assert.throws(
    () => submitDecisionOrder(state, order({
      code: '688001',
      security: { code: '688001', name: '科创板样本' },
      quantityShares: 100,
    })),
    /INVALID_DECISION_ORDER/,
  )
  assert.doesNotThrow(() => submitDecisionOrder(state, order({
    code: '688001',
    security: { code: '688001', name: '科创板样本' },
    quantityShares: 200,
  })))
  assert.doesNotThrow(() => submitDecisionOrder(state, order({
    orderId: 'odd-sell',
    side: 'SELL',
    quantityShares: 50,
  })))
})

test('卖单在停牌或跌停未成交时不提前释放持仓或增加现金', () => {
  const bought = buyPosition()
  const cashAfterBuy = bought.cashCents
  const positionBeforeSell = structuredClone(
    bought.positions[SECURITY.code],
  )
  let state = submitDecisionOrder(bought, order({
    orderId: 'sell-1',
    side: 'SELL',
    submittedDate: '20260902',
    referencePrice: 9,
  }))

  state = processDecisionBar(state, bar({
    date: '20260902',
    previousClose: 10,
    open: 9,
    low: 9,
    close: 9,
  }))
  assert.equal(state.cashCents, cashAfterBuy)
  assert.deepEqual(
    state.positions[SECURITY.code].layers,
    positionBeforeSell.layers,
  )
  assert.equal(state.orders.at(-1).status, 'OPEN')
  assert.equal(state.events.at(-1).reason, 'LIMIT_DOWN_UNFILLED')

  state = processDecisionBar(state, bar({
    date: '20260903',
    previousClose: 9,
    open: 9,
    low: 9,
    close: 9,
    volume: 0,
  }))
  assert.equal(state.cashCents, cashAfterBuy)
  assert.ok(state.positions[SECURITY.code])
  assert.equal(state.events.at(-1).reason, 'SUSPENDED_OR_NO_LIQUIDITY')
})

test('同日卖出受T+1阻断，下一交易日按FIFO部分卖出并累计净盈亏', () => {
  let state = createDecisionAccount()
  state = submitDecisionOrder(state, order({
    orderId: 'buy-1',
    quantityShares: 100,
  }))
  state = submitDecisionOrder(state, order({
    orderId: 'sell-same-day',
    side: 'SELL',
    quantityShares: 100,
  }))
  state = processDecisionBar(state, bar())
  assert.equal(state.orders[1].status, 'OPEN')
  assert.equal(state.events.at(-1).reason, 'T_PLUS_ONE_LOCKED')
  state = cancelDecisionOrder(
    state,
    'sell-same-day',
    '20260901',
  )

  state = submitDecisionOrder(state, order({
    orderId: 'buy-2',
    submittedDate: '20260902',
    quantityShares: 100,
    referencePrice: 11,
  }))
  state = processDecisionBar(state, bar({
    date: '20260902',
    previousClose: 10.1,
    open: 11,
    low: 10.8,
    close: 11,
  }))
  state = submitDecisionOrder(state, order({
    orderId: 'sell-fifo',
    side: 'SELL',
    submittedDate: '20260903',
    quantityShares: 100,
    referencePrice: 11,
  }))
  state = processDecisionBar(state, bar({
    date: '20260903',
    previousClose: 11,
    open: 11,
    low: 10.9,
    close: 11,
  }))
  assert.equal(state.positions[SECURITY.code].layers.length, 1)
  assert.equal(
    state.positions[SECURITY.code].layers[0].acquiredDate,
    '20260902',
  )
  const sellFill = state.fills.find(
    (fill) => fill.orderId === 'sell-fifo',
  )
  assert.equal(state.realizedPnlCents, sellFill.realizedPnlCents)
})

test('涨停买入和停牌买入保持挂单且继续冻结现金', () => {
  let state = createDecisionAccount()
  state = submitDecisionOrder(state, order())
  const reserved = state.reservedCashCents

  state = processDecisionBar(state, bar({
    open: 11,
    low: 11,
    close: 11,
  }))
  assert.equal(state.orders[0].status, 'OPEN')
  assert.equal(state.reservedCashCents, reserved)
  assert.equal(state.events.at(-1).reason, 'LIMIT_UP_UNFILLED')

  state = processDecisionBar(state, bar({
    date: '20260902',
    previousClose: 11,
    open: 11,
    low: 11,
    close: 11,
    volume: 0,
  }))
  assert.equal(state.orders[0].status, 'OPEN')
  assert.equal(state.reservedCashCents, reserved)
  assert.equal(state.events.at(-1).reason, 'SUSPENDED_OR_NO_LIQUIDITY')
})

test('日内止损在跳空低于止损价时按更差开盘价成交', () => {
  let state = buyPosition({
    buyOrder: {
      referencePrice: 11,
      stopPrice: 10,
    },
    buyBar: {
      previousClose: 11,
      open: 11,
      low: 10.5,
      close: 11,
    },
  })
  state = processDecisionBar(state, bar({
    date: '20260902',
    previousClose: 11,
    open: 9.95,
    low: 9.8,
    close: 9.9,
  }))

  const exit = state.fills.at(-1)
  assert.equal(exit.reason, 'RISK_EXIT')
  assert.equal(exit.fillPrice, 9.945025)
  assert.equal(state.positions[SECURITY.code], undefined)
  assert.equal(state.realizedPnlCents, exit.realizedPnlCents)
})

test('双倍滑点压力情景使用10bps且结果可重复', () => {
  const first = buyPosition({ policy: { slippageBps: 10 } })
  const second = buyPosition({ policy: { slippageBps: 10 } })

  assert.equal(first.fills[0].fillPrice, 10.01)
  assert.deepEqual(first, second)
})

test('NEXT_OPEN止损只在下一交易日开盘退出', () => {
  let state = buyPosition({
    policy: { stopExecution: 'NEXT_OPEN' },
    buyOrder: { stopPrice: 9.5 },
  })
  state = processDecisionBar(state, bar({
    date: '20260902',
    previousClose: 10.1,
    open: 10,
    low: 9.4,
    close: 9.6,
  }))
  assert.equal(state.fills.length, 1)
  assert.equal(
    state.positions[SECURITY.code].pendingStopFrom,
    '20260902',
  )

  state = processDecisionBar(state, bar({
    date: '20260903',
    previousClose: 9.6,
    open: 9.2,
    low: 9.1,
    close: 9.3,
  }))
  assert.equal(state.fills.at(-1).reason, 'RISK_EXIT')
  assert.equal(state.fills.at(-1).fillPrice, 9.1954)
  assert.equal(state.positions[SECURITY.code], undefined)
})

test('NEXT_OPEN止损跌停未成交时只保留一个退出订单', () => {
  let state = buyPosition({
    policy: { stopExecution: 'NEXT_OPEN' },
    buyOrder: { stopPrice: 9.5 },
  })
  state = processDecisionBar(state, bar({
    date: '20260902',
    previousClose: 10.1,
    open: 10,
    low: 9.4,
    close: 9.6,
  }))
  state = processDecisionBar(state, bar({
    date: '20260903',
    previousClose: 10,
    open: 9,
    low: 9,
    close: 9,
  }))
  state = processDecisionBar(state, bar({
    date: '20260904',
    previousClose: 10,
    open: 9,
    low: 9,
    close: 9,
  }))

  const riskOrders = state.orders.filter(
    (item) => item.reason === 'RISK_EXIT',
  )
  assert.equal(riskOrders.length, 1)
  assert.equal(riskOrders[0].status, 'OPEN')
})

test('独立账本按分复算现金、FIFO成本、费用、持仓和日终权益', () => {
  let state = buyPosition()
  state = markDecisionAccount(state, {
    date: '20260901',
    prices: { [SECURITY.code]: 10.1 },
  })
  state = submitDecisionOrder(state, order({
    orderId: 'sell-audit',
    side: 'SELL',
    submittedDate: '20260902',
    referencePrice: 10.5,
  }))
  state = processDecisionBar(state, bar({
    date: '20260902',
    previousClose: 10.1,
    open: 10.5,
    low: 10.4,
    close: 10.5,
  }))
  state = markDecisionAccount(state, {
    date: '20260902',
  })

  const audit = auditDecisionAccount(state)
  assert.equal(audit.ok, true)
  assert.deepEqual(audit.errors, [])
  assert.equal(audit.summary.cashCents, state.cashCents)
  assert.equal(audit.summary.feesCents, state.feesCents)
  assert.equal(
    audit.summary.realizedPnlCents,
    state.realizedPnlCents,
  )
  assert.equal(state.curve.at(-1).equityCents, state.cashCents)

  const corrupted = structuredClone(state)
  corrupted.curve[0].equityCents += 1
  const failed = auditDecisionAccount(corrupted)
  assert.equal(failed.ok, false)
  assert.ok(failed.errors.some(
    (item) => item.code === 'CURVE_EQUITY_MISMATCH',
  ))
})
