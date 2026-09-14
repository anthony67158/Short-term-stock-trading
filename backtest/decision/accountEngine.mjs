import {
  A_SHARE_STANDARD_FEE_POLICY,
  assessAshareExecution,
  executionPrice,
  tradeFees,
} from '../../shared/ashareStrategyExecution.js'

export const DECISION_ACCOUNT_SCHEMA_VERSION =
  'decision-account.v1'
export const DECISION_ACCOUNT_POLICY_VERSION =
  'decision-account-policy.v1'

const OPEN_ORDER_STATES = new Set(['OPEN', 'PARTIALLY_FILLED'])

const cents = (value) => Math.round(Number(value) * 100)
const money = (value) => Math.round(Number(value)) / 100

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function dateKey(value) {
  const compact = String(value || '').replaceAll('-', '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function sharesFor(order) {
  const explicit = Math.trunc(finite(order.quantityShares) || 0)
  if (explicit > 0) return explicit
  return Math.max(0, Math.trunc(finite(order.lots) || 0)) * 100
}

function minimumBuyShares(code) {
  return /^68[89]/.test(String(code || '')) ? 200 : 100
}

function estimatedBuyCashCents(order, slippageBps, feePolicy) {
  const quantity = sharesFor(order)
  const reference = finite(order.referencePrice)
  if (!(reference > 0) || quantity <= 0) return 0
  const price = executionPrice(reference, 'BUY', slippageBps)
  const gross = price * quantity
  return cents(gross + tradeFees('BUY', gross, feePolicy).total)
}

function openReservedCashCents(orders) {
  return orders
    .filter((order) => (
      order.side === 'BUY'
      && OPEN_ORDER_STATES.has(order.status)
    ))
    .reduce(
      (sum, order) => sum + Math.max(0, order.reservedCashCents || 0),
      0,
    )
}

function normalizePolicy(policy = {}) {
  const slippageBps = finite(policy.slippageBps) ?? 5
  const stopExecution = String(
    policy.stopExecution || 'INTRADAY_STOP',
  ).toUpperCase()
  if (!(slippageBps >= 0)) throw new Error('INVALID_SLIPPAGE')
  if (!['INTRADAY_STOP', 'NEXT_OPEN'].includes(stopExecution)) {
    throw new Error('INVALID_STOP_EXECUTION')
  }
  return {
    schemaVersion: DECISION_ACCOUNT_POLICY_VERSION,
    slippageBps,
    stopExecution,
    tPlusOne: policy.tPlusOne !== false,
    feePolicy: {
      ...A_SHARE_STANDARD_FEE_POLICY,
      ...(policy.feePolicy || {}),
    },
  }
}

function refreshBalances(state) {
  state.reservedCashCents = openReservedCashCents(state.orders)
  state.availableCashCents = state.cashCents - state.reservedCashCents
}

function validateState(state) {
  if (state?.schemaVersion !== DECISION_ACCOUNT_SCHEMA_VERSION) {
    throw new Error('DECISION_ACCOUNT_VERSION_MISMATCH')
  }
  if (
    !Number.isInteger(state.cashCents)
    || !Number.isInteger(state.reservedCashCents)
    || !Number.isInteger(state.availableCashCents)
    || state.cashCents < 0
    || state.reservedCashCents < 0
    || state.availableCashCents < 0
  ) {
    throw new Error('DECISION_ACCOUNT_CASH_INVARIANT')
  }
}

function positionOf(state, code) {
  return state.positions[String(code || '')] || null
}

function sellableShares(position, tradeDate, tPlusOne) {
  if (!position) return 0
  return position.layers.reduce((sum, layer) => (
    !tPlusOne || layer.acquiredDate < tradeDate
      ? sum + layer.quantityShares
      : sum
  ), 0)
}

function consumeFifo(position, quantityShares, tradeDate, tPlusOne) {
  let remaining = quantityShares
  let costCents = 0
  for (const layer of position.layers) {
    if (remaining <= 0) break
    if (tPlusOne && layer.acquiredDate >= tradeDate) continue
    const matched = Math.min(remaining, layer.quantityShares)
    const allocated = Math.round(
      layer.costCents * matched / layer.quantityShares,
    )
    layer.quantityShares -= matched
    layer.costCents -= allocated
    costCents += allocated
    remaining -= matched
  }
  position.layers = position.layers.filter(
    (layer) => layer.quantityShares > 0,
  )
  return {
    consumedShares: quantityShares - remaining,
    costCents,
  }
}

function appendEvent(state, event) {
  state.events.push({
    sequence: state.events.length + 1,
    ...event,
  })
}

function executeOrder(state, order, bar) {
  const position = positionOf(state, order.code)
  const sellable = sellableShares(
    position,
    bar.date,
    state.policy.tPlusOne,
  )
  const requested = order.remainingShares
  const quantity = order.side === 'SELL'
    ? Math.min(requested, sellable)
    : requested
  if (order.side === 'SELL' && quantity <= 0) {
    appendEvent(state, {
      date: bar.date,
      code: order.code,
      orderId: order.orderId,
      type: 'ORDER_BLOCKED',
      reason: position ? 'T_PLUS_ONE_LOCKED' : 'NO_POSITION',
    })
    return
  }
  const acquiredDate = order.side === 'SELL'
    ? position.layers.find((layer) => (
        !state.policy.tPlusOne || layer.acquiredDate < bar.date
      ))?.acquiredDate
    : bar.date
  const outcome = assessAshareExecution({
    side: order.side,
    security: order.security,
    tradeDate: bar.date,
    acquiredDate,
    previousClose: bar.previousClose,
    openPrice: bar.executionPrice,
    volume: bar.volume,
    quantity,
    lotSize: 100,
    slippageBps: state.policy.slippageBps,
    tPlusOne: state.policy.tPlusOne,
    feePolicy: state.policy.feePolicy,
  })
  if (!outcome.fillable) {
    appendEvent(state, {
      date: bar.date,
      code: order.code,
      orderId: order.orderId,
      type: 'ORDER_BLOCKED',
      reason: outcome.reason,
    })
    return
  }
  const cashFlowCents = cents(outcome.cashFlow)
  if (
    order.side === 'BUY'
    && state.cashCents + cashFlowCents
      < state.reservedCashCents - order.reservedCashCents
  ) {
    appendEvent(state, {
      date: bar.date,
      code: order.code,
      orderId: order.orderId,
      type: 'ORDER_BLOCKED',
      reason: 'INSUFFICIENT_CASH',
    })
    return
  }

  let costBasisCents = 0
  if (order.side === 'BUY') {
    const next = position || {
      code: order.code,
      security: order.security,
      layers: [],
      stopPrice: order.stopPrice,
      pendingStopFrom: null,
    }
    next.layers.push({
      acquiredDate: bar.date,
      quantityShares: quantity,
      fillPrice: outcome.fillPrice,
      costCents: -cashFlowCents,
    })
    if (order.stopPrice > 0) {
      next.stopPrice = next.stopPrice > 0
        ? Math.max(next.stopPrice, order.stopPrice)
        : order.stopPrice
    }
    state.positions[order.code] = next
  } else {
    const consumed = consumeFifo(
      position,
      quantity,
      bar.date,
      state.policy.tPlusOne,
    )
    costBasisCents = consumed.costCents
    if (!position.layers.length) delete state.positions[order.code]
  }

  state.cashCents += cashFlowCents
  state.feesCents += cents(outcome.fees.total)
  const realizedPnlCents = order.side === 'SELL'
    ? cashFlowCents - costBasisCents
    : 0
  state.realizedPnlCents += realizedPnlCents
  order.filledShares += quantity
  order.remainingShares -= quantity
  order.status = order.remainingShares > 0
    ? 'PARTIALLY_FILLED'
    : 'FILLED'
  order.reservedCashCents = order.side === 'BUY' && order.remainingShares > 0
    ? Math.round(
        order.initialReservedCashCents
        * order.remainingShares
        / order.quantityShares,
      )
    : 0
  state.fills.push({
    sequence: state.fills.length + 1,
    orderId: order.orderId,
    code: order.code,
    side: order.side,
    date: bar.date,
    quantityShares: quantity,
    fillPrice: outcome.fillPrice,
    grossAmountCents: cents(outcome.grossAmount),
    feeCents: cents(outcome.fees.total),
    cashFlowCents,
    costBasisCents,
    realizedPnlCents,
    reason: order.reason,
    ruleVersion: outcome.ruleVersion,
  })
}

function riskExitOrder(position, date) {
  const quantityShares = position.layers.reduce(
    (sum, layer) => sum + layer.quantityShares,
    0,
  )
  return {
    orderId: `risk-exit:${position.code}:${date}`,
    code: position.code,
    security: position.security,
    side: 'SELL',
    submittedDate: date,
    eligibleDate: date,
    quantityShares,
    filledShares: 0,
    remainingShares: quantityShares,
    referencePrice: position.stopPrice,
    stopPrice: position.stopPrice,
    reason: 'RISK_EXIT',
    status: 'OPEN',
    initialReservedCashCents: 0,
    reservedCashCents: 0,
  }
}

export function createDecisionAccount({
  initialCash = 100000,
  policy = {},
} = {}) {
  const initialCashCents = cents(initialCash)
  if (!Number.isInteger(initialCashCents) || initialCashCents <= 0) {
    throw new Error('INVALID_INITIAL_CASH')
  }
  return {
    schemaVersion: DECISION_ACCOUNT_SCHEMA_VERSION,
    policy: normalizePolicy(policy),
    initialCashCents,
    cashCents: initialCashCents,
    reservedCashCents: 0,
    availableCashCents: initialCashCents,
    feesCents: 0,
    realizedPnlCents: 0,
    positions: {},
    orders: [],
    fills: [],
    events: [],
    curve: [],
  }
}

export function submitDecisionOrder(input, order = {}) {
  const state = structuredClone(input)
  validateState(state)
  const code = String(order.code || '')
  const side = String(order.side || '').toUpperCase()
  const submittedDate = dateKey(order.submittedDate)
  const quantityShares = sharesFor(order)
  const referencePrice = finite(order.referencePrice)
  if (
    !/^\d{6}$/.test(code)
    || !['BUY', 'SELL'].includes(side)
    || !submittedDate
    || !(referencePrice > 0)
    || quantityShares <= 0
    || (
      side === 'BUY'
      && (
        quantityShares % 100 !== 0
        || quantityShares < minimumBuyShares(code)
      )
    )
  ) {
    throw new Error('INVALID_DECISION_ORDER')
  }
  const orderId = String(order.orderId || '').trim()
  if (!orderId || state.orders.some((item) => item.orderId === orderId)) {
    throw new Error('DUPLICATE_OR_MISSING_ORDER_ID')
  }
  const reservedCashCents = side === 'BUY'
    ? estimatedBuyCashCents(
        { ...order, quantityShares },
        state.policy.slippageBps,
        state.policy.feePolicy,
      )
    : 0
  if (reservedCashCents > state.availableCashCents) {
    throw new Error('INSUFFICIENT_AVAILABLE_CASH')
  }
  state.orders.push({
    orderId,
    code,
    security: {
      code,
      name: String(order.security?.name || ''),
    },
    side,
    submittedDate,
    eligibleDate: dateKey(order.eligibleDate) || submittedDate,
    quantityShares,
    filledShares: 0,
    remainingShares: quantityShares,
    referencePrice,
    stopPrice: finite(order.stopPrice),
    reason: String(order.reason || '').slice(0, 120),
    status: 'OPEN',
    initialReservedCashCents: reservedCashCents,
    reservedCashCents,
  })
  refreshBalances(state)
  validateState(state)
  return state
}

export function cancelDecisionOrder(input, orderId, date = null) {
  const state = structuredClone(input)
  validateState(state)
  const order = state.orders.find((item) => item.orderId === orderId)
  if (!order || !OPEN_ORDER_STATES.has(order.status)) return state
  order.status = 'CANCELED'
  order.reservedCashCents = 0
  appendEvent(state, {
    date: dateKey(date),
    code: order.code,
    orderId,
    type: 'ORDER_CANCELED',
    reason: 'USER_OR_POLICY_CANCEL',
  })
  refreshBalances(state)
  return state
}

export function processDecisionBar(input, rawBar = {}) {
  const state = structuredClone(input)
  validateState(state)
  const date = dateKey(rawBar.date)
  const code = String(rawBar.code || '')
  const open = finite(rawBar.open)
  const low = finite(rawBar.low)
  const close = finite(rawBar.close)
  const previousClose = finite(rawBar.previousClose ?? rawBar.preClose)
  const volume = finite(rawBar.volume ?? rawBar.vol)
  if (
    !date
    || !/^\d{6}$/.test(code)
    || !(open > 0)
    || !(low > 0)
    || !(close > 0)
    || !(previousClose > 0)
    || !(volume >= 0)
  ) {
    throw new Error('INVALID_DECISION_BAR')
  }

  const position = positionOf(state, code)
  if (position?.pendingStopFrom && position.pendingStopFrom < date) {
    const hasOpenRiskExit = state.orders.some((order) => (
      order.code === code
      && order.reason === 'RISK_EXIT'
      && OPEN_ORDER_STATES.has(order.status)
    ))
    if (!hasOpenRiskExit) {
      state.orders.push(riskExitOrder(position, date))
    }
    position.pendingStopFrom = null
  }

  for (const order of state.orders) {
    if (
      order.code !== code
      || !OPEN_ORDER_STATES.has(order.status)
      || order.eligibleDate > date
    ) continue
    executeOrder(state, order, {
      date,
      executionPrice: open,
      previousClose,
      volume,
    })
    refreshBalances(state)
  }

  const current = positionOf(state, code)
  if (
    current
    && current.stopPrice > 0
    && low <= current.stopPrice
  ) {
    const hasOpenRiskExit = state.orders.some((order) => (
      order.code === code
      && order.reason === 'RISK_EXIT'
      && OPEN_ORDER_STATES.has(order.status)
    ))
    if (
      state.policy.stopExecution === 'NEXT_OPEN'
      && !hasOpenRiskExit
    ) {
      current.pendingStopFrom ||= date
    } else if (!hasOpenRiskExit) {
      const order = riskExitOrder(current, date)
      state.orders.push(order)
      executeOrder(state, order, {
        date,
        executionPrice: Math.min(open, current.stopPrice),
        previousClose,
        volume,
      })
      refreshBalances(state)
    }
  }

  const marked = positionOf(state, code)
  if (marked) marked.lastPrice = close
  validateState(state)
  return state
}

export function markDecisionAccount(input, {
  date,
  prices = {},
} = {}) {
  const state = structuredClone(input)
  validateState(state)
  const normalizedDate = dateKey(date)
  if (!normalizedDate) throw new Error('INVALID_MARK_DATE')
  let holdingsCents = 0
  const positions = {}
  for (const [code, position] of Object.entries(state.positions)) {
    const price = finite(prices[code] ?? position.lastPrice)
    if (!(price > 0)) throw new Error(`UNPRICED_POSITION:${code}`)
    const quantityShares = position.layers.reduce(
      (sum, layer) => sum + layer.quantityShares,
      0,
    )
    const marketValueCents = cents(price * quantityShares)
    holdingsCents += marketValueCents
    positions[code] = { quantityShares, price, marketValueCents }
  }
  const row = {
    date: normalizedDate,
    cashCents: state.cashCents,
    reservedCashCents: state.reservedCashCents,
    availableCashCents: state.availableCashCents,
    holdingsCents,
    equityCents: state.cashCents + holdingsCents,
    feesCents: state.feesCents,
    positions,
  }
  state.curve.push(row)
  return state
}

export function decisionAccountView(state) {
  validateState(state)
  return {
    cash: money(state.cashCents),
    reservedCash: money(state.reservedCashCents),
    availableCash: money(state.availableCashCents),
    fees: money(state.feesCents),
    realizedPnl: money(state.realizedPnlCents),
  }
}
