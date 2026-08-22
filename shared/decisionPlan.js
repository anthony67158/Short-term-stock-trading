import {
  A_SHARE_STANDARD_FEE_POLICY,
  executionPrice,
  tradeFees,
} from './ashareStrategyExecution.js'
import { deriveMarketRegime } from './marketRegime.js'
import {
  evaluateStrategySignal,
  getActiveStrategySpec,
} from './strategySpec.js'

export const DECISION_PLAN_SCHEMA_VERSION = 'decision-plan.v2'

const RISK_INCREASING = new Set(['BUY', 'ADD', 'T_BUY_FIRST'])
const RISK_REDUCING = new Set(['REDUCE', 'EXIT', 'T_SELL_FIRST'])

export function decisionPlanConfirmationGate(plan, side) {
  if (plan?.schemaVersion !== DECISION_PLAN_SCHEMA_VERSION) {
    return { allowed: true, policy: 'legacy-advice', reason: '' }
  }
  if (
    side === 'buy'
    && plan.actionability !== 'READY'
  ) {
    const reason = plan.actionability === 'RESEARCH_ONLY'
      ? '当前仅为研究级条件建议，不能升级为执行确认'
      : '统一决策计划未通过，不能升级为执行确认'
    return {
      allowed: false,
      policy: 'decision-plan-not-ready',
      reason,
    }
  }
  if (
    side !== 'buy'
    && plan.actionability === 'BLOCKED'
  ) {
    return {
      allowed: false,
      policy: 'decision-plan-blocked',
      reason: '统一决策计划已阻止本次操作',
    }
  }
  return { allowed: true, policy: 'decision-plan-ready', reason: '' }
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function positive(value) {
  const number = finite(value)
  return number != null && number > 0 ? number : null
}

function round(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function text(value, maximum = 320) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  )
}

function fingerprint(value) {
  const source = JSON.stringify(stable(value))
  let hash = 2166136261
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `decision.${(hash >>> 0).toString(36)}`
}

function lotsOf(value) {
  if (value == null || value === '') return 0
  const match = String(value).replaceAll(',', '').match(/-?\d+(?:\.\d+)?/)
  const number = match ? Number(match[0]) : Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.trunc(number)
    : 0
}

function actionFrom(mode, advice = {}) {
  const value = text(advice.action || advice.stance, 80)
  if (/观望|等待|回避|不建议|暂不/.test(value)) return 'WATCH'
  if (/清仓|卖出|止损|离场/.test(value)) return 'EXIT'
  if (/减仓|止盈/.test(value)) return 'REDUCE'
  if (/加仓|补仓|接回|买回/.test(value)) return 'ADD'
  if (/持有|不动|无需操作/.test(value)) return 'HOLD'
  if (mode === 't_advice') {
    if (advice.dir === 'reverse') return 'T_SELL_FIRST'
    if (advice.dir === 'positive') return 'T_BUY_FIRST'
    return 'WATCH'
  }
  if (
    mode === 'buy_advice'
    || /买入|建仓|试错|试仓|回调再买/.test(value)
  ) return 'BUY'
  return 'WATCH'
}

function actionLabel(action) {
  return {
    BUY: '买入',
    ADD: '加仓',
    HOLD: '持有',
    REDUCE: '减仓',
    EXIT: '退出',
    T_BUY_FIRST: '正T先买',
    T_SELL_FIRST: '反T先卖',
    WATCH: '观望',
  }[action] || '观望'
}

function referencePriceFor(action, advice = {}, payload = {}) {
  if (action === 'BUY') return positive(advice.buyPrice)
  if (action === 'ADD') return positive(advice.addPrice ?? advice.buyPrice)
  if (action === 'REDUCE') {
    return positive(advice.reducePrice ?? advice.targetPrice)
  }
  if (action === 'EXIT') {
    return positive(advice.stopPrice ?? advice.reducePrice)
  }
  if (action === 'T_BUY_FIRST' || action === 'T_SELL_FIRST') {
    return positive(advice.leg1Price)
  }
  return positive(payload.todayQuote?.price)
}

function requestedLotsFor(action, advice = {}) {
  if (action === 'BUY') return lotsOf(advice.planQtyNum ?? advice.planQty)
  if (action === 'ADD' || action === 'REDUCE' || action === 'EXIT') {
    return lotsOf(advice.opQty)
  }
  if (action === 'T_BUY_FIRST' || action === 'T_SELL_FIRST') {
    return lotsOf(advice.suggestQty)
  }
  return 0
}

function signalContext(payload = {}, market = {}) {
  const quote = payload.todayQuote || {}
  const quant = payload.quant || {}
  return {
    amount: finite(quote.amount),
    mainRatio: finite(payload.stockFund?.mainRatio),
    marketEnv: { score: finite(market.score) },
    marketScore: finite(market.score),
    pct: finite(quote.pct),
    quant: {
      expRet: finite(quant.forecast?.expRet),
      highConfFired: quant.highConfSignal?.fired === true,
      score: finite(quant.score),
      upProb: finite(quant.forecast?.upProb),
    },
    speed: finite(quote.speed),
    turnover: finite(quote.turnover),
    volRatio: finite(quote.volRatio),
  }
}

function computeBuyCapacity({
  requestedLots,
  referencePrice,
  stopPrice,
  account,
  market,
  slippageBps,
  productionEligible,
  highConfidence,
}) {
  const totalAssets = positive(account.totalAssets)
  const cash = Math.max(0, finite(account.cash) || 0)
  const currentPosition = Math.max(0, finite(account.position) || 0)
  const currentStockWeight = Math.max(0, finite(account.stockWeight) || 0)
  const configuredStockLimit = positive(account.maxStockWeight) || 20
  const stockLimit = Math.min(20, configuredStockLimit)
  const marketPositionLimit = Math.min(
    85,
    positive(market.targetPositionPct?.max) || 0,
  )
  const riskPct = (
    productionEligible && highConfidence ? 1 : 0.6
  ) * (finite(market.riskMultiplier) ?? 0)
  const maxLossAmount = totalAssets == null
    ? null
    : round(totalAssets * riskPct / 100)

  const entryFill = executionPrice(referencePrice, 'BUY', slippageBps)
  const stopFill = executionPrice(stopPrice, 'SELL', slippageBps)
  const oneLotEntryGross = entryFill * 100
  const oneLotExitGross = stopFill * 100
  const oneLotEntryFees = tradeFees(
    'BUY',
    oneLotEntryGross,
    A_SHARE_STANDARD_FEE_POLICY,
  ).total
  const oneLotExitFees = tradeFees(
    'SELL',
    oneLotExitGross,
    A_SHARE_STANDARD_FEE_POLICY,
  ).total
  const lossPerLot = Math.max(
    0,
    oneLotEntryGross + oneLotEntryFees
      - oneLotExitGross + oneLotExitFees,
  )
  const riskLots = maxLossAmount != null && lossPerLot > 0
    ? Math.floor(maxLossAmount / lossPerLot)
    : 0
  const stockCapacity = totalAssets == null
    ? 0
    : Math.max(0, (stockLimit - currentStockWeight) / 100 * totalAssets)
  const positionCapacity = totalAssets == null
    ? 0
    : Math.max(0, (marketPositionLimit - currentPosition) / 100 * totalAssets)
  const amountCapacity = Math.min(cash, stockCapacity, positionCapacity)
  let affordableLots = Math.floor(amountCapacity / oneLotEntryGross)
  while (affordableLots > 0) {
    const gross = entryFill * affordableLots * 100
    const fees = tradeFees(
      'BUY',
      gross,
      A_SHARE_STANDARD_FEE_POLICY,
    )
    if (gross + fees.total <= amountCapacity) break
    affordableLots -= 1
  }
  const requested = requestedLots > 0
    ? requestedLots
    : Math.max(0, Math.min(riskLots, affordableLots))
  return {
    lots: Math.max(0, Math.min(requested, riskLots, affordableLots)),
    requestedLots,
    riskLots,
    affordableLots,
    riskPct: round(riskPct, 3),
    maxLossAmount,
    lossPerLot: round(lossPerLot),
    stockLimitPct: stockLimit,
    marketPositionLimitPct: marketPositionLimit,
  }
}

function costEstimate(action, referencePrice, lots, slippageBps) {
  if (!(referencePrice > 0 && lots > 0)) {
    return {
      side: RISK_REDUCING.has(action) ? 'SELL' : 'BUY',
      slippageBps,
      estimatedFillPrice: referencePrice || null,
      estimatedGrossAmount: 0,
      estimatedFees: 0,
      estimatedNetAmount: 0,
    }
  }
  const side = RISK_REDUCING.has(action) ? 'SELL' : 'BUY'
  const fillPrice = executionPrice(referencePrice, side, slippageBps)
  const gross = round(fillPrice * lots * 100)
  const fees = tradeFees(side, gross, A_SHARE_STANDARD_FEE_POLICY)
  return {
    side,
    slippageBps,
    estimatedFillPrice: round(fillPrice, 4),
    estimatedGrossAmount: gross,
    estimatedFees: fees.total,
    estimatedNetAmount: side === 'BUY'
      ? round(gross + fees.total)
      : round(gross - fees.total),
    feeBreakdown: fees,
  }
}

export function compileDecisionPlan({
  mode,
  advice = {},
  payload = {},
  evidenceSnapshot = null,
  strategySpec = getActiveStrategySpec(),
  strategyGate = {},
  now = Date.now(),
} = {}) {
  const requestedAction = actionFrom(mode, advice)
  const riskIncreasing = RISK_INCREASING.has(requestedAction)
  const riskReducing = RISK_REDUCING.has(requestedAction)
  const market = payload.marketEnv?.schemaVersion
    ? payload.marketEnv
    : deriveMarketRegime(payload.market || {})
  const account = payload.account || {}
  const referencePrice = referencePriceFor(
    requestedAction,
    advice,
    payload,
  )
  const stopPrice = positive(advice.stopPrice)
  const targetPrice = positive(advice.targetPrice)
  const requestedLots = requestedLotsFor(requestedAction, advice)
  const slippageBps = Math.max(
    0,
    finite(strategySpec?.execution?.slippageBps) ?? 5,
  )
  const productionEligible = strategyGate?.productionEligible === true
  const strategySignal = riskIncreasing && strategySpec
    ? evaluateStrategySignal(
        strategySpec,
        signalContext(payload, market),
      )
    : null
  const blockedReasons = []
  const freshness = evidenceSnapshot?.freshness || {}
  if (
    riskIncreasing
    && (
      freshness.status === 'PARTIAL'
      || (freshness.missingSources || []).length > 0
    )
  ) {
    blockedReasons.push(
      `关键证据不完整：${(freshness.missingSources || []).join('、') || 'unknown'}`,
    )
  }
  if (riskIncreasing && market.regime === 'UNKNOWN') {
    blockedReasons.push('市场状态无法确认')
  }
  const dualConfirmation = payload.counterTrend?.isStrong === true
    && payload.quant?.highConfSignal?.fired === true
  if (
    riskIncreasing
    && market.allowRiskIncrease !== true
    && !dualConfirmation
  ) {
    blockedReasons.push('当前市场状态禁止新增风险')
  }
  if (riskIncreasing && strategySignal?.passed !== true) {
    blockedReasons.push('策略入场条件未通过')
  }
  if (riskIncreasing && !(positive(account.totalAssets) && finite(account.cash) != null)) {
    blockedReasons.push('账户风险事实不完整')
  }
  if (riskIncreasing && !(referencePrice > 0 && stopPrice > 0)) {
    blockedReasons.push('缺少有效入场价或止损价')
  }
  if (riskIncreasing && stopPrice >= referencePrice) {
    blockedReasons.push('止损价必须低于入场价')
  }
  if (riskIncreasing && targetPrice != null && targetPrice <= referencePrice) {
    blockedReasons.push('目标价必须高于入场价')
  }
  if (advice.riskOverlay?.blocked) {
    blockedReasons.push(...(advice.riskOverlay.reasons || []))
  }

  let capacity = {
    lots: requestedLots,
    requestedLots,
    riskLots: null,
    affordableLots: null,
    riskPct: null,
    maxLossAmount: null,
    lossPerLot: null,
    stockLimitPct: null,
    marketPositionLimitPct: null,
  }
  if (
    riskIncreasing
    && referencePrice > 0
    && stopPrice > 0
    && positive(account.totalAssets)
  ) {
    capacity = computeBuyCapacity({
      requestedLots,
      referencePrice,
      stopPrice,
      account,
      market,
      slippageBps,
      productionEligible,
      highConfidence: payload.quant?.highConfSignal?.fired === true,
    })
    if (capacity.lots <= 0) blockedReasons.push('风险预算或现金不足一手')
  }
  if (riskReducing) {
    const sellable = Math.max(
      0,
      Math.trunc(finite(payload.sellableTodayQty) || 0),
    )
    capacity = {
      ...capacity,
      lots: Math.min(requestedLots, sellable),
      sellableLots: sellable,
    }
    if (capacity.lots <= 0) blockedReasons.push('今日没有可卖仓位')
  }

  const uniqueBlockers = [...new Set(blockedReasons.filter(Boolean))]
  let actionability = 'WATCH'
  if (riskIncreasing) {
    actionability = uniqueBlockers.length
      ? 'BLOCKED'
      : productionEligible ? 'READY' : 'RESEARCH_ONLY'
  } else if (riskReducing) {
    actionability = uniqueBlockers.length ? 'BLOCKED' : 'READY'
  }
  if (
    riskIncreasing
    && !productionEligible
    && !uniqueBlockers.some((item) => item.includes('策略尚未通过'))
  ) {
    uniqueBlockers.push('策略尚未通过生产晋级，仅作为研究级条件建议')
  }
  const action = actionability === 'BLOCKED'
    ? 'WATCH'
    : requestedAction
  const lots = actionability === 'BLOCKED' ? 0 : capacity.lots
  const costs = costEstimate(action, referencePrice, lots, slippageBps)
  const currentWeightPct = Math.max(0, finite(account.stockWeight) || 0)
  const totalAssets = positive(account.totalAssets)
  const deltaWeightPct = totalAssets == null
    ? null
    : round(
        (riskReducing ? -1 : riskIncreasing ? 1 : 0)
        * costs.estimatedGrossAmount / totalAssets * 100,
        1,
      )
  const targetWeightPct = deltaWeightPct == null
    ? null
    : round(Math.max(0, currentWeightPct + deltaWeightPct), 1)
  const asOf = evidenceSnapshot?.asOf
    || new Date(now).toISOString()
  const baseTime = Number.isFinite(Date.parse(asOf))
    ? Date.parse(asOf)
    : now
  const validForMs = payload.todayQuote?.live === true
    ? 15 * 60 * 1000
    : 12 * 60 * 60 * 1000
  const strategy = {
    strategyId: strategySpec?.strategyId || null,
    specVersion: strategySpec?.specVersion || null,
    signalPassed: strategySignal?.passed ?? null,
    matchedRules: strategySignal?.matchedRules || [],
    failedRules: strategySignal?.failedRules || [],
    productionEligible,
    gateBlockerCodes: (strategyGate?.blockers || [])
      .map((item) => text(item?.code, 80))
      .filter(Boolean),
  }
  const identity = {
    accountRevision: finite(
      evidenceSnapshot?.account?.revision
      ?? payload.accountRevision,
    ),
    action,
    actionability,
    code: text(payload.code, 12),
    evidenceSnapshotId: evidenceSnapshot?.snapshotId || null,
    lots,
    referencePrice,
    specVersion: strategy.specVersion,
    stopPrice,
    targetPrice,
    targetWeightPct,
  }
  return {
    schemaVersion: DECISION_PLAN_SCHEMA_VERSION,
    decisionId: fingerprint(identity),
    code: identity.code,
    name: text(payload.name, 40),
    mode: text(mode, 30),
    requestedAction,
    action,
    actionLabel: actionLabel(action),
    actionability,
    asOf,
    validUntil: new Date(baseTime + validForMs).toISOString(),
    recomputeOn: [
      'PRICE_TRIGGERED',
      'BAR_5M_CLOSED',
      'ACCOUNT_CHANGED',
      'NEWS_MATERIAL',
    ],
    marketRegime: {
      schemaVersion: market.schemaVersion || null,
      regime: market.regime || 'UNKNOWN',
      label: market.label || '数据不足',
      score: finite(market.score),
      dataQuality: market.dataQuality || 'MISSING',
      targetPositionPct: market.targetPositionPct || { min: 0, max: 0 },
    },
    strategy,
    currentWeightPct: round(currentWeightPct, 1),
    targetWeightPct,
    deltaWeightPct,
    quantity: {
      lots,
      requestedLots,
      riskLimitedLots: capacity.riskLots,
      affordableLots: capacity.affordableLots,
      sellableLots: capacity.sellableLots ?? null,
    },
    prices: {
      reference: round(referencePrice, 3),
      stop: round(stopPrice, 3),
      target: round(targetPrice, 3),
    },
    risk: {
      budgetPct: capacity.riskPct,
      maxLossAmount: capacity.maxLossAmount,
      estimatedLossPerLot: capacity.lossPerLot,
      stockLimitPct: capacity.stockLimitPct,
      marketPositionLimitPct: capacity.marketPositionLimitPct,
    },
    costs,
    trigger: text(
      advice.timing
      || advice.nextOpenPlan
      || advice.actionPlan,
      500,
    ),
    invalidation: text(
      advice.invalidation
      || advice.knowledgeActionPlan?.invalidation,
      500,
    ),
    evidenceIds: evidenceSnapshot?.snapshotId
      ? [evidenceSnapshot.snapshotId]
      : [],
    blockedReasons: uniqueBlockers,
    executionStyle: 'SINGLE_LIMIT',
    explanation: text(advice.reason || advice.reasoning, 500),
  }
}
