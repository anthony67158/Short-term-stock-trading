export const ENTRY_INSTRUCTION_VERSION = 'entry-instruction.v1'

const ROUTE_LABELS = Object.freeze({
  IMMEDIATE: '现价路径',
  PULLBACK: '回踩路径',
  BREAKOUT: '突破路径',
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

function rounded(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function text(value, maximum = 240) {
  return String(value || '').trim().slice(0, maximum)
}

function routeLabel(value) {
  return ROUTE_LABELS[String(value || '').toUpperCase()]
    || '候选路径'
}

function candidatePlan(advice = {}, holding = false, decisionPlan = {}) {
  const selected = advice.selectedDecisionPlan || null
  if (!holding) return selected
  const addPlan = advice.holdingAddPlan
  if (
    addPlan?.schemaVersion === 'holding-add-plan.v1'
    && ['PULLBACK', 'BREAKOUT'].includes(addPlan.route)
  ) {
    return (Array.isArray(advice.decisionPaths)
      ? advice.decisionPaths
      : []).find((plan) => plan?.route === addPlan.route) || null
  }
  if (String(decisionPlan.action || '').toUpperCase() === 'ADD') {
    return selected
  }
  return null
}

function blockedReasons(decisionPlan = {}) {
  const direct = Array.isArray(decisionPlan.blockedReasons)
    ? decisionPlan.blockedReasons
    : []
  const budget = Array.isArray(decisionPlan.entryBudget?.reasons)
    ? decisionPlan.entryBudget.reasons
    : []
  return [...new Set([...direct, ...budget]
    .map((value) => text(value, 160))
    .filter(Boolean))]
}

function instructionState({
  action,
  actionability,
  intent,
  candidate,
  plannedLots,
  blockers,
}) {
  if (!candidate || !(positive(candidate.entryPlan?.price))
    || !(finite(candidate.opportunityScore?.expectedNetR) > 0)
    || blockers.length || plannedLots <= 0) return 'NO_TRADE'
  const requiredAction = intent === 'ADD_POSITION' ? 'ADD' : 'BUY'
  if (
    action === requiredAction
    && ['READY', 'MANUAL_PROBE'].includes(actionability)
    && plannedLots > 0
  ) return 'READY'
  return 'WAIT_TRIGGER'
}

function timingOf({
  state,
  intent,
  candidate,
  observationPrice,
}) {
  const intentText = intent === 'ADD_POSITION' ? '加仓' : '建仓'
  const trigger = text(candidate?.entryPlan?.trigger)
  const confirmation = text(
    candidate?.entryPlan?.strategyPatternConfirmation?.summary,
  )
  if (state === 'READY') {
    return {
      headline: `现在可${intentText}`,
      explanation:
        `当前价格与账户条件已通过；人工核对最新报价后执行${intentText}。`,
    }
  }
  if (state === 'WAIT_TRIGGER') {
    if (candidate?.route === 'IMMEDIATE') return {
      headline: '下一交易时段重新评估',
      explanation: '当前为非执行时段；开盘后按新报价、账户和资金重新评估，不能直接按旧收盘价下单。',
    }
    return {
      headline: `到${observationPrice.toFixed(2)}元后复核`,
      explanation: [
        trigger,
        '首次到价后观察约60秒，再复核一次',
        confirmation,
      ].filter(Boolean).join('；') + '。',
    }
  }
  return {
    headline: `当前不${intentText}`,
    explanation: candidate
      ? '当前候选路径尚未同时满足正向费后价值、价格条件和账户约束。'
      : `当前没有形成合法的${intentText}路径。`,
  }
}

function priceOf({
  state,
  candidate,
  decisionPlan,
}) {
  const observationPrice = positive(candidate?.entryPlan?.price)
  const executablePrice = state === 'READY'
    ? observationPrice || positive(decisionPlan.prices?.reference)
    : null
  const stopPrice = candidate ? positive(candidate.exitPlan?.hardStopPrice) : null
  const targetPrice = candidate ? positive(candidate.exitPlan?.takeProfitPrice) : null
  const explanation = state === 'READY'
    ? `执行参考${executablePrice?.toFixed(2) || '--'}元，限价不高于该价格；超过后不追价，需重新评估。`
    : state === 'NO_TRADE' && observationPrice
      ? `候选参考${observationPrice.toFixed(2)}元尚未通过，不是买点；不据此创建买入预警。`
    : observationPrice
      ? `观察价${observationPrice.toFixed(2)}元，不是直接买入价；复核通过后按最新有效报价核定。`
      : '当前没有合法观察价，不创建买入预警。'
  return {
    observationPrice: rounded(observationPrice),
    executablePrice: rounded(executablePrice),
    maxBuyPrice: rounded(executablePrice),
    stopPrice: rounded(stopPrice),
    targetPrice: rounded(targetPrice),
    explanation,
  }
}

function quantityOf({
  state,
  intent,
  decisionPlan,
  blockers,
}) {
  const quantity = decisionPlan.quantity || {}
  const budget = decisionPlan.entryBudget || {}
  const existingLots = intent === 'ADD_POSITION'
    ? Math.max(0, Math.trunc(finite(quantity.holdingLots) || 0))
    : 0
  const executableLots = state === 'READY'
    ? Math.max(0, Math.trunc(finite(quantity.lots) || 0))
    : 0
  const estimatedLots = state === 'WAIT_TRIGGER'
    ? Math.max(0, Math.trunc(finite(budget.lots) || 0))
    : 0
  const plannedLots = executableLots || estimatedLots
  const allocation = decisionPlan.targetPosition
  const reservedBuyLots = Math.max(0, finite(allocation?.reservedBuyLots) || 0)
  const riskLimitedLots = finite(quantity.riskLimitedLots)
  const affordableLots = finite(quantity.affordableLots)
  const limitParts = [
    riskLimitedLots != null
      ? `风险预算最多${Math.max(0, Math.trunc(riskLimitedLots))}手`
      : '',
    affordableLots != null
      ? `现金与仓位最多${Math.max(0, Math.trunc(affordableLots))}手`
      : '',
  ].filter(Boolean)
  let explanation
  if (state === 'NO_TRADE') {
    explanation = `当前核定0手${
      blockers.length ? `，因为${blockers.join('；')}` : ''
    }。`
  } else if (intent === 'ADD_POSITION') {
    explanation = `当前持有${existingLots}手，${
      state === 'READY' ? '本次加仓' : '触发后预案加仓'
    }${plannedLots}手，完成后共${existingLots + plannedLots}手`
      + `${limitParts.length ? `；${limitParts.join('，')}，取较小值` : ''}。`
  } else {
    explanation = `${
      state === 'READY' ? '本次建仓' : '触发后预案建仓'
    }${plannedLots}手`
      + `${limitParts.length ? `；${limitParts.join('，')}，取较小值` : ''}。`
  }
  if (allocation?.state === 'READY' && state !== 'NO_TRADE') {
    explanation = `现有${existingLots}手${reservedBuyLots ? `，待买${reservedBuyLots}手` : ''}；`
      + `目标共${allocation.targetLots}手，本次${intent === 'ADD_POSITION' ? '加仓' : '建仓'}${plannedLots}手。`
      + `账户允许最多新增${allocation.capacityLots}手。`
      + (state === 'WAIT_TRIGGER' ? '这是预案，触价复核后重新核定。' : '')
  }
  return {
    plannedLots,
    executableLots,
    estimatedLots,
    existingLots,
    reservedBuyLots,
    targetLots: existingLots + reservedBuyLots + plannedLots,
    afterLots: existingLots + plannedLots,
    riskLimitedLots: rounded(riskLimitedLots, 0),
    affordableLots: rounded(affordableLots, 0),
    explanation,
  }
}

function expectedReturnOf({
  candidate,
  quantity,
  decisionPlan,
  price,
}) {
  const expectedNetR = finite(
    candidate?.opportunityScore?.expectedNetR,
  )
  const entryPrice = positive(candidate?.entryPlan?.price)
  const stopPrice = positive(price.stopPrice)
  const targetPrice = positive(price.targetPrice)
  const targetUpsidePct = entryPrice && targetPrice
    ? rounded((targetPrice / entryPrice - 1) * 100)
    : null
  const stopRiskPct = entryPrice && stopPrice
    ? rounded((entryPrice - stopPrice) / entryPrice * 100)
    : null
  const priceRiskPerShare = positive(
    candidate?.opportunityScore?.priceContract?.modelPriceRiskPerShare,
  ) || (entryPrice && stopPrice ? Math.max(0, entryPrice - stopPrice) : null)
  const riskAmount = priceRiskPerShare && quantity.plannedLots > 0
    ? priceRiskPerShare * 100 * quantity.plannedLots
    : null
  const allocation = decisionPlan.targetPosition?.state === 'READY'
    && quantity.plannedLots === decisionPlan.targetPosition.recommendedLots
    ? decisionPlan.targetPosition.selected : null
  const expectedNetAmount = finite(allocation?.expectedNetAmount) ?? ((
    riskAmount != null && expectedNetR != null
  ) ? rounded(riskAmount * expectedNetR, 2) : null)
  const parts = []
  if (targetPrice && targetUpsidePct != null) {
    parts.push(
      `达到目标价${targetPrice.toFixed(2)}元对应`
      + `${targetUpsidePct.toFixed(2)}%价格空间`,
    )
  }
  if (expectedNetR != null) {
    parts.push(
      `若成交，同类路径费后平均结果为每承担1元止损风险预计${
        expectedNetR >= 0 ? '赚' : '亏'
      }${Math.abs(expectedNetR).toFixed(2)}元`,
    )
  }
  if (expectedNetAmount != null) {
    parts.push(
      `按${quantity.plannedLots}手折算平均约${
        expectedNetAmount >= 0 ? '赚' : '亏'
      }${Math.abs(expectedNetAmount).toFixed(0)}元`,
    )
  }
  if (allocation) {
    parts.push(`本次新增资金约${allocation.requiredCash.toFixed(0)}元`)
    parts.push(`若到目标价，扣费与估计冲击后约${allocation.targetNetProfit >= 0 ? '赚' : '亏'}${Math.abs(allocation.targetNetProfit).toFixed(0)}元；这不是平均预期`)
    parts.push(`按计划止损约亏${allocation.stopLossAmount.toFixed(0)}元；跳空、跌停和T+1可能扩大实际损失`)
  }
  if (!parts.length) {
    parts.push('当前模型结果不完整，不能估算预期收益')
  }
  const explanation = allocation
    ? `新增投入约${allocation.requiredCash.toFixed(0)}元；若成交，模型平均估计${expectedNetAmount >= 0 ? '赚' : '亏'}${Math.abs(expectedNetAmount).toFixed(0)}元。`
      + `到目标${targetPrice.toFixed(2)}元约${allocation.targetNetProfit >= 0 ? '赚' : '亏'}${Math.abs(allocation.targetNetProfit).toFixed(0)}元，计划止损约亏${allocation.stopLossAmount.toFixed(0)}元。`
      + '目标收益不等于平均收益；T+1、跳空和跌停可能扩大损失。'
    : `${parts.join('；')}。`
  return {
    expectedNetR,
    expectedNetAmount,
    targetUpsidePct,
    stopRiskPct,
    riskAmount: rounded(riskAmount, 0),
    requiredCash: allocation?.requiredCash ?? null,
    targetNetProfit: allocation?.targetNetProfit ?? null,
    stopLossAmount: allocation?.stopLossAmount ?? null,
    expectedNetPct: allocation?.requiredCash > 0
      ? rounded(expectedNetAmount / allocation.requiredCash * 100) : null,
    estimateBasis: 'MODEL_PRICE_RISK',
    horizonLabel: '沿用所选路径的模型结算窗口，并非承诺持有天数或固定退出日',
    explanation,
  }
}

export function buildEntryInstruction({
  advice = {},
  decisionPlan = {},
} = {}) {
  const holding = ['hold_advice', 'review'].includes(decisionPlan.mode)
  const intent = holding ? 'ADD_POSITION' : 'BUILD_POSITION'
  const intentLabel = holding ? '加仓' : '建仓'
  const candidate = candidatePlan(advice, holding, decisionPlan)
  const action = text(decisionPlan.action, 24).toUpperCase()
  const actionability = text(
    decisionPlan.actionability,
    24,
  ).toUpperCase()
  const blockers = blockedReasons(decisionPlan)
  const provisionalLots = Math.max(
    0,
    Math.trunc(finite(
      ['READY', 'MANUAL_PROBE'].includes(actionability)
        ? decisionPlan.quantity?.lots
        : decisionPlan.entryBudget?.lots,
    ) || 0),
  )
  const state = instructionState({
    action,
    actionability,
    intent,
    candidate,
    plannedLots: provisionalLots,
    blockers,
  })
  const observationPrice = positive(candidate?.entryPlan?.price)
  const timing = timingOf({
    state,
    intent,
    candidate,
    observationPrice,
  })
  const price = priceOf({ state, candidate, decisionPlan })
  const quantity = quantityOf({
    state,
    intent,
    decisionPlan,
    blockers,
  })
  const expectedReturn = expectedReturnOf({
    candidate,
    quantity,
    decisionPlan,
    price,
  })
  return {
    schemaVersion: ENTRY_INSTRUCTION_VERSION,
    intent,
    intentLabel,
    state,
    validUntil: typeof decisionPlan.validUntil === 'string'
      ? Date.parse(decisionPlan.validUntil) || null
      : finite(decisionPlan.validUntil),
    route: text(candidate?.route, 24).toUpperCase() || null,
    routeLabel: candidate ? routeLabel(candidate.route) : null,
    timing,
    price,
    quantity,
    expectedReturn,
    targetPosition: decisionPlan.targetPosition || null,
    blockers,
    modelBoundary:
      '观察价不是下单价。目标仓位按现役路径预测与流动性假设优化；平均收益为估计，不保证实现。触价复核后重新核定价格与手数。',
    summary: [
      timing.headline,
      timing.explanation,
      price.explanation,
      quantity.explanation,
      expectedReturn.explanation,
    ].join('；'),
  }
}
