import {
  buildEntryInstruction,
} from './entryInstruction.js'

export const DECISION_RATIONALE_VERSION = 'decision-rationale.v1'

const ROUTE_LABELS = Object.freeze({
  IMMEDIATE: '现价执行',
  PULLBACK: '回踩确认',
  BREAKOUT: '突破确认',
})

const ACTION_LABELS = Object.freeze({
  BUY: '买入',
  ADD: '加仓',
  HOLD: '继续持有',
  REDUCE: '减仓',
  EXIT: '退出',
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
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

function actionLabel(value) {
  return ACTION_LABELS[String(value || '').toUpperCase()]
    || '当前动作'
}

function signed(value) {
  const number = rounded(value)
  if (number == null) return '--'
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}`
}

function probabilityCount(value) {
  const number = finite(value)
  return number != null && number >= 0 && number <= 1
    ? Math.round(number * 100)
    : null
}

function pricePath(plan = {}, selectedRoute = '') {
  const route = text(plan.route, 24).toUpperCase()
  const entryPrice = rounded(plan.entryPlan?.price)
  const stopPrice = rounded(plan.exitPlan?.hardStopPrice)
  const targetPrice = rounded(plan.exitPlan?.takeProfitPrice)
  const score = plan.opportunityScore || {}
  const fillCount = probabilityCount(score.pFill)
  const winCount = probabilityCount(score.pWinGivenFill)
  const expectedNetR = rounded(score.expectedNetR)
  const parts = []
  if (fillCount != null) parts.push(`每100次触发约${fillCount}次成交`)
  if (winCount != null) parts.push(`成交后每100笔约${winCount}笔盈利`)
  if (expectedNetR != null) {
    parts.push(
      `每1份计划风险平均${expectedNetR >= 0 ? '赚' : '亏'}`
      + `${Math.abs(expectedNetR).toFixed(2)}份`,
    )
  }
  const allocation = plan.targetPosition
  if (allocation?.state === 'READY') {
    parts.push(`建议${allocation.recommendedLots}手；若成交，新增部分平均约${allocation.selected.expectedNetAmount.toFixed(0)}元`)
    parts.push(`计入未成交可能后的机会价值约${allocation.selected.opportunityNetAmount.toFixed(0)}元`)
  } else if (allocation) parts.push(allocation.reason)
  return {
    route,
    label: routeLabel(route),
    selected: route === selectedRoute,
    entryPrice,
    stopPrice,
    targetPrice,
    trigger: text(plan.entryPlan?.trigger),
    riskReward: rounded(plan.riskReward),
    expectedNetR,
    targetPosition: allocation || null,
    explanation: parts.join('；'),
  }
}

function actionComparison(
  value = {},
  selectedAction = '',
  optimization = null,
) {
  const action = text(value.action, 24).toUpperCase()
  const rawActionUtilityR = finite(value.actionUtilityR)
  const actionUtilityR = rounded(rawActionUtilityR)
  const candidate = value.positionCandidate
  const optimized = (
    optimization?.schemaVersion === 'position-optimization.v2'
    && optimization?.state === 'READY'
    && candidate
  )
  const relative = ['REDUCE', 'EXIT'].includes(action)
  const improvementOverHoldR = optimized
    ? rounded(
        rawActionUtilityR
        - Number(optimization.holdUtilityR),
        3,
      )
    : relative ? actionUtilityR : null
  const explanation = optimized
    ? [
        candidate.sellLots > 0
          ? `卖出${candidate.sellLots}手、保留${candidate.retainedLots}手`
          : `保留${candidate.retainedLots}手`,
        `剩余上涨价值${signed(candidate.remainingExpectedR)}R`,
        `尾部风险扣减${Math.abs(
          rounded(candidate.remainingTailPenaltyR) || 0,
        ).toFixed(2)}R`,
        `费用与换手扣减${Math.abs(rounded(
          Number(candidate.sellCostR)
          + Number(candidate.switchPenaltyR),
        ) || 0).toFixed(2)}R`,
        `净动作价值${signed(actionUtilityR)}R`,
        action === 'HOLD'
          ? ''
          : `相对继续持有${improvementOverHoldR >= 0 ? '改善' : '变差'}${
            Math.abs(improvementOverHoldR).toFixed(2)
          }R`,
      ].filter(Boolean).join('；')
    : actionUtilityR == null
    ? '当前缺少可比较的动作价值'
    : relative
      ? `相对继续持有${actionUtilityR >= 0 ? '改善' : '变差'}`
        + `${Math.abs(actionUtilityR).toFixed(2)}份计划风险`
      : `${actionLabel(action)}的预计价值为${signed(actionUtilityR)}份计划风险`
  return {
    action,
    label: actionLabel(action),
    selected: action === selectedAction,
    feasible: value.feasible === true,
    actionUtilityR,
    sellLots: optimized ? candidate.sellLots : null,
    retainedLots: optimized ? candidate.retainedLots : null,
    improvementOverHoldR,
    components: optimized ? {
      remainingExpectedR: rounded(candidate.remainingExpectedR),
      remainingTailPenaltyR:
        rounded(candidate.remainingTailPenaltyR),
      sellCostR: rounded(candidate.sellCostR),
      switchPenaltyR: rounded(candidate.switchPenaltyR),
    } : null,
    explanation,
  }
}

function entryQuantity(decisionPlan = {}, selectedPlan = {}) {
  const quantity = decisionPlan.quantity || {}
  const budget = decisionPlan.entryBudget || {}
  const executableLots = Math.max(
    0,
    Math.trunc(finite(quantity.lots) || 0),
  )
  const estimatedLots = Math.max(
    0,
    Math.trunc(finite(budget.lots) || 0),
  )
  const lots = executableLots || estimatedLots
  const riskLimitedLots = finite(quantity.riskLimitedLots)
  const affordableLots = finite(quantity.affordableLots)
  const lossPerLot = finite(decisionPlan.risk?.estimatedLossPerLot)
  const maxLossAmount = finite(decisionPlan.risk?.maxLossAmount)
  const blockedReasons = Array.isArray(decisionPlan.blockedReasons)
    ? decisionPlan.blockedReasons
      .map((value) => text(value, 160))
      .filter(Boolean)
    : []
  const parts = []
  if (riskLimitedLots != null) {
    parts.push(`风险预算最多${Math.max(0, Math.trunc(riskLimitedLots))}手`)
  }
  if (affordableLots != null) {
    parts.push(`现金与仓位最多${Math.max(0, Math.trunc(affordableLots))}手`)
  }
  if (lossPerLot != null) {
    parts.push(`单手止损约${Math.round(lossPerLot)}元`)
  }
  if (maxLossAmount != null) {
    parts.push(`本笔风险上限${Math.round(maxLossAmount)}元`)
  }
  if (lots <= 0 && blockedReasons.length) {
    parts.push(`当前为0手，因为${blockedReasons.join('；')}`)
  } else if (
    lots <= 0
    && finite(selectedPlan.opportunityScore?.expectedNetR) <= 0
  ) {
    parts.push('当前为0手，因为该价格路径扣除费用后的平均结果不为正')
  } else if (
    lots <= 0
    && decisionPlan.actionability === 'WATCH'
  ) {
    parts.push('当前为0手，因为价格触发条件尚未成立')
  } else {
    parts.push(
      `${executableLots > 0 ? '最终核定' : '当前预案'}${lots}手`
      + '，取风险、现金和仓位上限中的较小值',
    )
  }
  return {
    lots,
    executableLots,
    estimatedLots,
    riskLimitedLots: rounded(riskLimitedLots, 0),
    affordableLots: rounded(affordableLots, 0),
    estimatedLossPerLot: rounded(lossPerLot, 0),
    maxLossAmount: rounded(maxLossAmount, 0),
    blockedReasons,
    estimatedAmount: rounded(
      decisionPlan.costs?.estimatedNetAmount
      ?? budget.costs?.estimatedNetAmount,
      0,
    ),
    explanation: `${parts.join('；')}。`,
  }
}

function positionQuantity(decisionPlan = {}) {
  const quantity = decisionPlan.quantity || {}
  const action = text(decisionPlan.action, 24).toUpperCase()
  const holdingLots = Math.max(
    0,
    Math.trunc(finite(quantity.holdingLots) || 0),
  )
  const sellableLots = Math.max(
    0,
    Math.trunc(finite(quantity.sellableLots) || 0),
  )
  const lots = Math.max(
    0,
    Math.trunc(finite(quantity.lots) || 0),
  )
  const explanation = ['REDUCE', 'EXIT'].includes(action)
    ? `当前持有${holdingLots}手，今日可卖${sellableLots}手，本次${
        actionLabel(action)
      }${lots}手；手数不超过今日可卖数量。`
    : `当前持有${holdingLots}手，本次不交易；账本止损和T+1约束继续有效。`
  return {
    lots,
    holdingLots,
    sellableLots,
    remainingLots: Math.max(
      0,
      Math.trunc(finite(quantity.remainingLots) || 0),
    ),
    explanation,
  }
}

export function buildDecisionRationale({
  advice = {},
  decisionPlan = {},
} = {}) {
  const action = text(decisionPlan.action, 24).toUpperCase()
  const entryContext = (
    decisionPlan.mode === 'buy_advice'
    || ['BUY', 'ADD'].includes(action)
  )
  const context = entryContext ? 'ENTRY' : 'POSITION'
  const selected = advice.selectedDecisionPlan || {}
  const selectedRoute = text(selected.route, 24).toUpperCase()
  const currentPrice = rounded(decisionPlan.prices?.current)
  const referencePrice = rounded(
    entryContext
      ? selected.entryPlan?.price ?? decisionPlan.prices?.reference
      : decisionPlan.prices?.reference,
  )
  const distancePct = (
    currentPrice > 0 && referencePrice > 0
  ) ? rounded((referencePrice / currentPrice - 1) * 100) : null
  const trigger = text(selected.entryPlan?.trigger || decisionPlan.trigger)
  const priceExplanation = referencePrice > 0
    ? `${routeLabel(selectedRoute)}候选价${referencePrice.toFixed(2)}元`
      + `${trigger ? `，依据“${trigger}”` : ''}。`
    : '当前没有形成可执行的候选价格。'
  const pathComparison = entryContext
    ? (Array.isArray(advice.decisionPaths)
        ? advice.decisionPaths
        : [])
      .map((plan) => pricePath(plan, selectedRoute))
    : []
  const actionValues = Array.isArray(advice.actionValues?.actions)
    ? advice.actionValues.actions
    : []
  const positionOptimization =
    advice.actionValues?.positionOptimization
  const actionComparisons = context === 'POSITION'
    ? actionValues
      .filter((value) => (
        ['HOLD', 'REDUCE', 'EXIT'].includes(
          String(value?.action || '').toUpperCase(),
        )
      ))
      .map((value) => actionComparison(
        value,
        action,
        positionOptimization,
      ))
    : []
  const quantity = entryContext
    ? entryQuantity(decisionPlan, selected)
    : positionQuantity(decisionPlan)
  const entryInstruction = buildEntryInstruction({
    advice,
    decisionPlan,
  })
  const selectedAction = actionComparisons.find((item) => item.selected)
  const modelBoundary = entryContext
    ? '候选价由行情结构和波动约束生成；模型只评估每条价格路径，不直接生成价格。'
    : positionOptimization?.schemaVersion
      === 'position-optimization.v2'
      ? '持仓动作由离散仓位优化器比较剩余上涨、尾部风险、真实费用与换手成本；底层收益和风险仍来自现役机会模型，不是独立训练的卖出概率。'
    : '持仓动作值由现役机会模型结果换算，用于比较继续持有、减仓和退出；它不是独立训练的卖出概率。'
  const summary = context === 'ENTRY'
    ? entryInstruction.summary
    : `${selectedAction?.explanation || `${actionLabel(action)}等待重新评估`}；${
        entryInstruction.summary
      }；${quantity.explanation}`
  return {
    schemaVersion: DECISION_RATIONALE_VERSION,
    context,
    action,
    actionLabel: actionLabel(action),
    entryInstruction,
    price: {
      selectedRoute,
      routeLabel: routeLabel(selectedRoute),
      currentPrice,
      referencePrice,
      stopPrice: rounded(
        entryContext
          ? selected.exitPlan?.hardStopPrice
            ?? decisionPlan.prices?.stop
          : decisionPlan.prices?.stop,
      ),
      targetPrice: rounded(
        entryContext
          ? selected.exitPlan?.takeProfitPrice
            ?? decisionPlan.prices?.target
          : decisionPlan.prices?.target,
      ),
      distancePct,
      trigger,
      explanation: priceExplanation,
      modelBoundary: entryContext ? modelBoundary : '',
    },
    pathComparison,
    actionComparison: actionComparisons,
    quantity,
    modelBoundary,
    summary,
  }
}
