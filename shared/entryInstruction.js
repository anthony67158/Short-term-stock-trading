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

function candidatePlan(advice = {}, holding = false) {
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
  if (String(advice.decisionPlan?.action || '').toUpperCase() === 'ADD') {
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
  const requiredAction = intent === 'ADD_POSITION' ? 'ADD' : 'BUY'
  if (
    action === requiredAction
    && ['READY', 'MANUAL_PROBE'].includes(actionability)
    && plannedLots > 0
  ) return 'READY'
  if (!candidate) return 'NO_TRADE'
  if (!(finite(candidate.opportunityScore?.expectedNetR) > 0)) {
    return 'NO_TRADE'
  }
  if (blockers.length || plannedLots <= 0) return 'NO_TRADE'
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
    return {
      headline: `到${observationPrice.toFixed(2)}元后复核`,
      explanation: [
        trigger,
        `价格首次到达${observationPrice.toFixed(2)}元后观察约60秒`,
        '重新采集价格、量能和资金后只复核一次',
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
  const stopPrice = positive(candidate?.exitPlan?.hardStopPrice)
    || positive(decisionPlan.prices?.stop)
  const targetPrice = positive(candidate?.exitPlan?.takeProfitPrice)
    || positive(decisionPlan.prices?.target)
  const explanation = state === 'READY'
    ? `执行参考${executablePrice?.toFixed(2) || '--'}元；最终以人工记录的真实成交价为准。`
    : observationPrice
      ? `观察价${observationPrice.toFixed(2)}元，不是直接买入价；复核通过后按最新有效报价核定。`
      : '当前没有合法观察价，不创建买入预警。'
  return {
    observationPrice: rounded(observationPrice),
    executablePrice: rounded(executablePrice),
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
  return {
    plannedLots,
    executableLots,
    estimatedLots,
    existingLots,
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
  const expectedNetR = rounded(
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
  const lossPerLot = positive(decisionPlan.risk?.estimatedLossPerLot)
  const riskAmount = lossPerLot && quantity.plannedLots > 0
    ? lossPerLot * quantity.plannedLots
    : null
  const expectedNetAmount = (
    riskAmount != null && expectedNetR != null
  ) ? rounded(riskAmount * expectedNetR, 0) : null
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
  if (!parts.length) {
    parts.push('当前模型结果不完整，不能估算预期收益')
  }
  return {
    expectedNetR,
    expectedNetAmount,
    targetUpsidePct,
    stopRiskPct,
    riskAmount: rounded(riskAmount, 0),
    explanation: `${parts.join('；')}。`,
  }
}

export function buildEntryInstruction({
  advice = {},
  decisionPlan = {},
} = {}) {
  const holding = ['hold_advice', 'review'].includes(decisionPlan.mode)
  const intent = holding ? 'ADD_POSITION' : 'BUILD_POSITION'
  const intentLabel = holding ? '加仓' : '建仓'
  const candidate = candidatePlan(advice, holding)
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
    route: text(candidate?.route, 24).toUpperCase() || null,
    routeLabel: candidate ? routeLabel(candidate.route) : null,
    timing,
    price,
    quantity,
    expectedReturn,
    blockers,
    modelBoundary:
      '观察价由行情结构生成；触价后重新运行生产模型，只有费后平均结果仍为正才核定执行价和手数。',
    summary: [
      timing.headline,
      timing.explanation,
      price.explanation,
      quantity.explanation,
      expectedReturn.explanation,
    ].join('；'),
  }
}
