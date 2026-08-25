import { executionTriggerDirection } from './executionTrigger.js'
import { sanitizedAdvicePriceContract } from './advicePriceContract.js'

export const EXECUTION_PLAN_SCHEMA_VERSION = 'execution-plan.v1'

export const EXECUTION_PLAN_STATES = Object.freeze([
  'DRAFT',
  'ARMED',
  'ALERTED',
  'USER_CONFIRMED',
  'PARTIALLY_RECORDED',
  'COMPLETED',
  'CANCELED',
  'EXPIRED',
])

const TERMINAL = new Set(['COMPLETED', 'CANCELED', 'EXPIRED'])
const TRANSITIONS = Object.freeze({
  DRAFT: new Set(['ARMED', 'CANCELED', 'EXPIRED']),
  ARMED: new Set(['ALERTED', 'CANCELED', 'EXPIRED']),
  ALERTED: new Set(['ARMED', 'USER_CONFIRMED', 'CANCELED', 'EXPIRED']),
  USER_CONFIRMED: new Set([
    'PARTIALLY_RECORDED',
    'COMPLETED',
    'CANCELED',
    'EXPIRED',
  ]),
  PARTIALLY_RECORDED: new Set([
    'PARTIALLY_RECORDED',
    'COMPLETED',
    'CANCELED',
    'EXPIRED',
  ]),
  COMPLETED: new Set(),
  CANCELED: new Set(),
  EXPIRED: new Set(),
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function positive(value) {
  const number = finite(value)
  return number != null && number > 0 ? number : null
}

function integerLots(value) {
  const number = Math.trunc(finite(value) || 0)
  return number > 0 ? number : 0
}

function hashText(value) {
  let hash = 2166136261
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function actionSide(action) {
  return ['BUY', 'ADD', 'T_BUY_FIRST'].includes(action)
    ? 'BUY'
    : ['REDUCE', 'EXIT', 'T_SELL_FIRST'].includes(action)
      ? 'SELL'
      : 'NONE'
}

function reliableVolumeCurve(value) {
  if (!Array.isArray(value) || value.length < 4) return false
  const values = value.map(Number)
  if (values.some((item) => !Number.isFinite(item) || item < 0)) {
    return false
  }
  const total = values.reduce((sum, item) => sum + item, 0)
  return total > 0.98 && total < 1.02
}

export function selectExecutionMethod({
  lots,
  referencePrice,
  estimatedNetAmount,
  adv20,
  volumeCurve,
  urgency = 'NORMAL',
  timeWindowMinutes = 60,
} = {}) {
  const targetLots = integerLots(lots)
  const price = positive(referencePrice) || 0
  const notional = positive(estimatedNetAmount)
    || targetLots * 100 * price
  const dailyAmount = positive(adv20)
  const participation = dailyAmount
    ? notional / dailyAmount
    : null
  const volumeCurveReliable = reliableVolumeCurve(volumeCurve)

  if (targetLots <= 1 || (
    notional <= 50_000
    && (participation == null || participation <= 0.005)
  )) {
    return {
      type: 'SINGLE_LIMIT',
      label: '单笔限价',
      volumeCurveReliable,
      participationRate: participation,
    }
  }
  if (
    volumeCurveReliable
    && participation != null
    && participation >= 0.02
  ) {
    return {
      type: 'VWAP_REFERENCE',
      label: '跟量参考',
      volumeCurveReliable: true,
      participationRate: participation,
    }
  }
  if (
    String(urgency).toUpperCase() === 'HIGH'
    && Number(timeWindowMinutes) >= 20
  ) {
    return {
      type: 'TWAP_REFERENCE',
      label: '时间均分参考',
      volumeCurveReliable,
      participationRate: participation,
    }
  }
  if (
    notional >= 500_000
    && String(urgency).toUpperCase() === 'LOW'
  ) {
    return {
      type: 'ICEBERG_REFERENCE',
      label: '隐蔽分批参考',
      volumeCurveReliable,
      participationRate: participation,
    }
  }
  return {
    type: 'SLICED_LIMIT',
    label: '分批执行',
    volumeCurveReliable,
    participationRate: participation,
  }
}

function splitLots(totalLots, count) {
  const total = integerLots(totalLots)
  const size = Math.max(1, Math.min(total, Math.trunc(count) || 1))
  const base = Math.floor(total / size)
  let remainder = total % size
  return Array.from({ length: size }, (_, index) => {
    const lots = base + (remainder > 0 ? 1 : 0)
    remainder = Math.max(0, remainder - 1)
    return { sequence: index + 1, lots }
  })
}

function slicesFor(planId, method, lots, referencePrice, now, windowMinutes) {
  const count = method.type === 'SINGLE_LIMIT'
    ? 1
    : Math.max(2, Math.min(4, Math.ceil(lots / 2)))
  const spacingMs = Math.max(
    5,
    Math.floor((Number(windowMinutes) || 60) / count),
  ) * 60000
  return splitLots(lots, count).map((slice, index) => ({
    sliceId: `${planId}:slice:${slice.sequence}`,
    sequence: slice.sequence,
    lots: slice.lots,
    limitPrice: referencePrice,
    notBefore: new Date(now + index * spacingMs).toISOString(),
    condition: index === 0
      ? '触发条件成立后执行'
      : '前一批已记录且价格条件仍有效',
    status: 'PENDING',
  }))
}

export function compileExecutionPlan({
  decisionPlan,
  code,
  name = '',
  accountRevision = null,
  accountTradeFingerprint = '',
  adv20 = null,
  volumeCurve = null,
  urgency = 'NORMAL',
  timeWindowMinutes = 60,
  now = Date.now(),
} = {}) {
  if (decisionPlan?.schemaVersion !== 'decision-plan.v2') {
    throw new Error('execution-plan.v1只接受decision-plan.v2')
  }
  const action = String(decisionPlan.action || 'WATCH')
  const side = actionSide(action)
  const triggerDirection = executionTriggerDirection({
    action,
    trigger: decisionPlan.trigger,
    triggerDirection: decisionPlan.triggerDirection,
  })
  const priceContract = sanitizedAdvicePriceContract({
    priceContract: decisionPlan.priceContract,
  })
  const targetLots = integerLots(decisionPlan.quantity?.lots)
  const referencePrice = positive(decisionPlan.prices?.reference)
  const estimatedNetAmount = positive(
    decisionPlan.costs?.estimatedNetAmount,
  ) || (
    referencePrice && targetLots
      ? referencePrice * targetLots * 100
      : 0
  )
  const method = selectExecutionMethod({
    lots: targetLots,
    referencePrice,
    estimatedNetAmount,
    adv20,
    volumeCurve,
    urgency,
    timeWindowMinutes,
  })
  const canArm = (
    decisionPlan.actionability === 'READY'
    && side !== 'NONE'
    && targetLots > 0
    && referencePrice != null
  )
  const planId = `execution.${hashText([
    decisionPlan.decisionId,
    code,
    accountRevision,
  ].join('|'))}`
  const validUntilMs = Date.parse(decisionPlan.validUntil || '')
  const effectiveValidUntil = Number.isFinite(validUntilMs)
    ? validUntilMs
    : Number(now) + 30 * 60000
  return {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    planId,
    decisionId: String(decisionPlan.decisionId || ''),
    marketRegime: String(decisionPlan.marketRegime?.regime || 'UNKNOWN'),
    code: String(code || ''),
    name: String(name || code || ''),
    action,
    actionLabel: String(decisionPlan.actionLabel || ''),
    side,
    status: 'DRAFT',
    canArm,
    accountRevision: finite(accountRevision),
    accountTradeFingerprint: String(accountTradeFingerprint || ''),
    evidenceAsOf: String(decisionPlan.asOf || ''),
    createdAt: Number(now),
    updatedAt: Number(now),
    validUntil: new Date(effectiveValidUntil).toISOString(),
    targetLots,
    filledLots: 0,
    remainingLots: targetLots,
    referencePrice,
    triggerPrice: referencePrice,
    triggerDirection,
    priceContract,
    stopPrice: positive(decisionPlan.prices?.stop),
    targetPrice: positive(decisionPlan.prices?.target),
    trigger: String(decisionPlan.trigger || ''),
    invalidation: String(decisionPlan.invalidation || ''),
    evidenceIds: Array.isArray(decisionPlan.evidenceIds)
      ? decisionPlan.evidenceIds.slice(0, 12)
      : [],
    estimatedFees: finite(decisionPlan.costs?.estimatedFees) || 0,
    estimatedNetAmount,
    initialReservedCash: side === 'BUY' ? estimatedNetAmount : 0,
    reservedCash: side === 'BUY' ? estimatedNetAmount : 0,
    pendingSellLots: side === 'SELL' ? targetLots : 0,
    expectedNetProceeds: side === 'SELL' ? estimatedNetAmount : 0,
    executionMethod: method,
    slices: slicesFor(
      planId,
      method,
      targetLots,
      referencePrice,
      Number(now),
      timeWindowMinutes,
    ),
    fills: [],
    transitions: [{
      from: null,
      to: 'DRAFT',
      event: 'COMPILED',
      at: Number(now),
    }],
  }
}

function withTransition(plan, status, event, now, detail = '') {
  if (!EXECUTION_PLAN_STATES.includes(status)) {
    throw new Error(`未知执行计划状态:${status}`)
  }
  if (!TRANSITIONS[plan.status]?.has(status)) {
    throw new Error(`不允许从${plan.status}迁移到${status}`)
  }
  return {
    ...plan,
    status,
    updatedAt: Number(now) || Date.now(),
    transitions: [
      ...(plan.transitions || []),
      {
        from: plan.status,
        to: status,
        event,
        detail: String(detail || ''),
        at: Number(now) || Date.now(),
      },
    ].slice(-40),
  }
}

function priceReached(plan, price) {
  const current = positive(price)
  const trigger = positive(plan.triggerPrice)
  if (current == null || trigger == null) return false
  const direction = executionTriggerDirection(plan)
  if (direction === 'IMMEDIATE') return true
  if (direction === 'LTE') return current <= trigger
  if (direction === 'GTE') return current >= trigger
  return false
}

export function transitionExecutionPlan(
  input,
  event,
  {
    now = Date.now(),
    price = null,
    reason = '',
  } = {},
) {
  const plan = structuredClone(input)
  if (plan?.schemaVersion !== EXECUTION_PLAN_SCHEMA_VERSION) {
    throw new Error('执行计划版本无效')
  }
  if (TERMINAL.has(plan.status)) return plan
  if (event === 'ARM') {
    if (!plan.canArm) throw new Error('当前建议不可进入执行队列')
    return withTransition(plan, 'ARMED', event, now, reason)
  }
  if (event === 'PRICE_TRIGGERED') {
    if (!priceReached(plan, price)) return plan
    return withTransition(plan, 'ALERTED', event, now, reason)
  }
  if (event === 'USER_CONFIRM') {
    return withTransition(plan, 'USER_CONFIRMED', event, now, reason)
  }
  if (event === 'CANCEL') {
    return withTransition(plan, 'CANCELED', event, now, reason)
  }
  if (event === 'EXPIRE') {
    return withTransition(plan, 'EXPIRED', event, now, reason)
  }
  throw new Error(`未知执行事件:${event}`)
}

export function refreshExecutionPlan(
  input,
  {
    now = Date.now(),
    accountRevision = null,
    accountTradeFingerprint = '',
    price = null,
  } = {},
) {
  let plan = structuredClone(input)
  if (TERMINAL.has(plan.status)) return plan
  const validUntil = Date.parse(plan.validUntil || '')
  if (Number.isFinite(validUntil) && Number(now) > validUntil) {
    return transitionExecutionPlan(plan, 'EXPIRE', {
      now,
      reason: '计划已超过有效期',
    })
  }
  if (
    plan.accountRevision != null
    && finite(accountRevision) != null
    && Number(plan.accountRevision) !== Number(accountRevision)
  ) {
    return transitionExecutionPlan(plan, 'EXPIRE', {
      now,
      reason: '账户版本已变化，需按最新仓位重算',
    })
  }
  if (
    plan.accountTradeFingerprint
    && accountTradeFingerprint
    && plan.accountTradeFingerprint !== accountTradeFingerprint
  ) {
    return transitionExecutionPlan(plan, 'EXPIRE', {
      now,
      reason: '账户交易账本已变化，旧计划需重新编译',
    })
  }
  if (plan.status === 'ARMED' && priceReached(plan, price)) {
    plan = transitionExecutionPlan(plan, 'PRICE_TRIGGERED', {
      now,
      price,
      reason: `现价${price}已进入执行触发区`,
    })
  }
  const currentPrice = positive(price)
  if (
    plan.status === 'ALERTED'
    && currentPrice != null
    && !priceReached(plan, currentPrice)
  ) {
    plan = withTransition(
      plan,
      'ARMED',
      'PRICE_RESET',
      now,
      `现价${currentPrice}不再满足执行条件`,
    )
  }
  return plan
}

export function recordExecutionFill(input, fill) {
  const plan = structuredClone(input)
  if (!['USER_CONFIRMED', 'PARTIALLY_RECORDED'].includes(plan.status)) {
    throw new Error('计划尚未由用户确认')
  }
  if (fill?.manuallyRecorded !== true) {
    throw new Error('只有用户录入的真实人工成交才能推进计划')
  }
  const fillId = String(fill.fillId || '').trim()
  const lots = integerLots(fill.lots)
  const price = positive(fill.price)
  if (!fillId || !lots || price == null) {
    throw new Error('成交记录缺少有效标识、价格或手数')
  }
  if ((plan.fills || []).some((item) => item.fillId === fillId)) return plan
  if (lots > plan.remainingLots) {
    throw new Error('成交手数超过计划剩余手数')
  }
  const at = Number(fill.at) || Date.now()
  plan.fills = [
    ...(plan.fills || []),
    {
      fillId,
      lots,
      price,
      fee: Math.max(0, finite(fill.fee) || 0),
      at,
      manuallyRecorded: true,
      transactionId: String(fill.transactionId || ''),
      vwap: positive(fill.vwap),
    },
  ]
  plan.filledLots += lots
  plan.remainingLots = Math.max(0, plan.targetLots - plan.filledLots)
  plan.reservedCash = plan.side === 'BUY'
    ? +(plan.initialReservedCash * (
        plan.remainingLots / Math.max(1, plan.targetLots)
      )).toFixed(2)
    : 0
  plan.pendingSellLots = plan.side === 'SELL'
    ? plan.remainingLots
    : 0
  const status = plan.remainingLots > 0
    ? 'PARTIALLY_RECORDED'
    : 'COMPLETED'
  return withTransition(
    plan,
    status,
    'MANUAL_FILL_RECORDED',
    at,
    `${lots}手@${price}`,
  )
}
