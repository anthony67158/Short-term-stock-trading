import {
  A_SHARE_STANDARD_FEE_POLICY,
  executionPrice,
  tradeFees,
} from './ashareStrategyExecution.js'
import { deriveMarketRegime } from './marketRegime.js'
import {
  ADVICE_PRICE_CONTRACT_SCHEMA_VERSION,
  adviceObservationLevels,
  buildAdvicePriceContract,
} from './advicePriceContract.js'
import { executionTriggerDirection } from './executionTrigger.js'
import {
  buildShortHorizonTactical,
  deriveShortHorizonActionPolicy,
} from './shortHorizonTactical.js'
import {
  deriveOpportunityLifecycle,
} from './opportunityLifecycle.js'
import { positionExitEffect } from './positionExit.js'
import { buildTradeExpectancy } from './tradeExpectancy.js'
import {
  beijingDayKey,
  beijingMinutes,
  isTradingDayAt,
  nextTradingDate,
  localDateKey,
} from './tradingCalendar.js'

export const DECISION_PLAN_SCHEMA_VERSION = 'decision-plan.v2'

const RISK_INCREASING = new Set(['BUY', 'ADD', 'T_BUY_FIRST'])
const RISK_REDUCING = new Set(['REDUCE', 'EXIT', 'T_SELL_FIRST'])
const REQUIRED_EVIDENCE_SOURCES = new Set([
  'account',
  'quote',
  'market',
  'quant',
])

export function decisionPlanConfirmationGate(plan, side) {
  if (plan?.schemaVersion !== DECISION_PLAN_SCHEMA_VERSION) {
    return { allowed: true, policy: 'legacy-advice', reason: '' }
  }
  if (
    side === 'buy'
    && plan.actionability !== 'READY'
  ) {
    return {
      allowed: false,
      policy: 'decision-plan-not-ready',
      reason: '账户、证据或风险条件未通过，不能升级为执行确认',
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

function adaptiveResearchPrior(actionPolicy = {}, tactical = {}) {
  if (actionPolicy.riskTier !== 'PROBE') return null
  const signalScore = Math.max(0, finite(actionPolicy.signalScore) || 0)
  const alignmentScore = Math.max(
    0,
    Math.min(100, finite(tactical.alignmentScore) ?? 50),
  )
  const pWinGivenFill = Math.max(
    0.4,
    Math.min(
      0.72,
      0.4 + signalScore * 0.035 + (alignmentScore - 50) * 0.0015,
    ),
  )
  const pFill = tactical.timing?.state === 'READY'
    ? 0.88
    : tactical.timing?.state === 'TOO_EXTENDED'
      ? 0.62
      : 0.68
  return {
    serverVerified: true,
    version: 'adaptive-action-policy.v1',
    pFill,
    pWinGivenFill,
    uncertaintyR: actionPolicy.riskTier === 'FULL' ? 0.32 : 0.48,
    costR: 0.04,
    sampleCount: 0,
  }
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
  if (/观望|等待|回避|不建议|暂不/.test(value)) {
    return mode === 'hold_advice' ? 'HOLD' : 'WATCH'
  }
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

export function decisionActionFromAdvice(mode, advice = {}) {
  return actionFrom(mode, advice)
}

function actionLabel(action) {
  return {
    BUY: '买入',
    ADD: '加仓',
    HOLD: '持有',
    REDUCE: '减仓',
    EXIT: '清仓',
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
    return positive(advice.reducePrice ?? advice.stopPrice)
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

function computeBuyCapacity({
  requestedLots,
  referencePrice,
  stopPrice,
  account,
  market,
  slippageBps,
  highConfidence,
  accountRiskMultiplier = 1,
  availableOpenRiskAmount = null,
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
  const normalizedAccountRiskMultiplier = Math.max(
    0,
    Math.min(1, finite(accountRiskMultiplier) ?? 1),
  )
  const riskPct = (highConfidence ? 1 : 0.6)
    * (finite(market.riskMultiplier) ?? 0)
    * normalizedAccountRiskMultiplier
  const baseMaxLossAmount = totalAssets == null
    ? null
    : round(totalAssets * riskPct / 100)
  const availableRisk = Math.max(
    0,
    finite(availableOpenRiskAmount) ?? Infinity,
  )
  const maxLossAmount = baseMaxLossAmount == null
    ? null
    : round(Math.min(baseMaxLossAmount, availableRisk))

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
  const industryWeight = finite(account.industryWeight)
  const industryCapacity = totalAssets != null && industryWeight != null
    ? Math.max(0, (30 - industryWeight) / 100 * totalAssets)
    : Infinity
  const amountCapacity = Math.min(cash, stockCapacity, positionCapacity, industryCapacity)
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
    accountRiskMultiplier: normalizedAccountRiskMultiplier,
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

function planExpiry(now, executable) {
  const minutes = beijingMinutes(now)
  if (executable) {
    const sessionEnd = Date.parse(`${beijingDayKey(now)}T${
      minutes <= 690 ? '11:30' : '15:00'
    }:00+08:00`)
    return Math.min(now + 15 * 60 * 1000, sessionEnd)
  }
  const day = isTradingDayAt(now) && minutes < 900
    ? beijingDayKey(now)
    : nextTradingDate(now) && localDateKey(nextTradingDate(now))
  return day ? Date.parse(`${day}T15:00:00+08:00`) : now
}

export function applyCompiledDecisionPlan(advice = {}) {
  const plan = advice.decisionPlan
  if (plan?.schemaVersion !== DECISION_PLAN_SCHEMA_VERSION
    || !['buy_advice', 'hold_advice', 'review'].includes(plan.mode)) return advice
  const lots = Math.max(0, Math.trunc(finite(plan.quantity?.lots) || 0))
  const ready = ['READY', 'MANUAL_PROBE'].includes(plan.actionability)
  const conditionalExit = plan.actionability === 'CONDITIONAL'
    && RISK_REDUCING.has(plan.action)
  const allowed = (ready || conditionalExit) && lots > 0
  const holding = ['hold_advice', 'review'].includes(plan.mode)
  const action = allowed ? actionLabel(plan.action) : holding ? '持有' : '观望'
  const reference = positive(plan.prices?.reference)
  const reasons = plan.blockedReasons?.filter(Boolean).join('；') || ''
  const budget = plan.entryBudget
  const instruction = allowed
    ? `${conditionalExit ? '到价确认后' : '人工确认后'}${action}${lots}手，${reference}元；${
        [plan.prices?.stop > 0 ? `止损${plan.prices.stop}元` : '',
          plan.prices?.target > 0 ? `目标${plan.prices.target}元` : ''].filter(Boolean).join('，')
      }`
    : reasons ? `${holding ? '不加仓，保留现有仓位纪律' : '本次不买入'}：${reasons}`
      : budget?.state === 'ESTIMATED'
        ? `${plan.trigger || advice.actionPlan || '到价确认'}；预案最多${budget.lots}手，尚未授权执行`
        : advice.actionPlan
  const result = {
    ...advice,
    decisionPlan: allowed ? {
      ...plan,
      trigger: conditionalExit
        ? `${plan.triggerDirection === 'LTE' ? '跌至' : '反弹至'}${reference}元并确认转弱后${action}${lots}手`
        : instruction,
    } : plan,
    action,
    stance: action,
    actionPlan: instruction,
    nextAction: instruction,
    todayAction: action,
    expireAt: Date.parse(plan.validUntil),
    planQty: allowed && plan.action === 'BUY' ? lots : 0,
    planQtyNum: allowed && plan.action === 'BUY' ? lots : 0,
    opQty: allowed ? `${action}${lots}手` : '无需操作',
    planAmount: allowed && plan.action === 'BUY' ? plan.costs?.estimatedNetAmount ?? 0 : 0,
    opAmount: allowed ? plan.costs?.estimatedNetAmount ?? 0 : 0,
    buyPrice: allowed && plan.action === 'BUY' ? reference : null,
    buyZone: allowed && plan.action === 'BUY' ? String(reference) : null,
    addPrice: allowed && plan.action === 'ADD' ? reference : null,
    reducePrice: allowed && RISK_REDUCING.has(plan.action) ? reference : null,
    stopPrice: plan.prices?.stop ?? null,
    targetPrice: plan.prices?.target ?? null,
  }
  if (advice.reviewDecision?.terminal === true && allowed) {
    result.reviewDecision = {
      ...advice.reviewDecision,
      operation: action,
      outcome: `立即${action}`,
      quantity: lots,
      priceLow: reference,
      priceHigh: reference,
    }
  }
  return result
}

export function compileDecisionPlan({
  mode,
  advice = {},
  payload = {},
  evidenceSnapshot = null,
  accountCircuitBreaker = null,
  now = Date.now(),
} = {}) {
  const requestedAction = actionFrom(mode, advice)
  const market = payload.marketEnv?.schemaVersion
    ? payload.marketEnv
    : deriveMarketRegime(payload.market || {})
  const tactical = payload.shortHorizonTactical?.schemaVersion
    === 'short-horizon-tactical.v1'
    ? payload.shortHorizonTactical
    : buildShortHorizonTactical(payload, { now })
  const account = payload.account || {}
  const actionPolicy = deriveShortHorizonActionPolicy({
    mode,
    tactical,
    requestedAction,
    reviewEvent: payload.reviewEvent,
  })
  const governedAction = actionPolicy.effectiveAction
    || requestedAction
  const conditionalEntry = ['WATCH', 'HOLD'].includes(governedAction)
    && ['buy_advice', 'hold_advice', 'review'].includes(mode)
    && actionPolicy.riskTier !== 'NONE'
    && advice.reviewDecision?.terminal !== true
  const riskRequested = RISK_INCREASING.has(requestedAction) || conditionalEntry
  const riskIncreasing = RISK_INCREASING.has(governedAction) || conditionalEntry
  const budgetAction = conditionalEntry
    ? mode === 'buy_advice' ? 'BUY' : 'ADD'
    : governedAction
  const riskReducing = RISK_REDUCING.has(governedAction)
  if (conditionalEntry) {
    advice = {
      ...advice,
      stopPrice: positive(advice.stopPrice)
        ?? positive(tactical.prices?.stopReference)
        ?? positive(payload.quant?.highConfSignal?.stopLoss),
      targetPrice: positive(advice.targetPrice)
        ?? positive(tactical.prices?.targetReference)
        ?? positive(payload.quant?.highConfSignal?.takeProfit),
    }
  }
  const expectancyCalibration =
    payload.advisorTrack?.expectancyCalibration || {}
  const realizedRSamples = Math.max(
    0,
    Math.trunc(
      finite(expectancyCalibration.realizedRSamples) || 0,
    ),
  )
  const realizedNetRLowerBound = finite(
    expectancyCalibration.realizedNetRLowerBound,
  )
  const calibrationSamples = Math.max(
    0,
    Math.trunc(finite(expectancyCalibration.samples) || 0),
  )
  const brierScore = finite(expectancyCalibration.brierScore)
  const performanceRiskMultiplier = (
    (
      realizedRSamples >= 20
      && realizedNetRLowerBound != null
      && realizedNetRLowerBound < 0
    )
    || (
      calibrationSamples >= 30
      && brierScore != null
      && brierScore > 0.25
    )
  ) ? 0.5 : 1
  let referencePrice = referencePriceFor(
    governedAction,
    advice,
    payload,
  )
  let requestedReferencePrice = referencePriceFor(
    requestedAction,
    advice,
    payload,
  )
  const stopPrice = positive(advice.stopPrice)
  const targetPrice = positive(advice.targetPrice)
  const requestedLots = requestedLotsFor(governedAction, advice)
  const slippageBps = 5
  const generatedPriceContract = buildAdvicePriceContract({
    mode,
    advice,
    payload,
    evidenceSnapshot,
    action: governedAction,
  })
  const suppliedPriceContract = advice.priceContract?.schemaVersion
    === ADVICE_PRICE_CONTRACT_SCHEMA_VERSION
    ? advice.priceContract
    : null
  const priceContract = suppliedPriceContract ? {
    ...generatedPriceContract,
    validationStatus: (
      suppliedPriceContract.validationStatus === 'REJECTED'
      || generatedPriceContract.validationStatus === 'REJECTED'
    ) ? 'REJECTED' : generatedPriceContract.validationStatus,
    allPricesStrict: suppliedPriceContract.allPricesStrict === true
      && generatedPriceContract.allPricesStrict === true,
    issues: [...new Set([
      ...(suppliedPriceContract.issues || []),
      ...generatedPriceContract.issues,
    ])],
  } : generatedPriceContract
  const observationLevels = adviceObservationLevels({
    priceContract,
  })
  if (conditionalEntry) {
    const preferredKey = tactical.timing?.state === 'WAIT_BREAKOUT'
      ? 'watch_breakout'
      : 'watch_pullback'
    const observation = observationLevels.find((item) => item.key === preferredKey)
      || observationLevels[0]
    referencePrice = positive(observation?.price)
      ?? positive(priceContract.levels.find((item) =>
        ['entry', 'add'].includes(item.key) && item.strict === true,
      )?.price)
    requestedReferencePrice = referencePrice
  }
  const blockedReasons = []
  if (conditionalEntry && !['stop', 'target'].every((key) =>
    priceContract.levels.some((item) => item.key === key && item.strict)
  )) blockedReasons.push('预案止损或目标价缺少可核验依据')
  const freshness = evidenceSnapshot?.freshness || {}
  const missingRequiredSources = Array.isArray(
    freshness.missingRequiredSources,
  )
    ? freshness.missingRequiredSources
    : (freshness.missingSources || []).filter(
        (source) => REQUIRED_EVIDENCE_SOURCES.has(source),
      )
  const missingRequired = new Set(missingRequiredSources)
  const evidenceIssues = (Array.isArray(freshness.missingDetails)
    ? freshness.missingDetails
    : [])
    .filter((issue) =>
      issue?.required === true
      || missingRequired.has(issue?.source)
    )
    .map((issue) => ({
      source: text(issue.source, 40),
      label: text(issue.label, 60),
      status: text(issue.status, 30),
      reason: text(issue.reason, 160),
      impact: text(issue.impact, 200),
      recovery: text(issue.recovery, 200),
      required: true,
    }))
  const marketTime = evidenceSnapshot?.marketTime || {}
  const basisSource = evidenceSnapshot?.sources?.quote
    || evidenceSnapshot?.sources?.market
    || null
  const evidenceBasis = (
    marketTime.basisLabel
    || basisSource?.basisLabel
    || marketTime.dataDayLabel
    || basisSource?.dataAsOf
  )
    ? {
        state: text(
          marketTime.evidenceState
          || basisSource?.state
          || freshness.status,
          30,
        ),
        label: text(
          marketTime.basisLabel || basisSource?.basisLabel,
          80,
        ),
        dataAsOf: text(
          marketTime.dataDayLabel || basisSource?.dataAsOf,
          60,
        ),
        phase: text(marketTime.phase, 60),
        isLive: marketTime.isLive === true,
      }
    : null
  if (
    riskRequested
    && (
      freshness.status === 'PARTIAL'
      || missingRequired.size > 0
    )
  ) {
    const detail = evidenceIssues.length
      ? evidenceIssues
          .map((issue) =>
            `${issue.label || issue.source}（${issue.reason || '未取得有效数据'}）`
          )
          .join('；')
      : missingRequiredSources.join('、') || '来源状态未提供'
    blockedReasons.push(
      `关键证据不完整：${detail}`,
    )
  }
  const marketUnknown = market.regime === 'UNKNOWN'
  if (
    riskRequested
    && marketUnknown
    && !missingRequired.has('market')
  ) {
    blockedReasons.push('市场状态无法确认：市场数据存在但无法归类')
  }
  if (
    riskRequested
    && !missingRequired.has('account')
    && !(positive(account.totalAssets) && finite(account.cash) != null)
  ) {
    blockedReasons.push('账户风险事实不完整')
  }
  if (
    riskRequested
    && !(requestedReferencePrice > 0 && stopPrice > 0)
  ) {
    blockedReasons.push('缺少有效入场价或止损价')
  }
  if (riskReducing && !(referencePrice > 0)) {
    blockedReasons.push('缺少有效卖出价或止损价')
  }
  if (
    riskRequested
    && actionPolicy.executionOpen !== false
    && priceContract.validationStatus === 'REJECTED'
  ) {
    blockedReasons.push(
      `关键执行价缺少可核验依据：${priceContract.issues.join('；')}`,
    )
  }
  if (riskRequested && stopPrice >= requestedReferencePrice) {
    blockedReasons.push('止损价必须低于入场价')
  }
  if (
    riskRequested
    && targetPrice != null
    && targetPrice <= requestedReferencePrice
  ) {
    blockedReasons.push('目标价必须高于入场价')
  }
  if (
    riskRequested
    && (
      !(requestedReferencePrice > 0)
      || !(stopPrice > 0)
      || !(targetPrice > requestedReferencePrice)
    )
  ) blockedReasons.push('入场、止损和目标价无法形成有效收益路径')
  if (advice.riskOverlay?.blocked) {
    blockedReasons.push(...(advice.riskOverlay.reasons || []))
  }
  if (
    riskRequested
    && accountCircuitBreaker?.allowRiskIncrease === false
  ) {
    blockedReasons.push(
      ...(accountCircuitBreaker.blockers || [])
        .map((item) => text(item?.message, 160))
        .filter(Boolean),
    )
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
    accountRiskMultiplier: null,
  }
  if (
    riskIncreasing
    && referencePrice > 0
    && stopPrice > 0
    && positive(account.totalAssets)
    && !missingRequired.has('account')
    && !missingRequired.has('market')
    && !marketUnknown
  ) {
    capacity = computeBuyCapacity({
      requestedLots,
      referencePrice,
      stopPrice,
      account: {
        ...account,
        maxStockWeight: actionPolicy.riskTier === 'PROBE'
          ? Math.min(5, positive(actionPolicy.maxPositionPct) || 5,
              positive(account.maxStockWeight) || 20)
          : account.maxStockWeight,
        cash: Math.max(0, Math.min(
          finite(account.cash) || 0,
          finite(accountCircuitBreaker?.availableCashAfterReservations) ?? Infinity,
        ) - account.totalAssets * 0.1),
        stockWeight: (finite(account.stockWeight) || 0)
          + (finite(account.pendingStockWeight) || 0),
        position: (finite(account.position) || 0)
          + (finite(accountCircuitBreaker?.reservedBuyCash) || 0)
            / account.totalAssets * 100,
      },
      market,
      slippageBps,
      highConfidence: payload.quant?.highConfSignal?.fired === true,
      accountRiskMultiplier:
        Math.min(
          finite(accountCircuitBreaker?.riskBudgetMultiplier) ?? 1,
          performanceRiskMultiplier,
        ),
      availableOpenRiskAmount:
        accountCircuitBreaker?.availableOpenRiskAmount,
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

  const policyProbe = (
    riskIncreasing
    && actionPolicy.riskTier === 'PROBE'
  )
  const probeRequested = riskIncreasing
    && (
      policyProbe
      ||
      advice.tier === 'probe'
      || /小仓|试错|试仓/.test(
        `${advice.action || ''} ${advice.actionPlan || ''}`,
      )
    )
  const sectorProbeEligible = (
    payload.sectorOpportunity?.schemaVersion === 'sector-opportunity.v1'
    && payload.sectorOpportunity?.probeEligible === true
  )
  if (
    probeRequested
    && (policyProbe || sectorProbeEligible)
    && capacity.lots > 0
  ) {
    const probePositionLimitPct = Math.min(
      5,
      positive(actionPolicy.maxPositionPct) || 5,
    )
    const oneLotGross = executionPrice(
      referencePrice,
      'BUY',
      slippageBps,
    ) * 100
    const probeAmountLimit = positive(account.totalAssets)
      * probePositionLimitPct / 100
    const probeLots = Math.floor(probeAmountLimit / oneLotGross)
    capacity = {
      ...capacity,
      lots: Math.min(capacity.lots, Math.max(0, probeLots)),
      manualProbeLimitPct: probePositionLimitPct,
    }
    if (capacity.lots <= 0) {
      blockedReasons.push(
        `单手金额超过短线试仓的${probePositionLimitPct}%仓位上限`,
      )
    }
  }

  let tradeExpectancy = buildTradeExpectancy({
    action: budgetAction,
    referencePrice,
    stopPrice,
    targetPrice,
    quantityLots: Math.max(
      1,
      capacity.lots || requestedLots || 1,
    ),
    slippageBps,
    stressExitPrice: payload.todayQuote?.limitDownPrice,
    opportunityScore: payload.opportunityScore,
    quant: payload.quant,
    researchPrior: adaptiveResearchPrior(actionPolicy, tactical),
  })
  if (
    riskIncreasing
    && capacity.lots > 0
    && positive(account.totalAssets)
    && tradeExpectancy.stress?.lossAmount > 0
  ) {
    const stressLimitAmount = account.totalAssets * 0.02
    const stressLossPerLot =
      tradeExpectancy.stress.lossAmount / capacity.lots
    const stressLimitedLots = Math.max(
      0,
      Math.floor(stressLimitAmount / stressLossPerLot),
    )
    if (stressLimitedLots < capacity.lots) {
      capacity = {
        ...capacity,
        lots: stressLimitedLots,
        stressLimitedLots,
        stressLimitAmount: round(stressLimitAmount),
      }
      tradeExpectancy = buildTradeExpectancy({
        action: budgetAction,
        referencePrice,
        stopPrice,
        targetPrice,
        quantityLots: Math.max(1, stressLimitedLots),
        slippageBps,
        stressExitPrice: payload.todayQuote?.limitDownPrice,
        opportunityScore: payload.opportunityScore,
        quant: payload.quant,
        researchPrior: adaptiveResearchPrior(actionPolicy, tactical),
      })
      if (stressLimitedLots <= 0) {
        blockedReasons.push(
          `按跌停压力价测算，单手潜在损失超过总资产2%（上限${
            round(stressLimitAmount)
          }元）`,
        )
      }
    }
  }
  if (
    riskIncreasing
    && tradeExpectancy.gate?.allowsRiskIncrease === false
  ) {
    blockedReasons.push(tradeExpectancy.gate.reason)
  }

  const uniqueBlockers = [...new Set(blockedReasons.filter(Boolean))]
  const exitConfirmed = (advice.reviewDecision?.terminal === true
    && /减仓|清仓|锁定利润|止损|退出/.test(String(
      advice.reviewDecision?.operation
      || advice.reviewDecision?.outcome
      || '',
    ))) || (
      advice.exitManagement?.kind === 'HARD_STOP'
      && advice.exitManagement?.blockedByT1 === false
      && payload.todayQuote?.live === true
      && positive(payload.todayQuote?.price) <= stopPrice * 0.985
    )
  let actionability = 'WATCH'
  if (!conditionalEntry && riskRequested && uniqueBlockers.length) {
    actionability = 'BLOCKED'
  } else if (riskIncreasing && !conditionalEntry) {
    actionability = uniqueBlockers.length ? 'BLOCKED' : 'READY'
  } else if (riskReducing) {
    actionability = uniqueBlockers.length
      ? 'BLOCKED'
      : exitConfirmed ? 'READY' : 'CONDITIONAL'
  }
  const provisionalAction = actionability === 'BLOCKED'
    ? 'WATCH'
    : governedAction
  const lots = actionability === 'BLOCKED' || conditionalEntry ? 0 : capacity.lots
  const positionEffect = positionExitEffect({
    action: provisionalAction,
    requestedLots: lots,
    holdQty: payload.holdQty,
    sellableTodayQty: payload.sellableTodayQty,
  })
  const action = positionEffect.fullExit
    ? 'EXIT'
    : provisionalAction
  const effectiveGovernedAction = positionEffect.fullExit
    ? 'EXIT'
    : governedAction
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
  const validUntil = planExpiry(
    baseTime,
    actionPolicy.executionOpen && ['READY', 'MANUAL_PROBE'].includes(actionability),
  )
  const trigger = text(
    actionPolicy.overridden
      ? actionPolicy.nextReviewTrigger
      : advice.actionPlan
        || advice.nextAction
        || advice.timing
        || advice.nextOpenPlan,
    500,
  )
  const triggerDirection = executionTriggerDirection({
    action,
    trigger,
  })
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
    stopPrice,
    targetPrice,
    targetWeightPct,
    triggerDirection,
    expectancyState: tradeExpectancy.state,
    expectancyModelVersion: tradeExpectancy.modelVersion,
    expectancyGate: tradeExpectancy.gate?.state,
    exitKind: text(advice.exitManagement?.kind, 40),
    priceLevels: priceContract.levels.map((level) => ({
      key: level.key,
      price: level.price,
      direction: level.direction,
      strict: level.strict,
    })),
  }
  const decisionId = fingerprint(identity)
  const opportunityLifecycle = deriveOpportunityLifecycle({
    code: identity.code,
    mode,
    advice,
    tactical,
    decisionPlan: {
      decisionId,
      action,
      actionability,
    },
    holdQty: payload.holdQty,
    sellableTodayQty: payload.sellableTodayQty,
    now,
  })
  return {
    schemaVersion: DECISION_PLAN_SCHEMA_VERSION,
    decisionId,
    code: identity.code,
    name: text(payload.name, 40),
    mode: text(mode, 30),
    requestedAction,
    governedAction: effectiveGovernedAction,
    action,
    actionLabel: actionLabel(action),
    actionability,
    actionabilityLabel: actionability === 'CONDITIONAL'
      ? '到价后观察确认'
      : actionability === 'READY'
        ? '可执行'
        : actionability === 'BLOCKED'
          ? '暂不可执行'
          : '继续观察',
    asOf,
    validUntil: new Date(validUntil).toISOString(),
    recomputeOn: [
      'PRICE_TRIGGERED',
      'BAR_5M_CLOSED',
      'ACCOUNT_CHANGED',
      'NEWS_MATERIAL',
      'PRICE_LEVEL_CROSSED',
    ],
    marketRegime: {
      schemaVersion: market.schemaVersion || null,
      regime: market.regime || 'UNKNOWN',
      label: market.label || '数据不足',
      score: finite(market.score),
      dataQuality: market.dataQuality || 'MISSING',
      targetPositionPct: market.targetPositionPct || { min: 0, max: 0 },
    },
    tactical: {
      schemaVersion: tactical.schemaVersion,
      horizon: tactical.horizon,
      alignmentScore: finite(tactical.alignmentScore),
      marketRiskTone: tactical.market?.riskTone || 'UNKNOWN',
      sectorState: tactical.sector?.state || 'UNKNOWN',
      stockRole: tactical.sector?.stockRole || 'UNKNOWN',
      timingState: tactical.timing?.state || 'INVALID',
      reviewAfter: tactical.timing?.reviewAfter || 'MATERIAL_EVENT',
      flowRelation: tactical.flow?.relation || 'UNKNOWN',
      crowdingRisk: tactical.stock?.crowdingRisk || 'UNKNOWN',
      catalystFreshness: tactical.catalyst?.freshness || 'NONE',
      conflicts: Array.isArray(tactical.conflicts)
        ? tactical.conflicts.slice(0, 4)
        : [],
    },
    actionPolicy,
    exitManagement:
      advice.exitManagement?.schemaVersion === 'exit-management.v1'
        ? {
            schemaVersion: 'exit-management.v1',
            kind: text(advice.exitManagement.kind, 40),
            priority: finite(advice.exitManagement.priority),
            action: text(advice.exitManagement.action, 30),
            lots: finite(advice.exitManagement.lots),
            totalLots: finite(advice.exitManagement.totalLots),
            sellableLots: finite(
              advice.exitManagement.sellableLots,
            ),
            lockedLots: finite(advice.exitManagement.lockedLots),
            blockedByT1:
              advice.exitManagement.blockedByT1 === true,
            referencePrice: finite(
              advice.exitManagement.referencePrice,
            ),
            reason: text(advice.exitManagement.reason, 240),
            nextReviewTrigger: text(
              advice.exitManagement.nextReviewTrigger,
              180,
            ),
          }
        : null,
    opportunityLifecycle,
    manualConfirmationOnly: probeRequested,
    opportunity: payload.sectorOpportunity?.matched === true
      ? {
          schemaVersion: payload.sectorOpportunity.schemaVersion,
          sectorCode: text(payload.sectorOpportunity.sector?.code, 20),
          sectorName: text(payload.sectorOpportunity.sector?.name, 60),
          sectorActionability: text(
            payload.sectorOpportunity.sector?.actionability,
            30,
          ),
          stockRole: text(
            payload.sectorOpportunity.stock?.roleLabel
            || payload.sectorOpportunity.stock?.role,
            30,
          ),
          generatedAt: finite(payload.sectorOpportunity.generatedAt),
          sourceSession: text(
            payload.sectorOpportunity.sourceSession,
            20,
          ),
        }
      : null,
    currentWeightPct: round(currentWeightPct, 1),
    targetWeightPct,
    deltaWeightPct,
    quantity: {
      lots,
      requestedLots,
      holdingLots: positionEffect.totalLots,
      remainingLots: positionEffect.remainingLots,
      riskLimitedLots: capacity.riskLots,
      affordableLots: capacity.affordableLots,
      sellableLots: capacity.sellableLots ?? null,
    },
    entryBudget: conditionalEntry ? {
      state: uniqueBlockers.length ? 'BLOCKED' : 'ESTIMATED',
      executionAllowed: false,
      lots: uniqueBlockers.length ? 0 : capacity.lots,
      referencePrice: round(referencePrice, 3),
      stopPrice: round(stopPrice, 3),
      targetPrice: round(targetPrice, 3),
      costs: costEstimate(budgetAction, referencePrice,
        uniqueBlockers.length ? 0 : capacity.lots, slippageBps),
      stopLossAmount: uniqueBlockers.length
        ? null : tradeExpectancy.plan?.lossAmount ?? null,
      reasons: uniqueBlockers,
      asOf,
    } : null,
    positionEffect,
    prices: {
      reference: round(referencePrice, 3),
      current: priceContract.currentPrice,
      buy: round(advice.buyPrice, 3),
      add: round(advice.addPrice, 3),
      reduce: round(advice.reducePrice, 3),
      stop: round(stopPrice, 3),
      target: round(targetPrice, 3),
      watch: round(observationLevels[0]?.price, 3),
      observations: observationLevels.map((level) => ({
        key: level.key,
        label: level.label,
        price: round(level.price, 3),
        direction: level.direction,
      })),
      leg1: round(advice.leg1Price, 3),
      leg2: round(advice.leg2Price, 3),
    },
    priceContract,
    triggerDirection,
    risk: {
      budgetPct: capacity.riskPct,
      minimumRiskReward: null,
      minimumNetRiskReward: null,
      breakEvenWinProbability:
        tradeExpectancy.plan?.breakEvenWinProbability ?? null,
      expectedNetR:
        tradeExpectancy.expectancy?.expectedNetRGivenFill ?? null,
      maxLossAmount: capacity.maxLossAmount,
      estimatedLossPerLot: capacity.lossPerLot,
      manualProbeLimitPct: capacity.manualProbeLimitPct ?? null,
      stockLimitPct: capacity.stockLimitPct,
      marketPositionLimitPct: capacity.marketPositionLimitPct,
      accountCircuitBreaker: accountCircuitBreaker
        ? {
            schemaVersion: accountCircuitBreaker.schemaVersion,
            allowRiskIncrease:
              accountCircuitBreaker.allowRiskIncrease === true,
            riskBudgetMultiplier:
              finite(accountCircuitBreaker.riskBudgetMultiplier),
            riskBudgetReason: text(
              accountCircuitBreaker.riskBudgetReason,
              160,
            ),
            blockerCodes:
              accountCircuitBreaker.blockerCodes || [],
          }
        : null,
      performanceCalibration: {
        samples: calibrationSamples,
        brierScore,
        realizedRSamples,
        realizedNetRLowerBound,
        riskBudgetMultiplier: performanceRiskMultiplier,
        reason: performanceRiskMultiplier < 1
          ? '历史费后净回报下界或概率校准未达标，本笔风险预算减半'
          : null,
      },
      tradeExpectancy,
    },
    costs,
    trigger,
    invalidation: text(
      advice.invalidation
      || advice.knowledgeActionPlan?.invalidation,
      500,
    ),
    evidenceIds: evidenceSnapshot?.snapshotId
      ? [evidenceSnapshot.snapshotId]
      : [],
    evidenceBasis,
    evidenceIssues,
    blockedReasons: uniqueBlockers,
    executionStyle: 'SINGLE_LIMIT',
    explanation: text(advice.reason || advice.reasoning, 500),
  }
}

export function buildFallbackDecisionAdvice({
  mode,
  payload = {},
  evidenceSnapshot = null,
  error = '',
  now = Date.now(),
} = {}) {
  const holdingMode = mode === 'hold_advice' || mode === 'review'
  const previous = payload?.previousAdvice
    && typeof payload.previousAdvice === 'object'
    ? payload.previousAdvice
    : {}
  const previousStop = holdingMode
    ? positive(previous.stopPrice)
    : null
  const previousReduce = holdingMode
    ? positive(previous.reducePrice)
    : null
  const previousTarget = holdingMode
    ? positive(previous.targetPrice)
    : null
  const previousDefense = [
    previousStop != null ? `止损${previousStop}元` : '',
    previousReduce != null ? `减仓${previousReduce}元` : '',
    previousTarget != null ? `目标${previousTarget}元` : '',
  ].filter(Boolean).join('、')
  const errorText = text(error, 120) || 'AI 决策模型未返回有效内容'
  const advice = {
    action: holdingMode ? '持有' : '观望',
    stance: holdingMode ? '持有' : '观望',
    tier: 'wait',
    tone: 'muted',
    title: holdingMode
      ? `AI 决策暂不可用（${errorText}），维持现有仓位纪律`
      : `AI 决策暂不可用（${errorText}），暂停新增风险`,
    actionPlan: holdingMode
      ? `本轮不新增仓位，也不依据不完整解释改变原计划；${
          previousDefense
            ? `继续执行上一版防守价：${previousDefense}。`
            : '等待数据与解释服务恢复后重新评估。'
        }`
      : '本轮不下单；等待数据与解释服务恢复并重新生成统一决策计划。',
    nextOpenPlan: holdingMode
      ? text(previous.nextOpenPlan, 500)
        || '下一交易日开盘先恢复行情、技术与资金证据；证据完整前维持原仓位纪律，不新增风险。'
      : '',
    futurePlan: holdingMode
      ? text(previous.futurePlan, 500)
        || '解释服务恢复后重新生成1-5日退出路径；恢复前只执行原有硬止损，不延长持有周期。'
      : '',
    opQty: '无需操作',
    planQty: 0,
    planQtyNum: 0,
    planAmount: 0,
    buyPrice: null,
    addPrice: null,
    reducePrice: previousReduce,
    stopPrice: previousStop,
    targetPrice: previousTarget,
    invalidation: holdingMode
      ? text(previous.invalidation, 500)
        || '关键数据或解释服务恢复后，本等待计划自动失效并必须重新计算。'
      : '关键数据或解释服务恢复后，本等待计划自动失效并必须重新计算。',
    reason: `确定性降级：${text(error, 160) || 'LLM 未返回有效内容'}`,
    quantNote: payload.quant
      ? '量化结果已保留，但本轮没有获得完整解释，不能单独升级为交易动作。'
      : '量化证据暂缺，本轮不据此产生交易动作。',
    techNote: payload.tech
      ? '技术指标已保留，只作为下次重算输入，不单独产生交易动作。'
      : '技术证据暂缺，本轮不据此产生交易动作。',
    confidence: '低',
  }
  advice.decisionPlan = compileDecisionPlan({
    mode,
    advice,
    payload,
    evidenceSnapshot,
    now,
  })
  return advice
}
