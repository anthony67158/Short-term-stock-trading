export const KNOWLEDGE_ACTION_VERSION = 1

export const KNOWLEDGE_ACTION_WEIGHTS = Object.freeze({
  executability: 20,
  logicConsistency: 20,
  falsifiability: 20,
  disciplineCompliance: 25,
  reviewability: 15,
})

const text = (value, max = 1600) =>
  String(value || '').trim().slice(0, max)

const finite = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function firstText(...values) {
  return values.map((value) => text(value)).find(Boolean) || ''
}

function actionSide(action) {
  const value = text(action, 80)
  if (/减仓|清仓|卖出|止损|离场/.test(value)) return 'sell'
  if (/买入|建仓|加仓|补仓|低吸|试错|接回|买回/.test(value)) return 'buy'
  return null
}

function quantityOf(value) {
  const match = text(value, 120).match(/(\d+(?:\.\d+)?)\s*手/)
  return match ? Number(match[1]) : null
}

function zoneOf(advice, kind) {
  const zone = advice?.continuity?.zones?.[kind]
  if (!zone || typeof zone !== 'object') return null
  const low = finite(zone.low)
  const high = finite(zone.high)
  if (low == null || high == null) return null
  return { low, high, anchor: finite(zone.anchor) }
}

function scoreGrade(total) {
  if (total >= 85) return '知行合一'
  if (total >= 70) return '基本一致'
  if (total >= 55) return '存在脱节'
  return '不可执行'
}

export function buildKnowledgeActionPlan(advice = {}, options = {}) {
  const provided = advice.knowledgeActionPlan
    && typeof advice.knowledgeActionPlan === 'object'
    ? advice.knowledgeActionPlan
    : {}
  const action = firstText(
    advice.action,
    advice.stance,
    advice.tier,
    provided.action,
  )
  const invalidation = firstText(
    advice.invalidation,
    provided.invalidation,
  )
  const validationWindow = firstText(
    advice.validationWindow,
    provided.validationWindow,
    options.mode === 't_advice' ? '本交易日' : '3个交易日',
  )
  const researchLogic = firstText(
    advice.reason,
    advice.reasoning,
    provided.researchLogic,
  )
  const triggerConditions = firstText(
    advice.timing,
    advice.exitTiming,
    advice.actionPlan,
    advice.nextAction,
    provided.triggerConditions,
  )
  const positionRule = firstText(
    advice.positionNote,
    advice.planWeight,
    advice.posAfter,
    provided.positionRule,
  )
  const riskPoints = firstText(
    advice.risk,
    advice.bearCase,
    provided.riskPoints,
  )
  const exitConditions = firstText(
    advice.exitTiming,
    advice.futurePlan,
    provided.exitConditions,
  )
  const stopPrice = finite(
    advice.stopPrice
      ?? provided.stopLoss?.price
      ?? provided.stopPrice,
  )
  const targetPrice = finite(
    advice.targetPrice
      ?? advice.reducePrice
      ?? provided.takeProfit?.price
      ?? provided.targetPrice,
  )
  const falsifiableClaim = invalidation
    ? firstText(
        provided.falsifiableClaim,
        `若${invalidation}，则原交易逻辑失效，必须停止执行并重新评估`,
      )
    : ''
  const preTradeChecklist = [
    researchLogic ? '交易逻辑有数据依据' : '',
    triggerConditions ? '触发条件已满足' : '',
    positionRule ? '仓位符合事前上限' : '',
    stopPrice != null || invalidation ? '退出与失效规则明确' : '',
    validationWindow ? '验证周期已定义' : '',
  ].filter(Boolean)

  return {
    version: KNOWLEDGE_ACTION_VERSION,
    principle: '先定义，再行动；先守纪律，再谈收益；用结果校正认知，不用结果粉饰认知',
    action,
    researchLogic,
    executionPlan: firstText(
      advice.actionPlan,
      advice.nextAction,
      advice.timing,
      provided.executionPlan,
    ),
    triggerConditions,
    positionRule,
    riskPoints,
    stopLoss: {
      price: stopPrice,
      condition: firstText(
        advice.exitTiming,
        invalidation,
        provided.stopLoss?.condition,
      ),
    },
    takeProfit: {
      price: targetPrice,
      condition: firstText(
        advice.exitTiming,
        advice.futurePlan,
        provided.takeProfit?.condition,
      ),
    },
    exitConditions,
    invalidation,
    validationWindow,
    falsifiableClaim,
    preTradeChecklist,
    plannedQuantity: finite(
      advice.planQty
        ?? provided.plannedQuantity,
    ) ?? quantityOf(
      advice.planQty
        ?? provided.plannedQuantity
        ?? advice.opQty,
    ),
    entryZone: zoneOf(advice, 'add'),
    reduceZone: zoneOf(advice, 'reduce'),
  }
}

export function scoreKnowledgeActionPlan(plan = {}) {
  const missing = []
  if (!plan.researchLogic) missing.push('交易逻辑')
  if (!plan.action) missing.push('交易动作')
  if (!plan.triggerConditions) missing.push('触发条件')
  if (!plan.positionRule) missing.push('仓位规则')
  if (!plan.riskPoints) missing.push('风险点')
  if (plan.stopLoss?.price == null && !plan.stopLoss?.condition) missing.push('止损/退出规则')
  if (plan.takeProfit?.price == null && !plan.takeProfit?.condition) missing.push('止盈规则')
  if (!plan.invalidation) missing.push('策略失效条件')
  if (!plan.validationWindow) missing.push('验证周期')

  const action = text(plan.action, 80)
  const execution = text(plan.executionPlan, 1000)
  const contradiction = (
    /买入|加仓|补仓/.test(action)
    && /清仓|卖出|减仓/.test(execution)
  ) || (
    /清仓|卖出|减仓/.test(action)
    && /买入|加仓|补仓/.test(execution)
  )
  const dimensions = {
    executability: {
      max: KNOWLEDGE_ACTION_WEIGHTS.executability,
      score: (plan.action ? 5 : 0)
        + (plan.triggerConditions ? 7 : 0)
        + (plan.positionRule ? 4 : 0)
        + (plan.executionPlan ? 4 : 0),
    },
    logicConsistency: {
      max: KNOWLEDGE_ACTION_WEIGHTS.logicConsistency,
      score: contradiction
        ? 5
        : (plan.researchLogic ? 8 : 0)
          + (plan.action ? 4 : 0)
          + (plan.executionPlan ? 4 : 0)
          + (plan.riskPoints ? 4 : 0),
    },
    falsifiability: {
      max: KNOWLEDGE_ACTION_WEIGHTS.falsifiability,
      score: plan.invalidation
        ? 10
          + (plan.validationWindow ? 5 : 0)
          + (plan.falsifiableClaim ? 5 : 0)
        : 0,
    },
    disciplineCompliance: {
      max: KNOWLEDGE_ACTION_WEIGHTS.disciplineCompliance,
      score: (plan.positionRule ? 7 : 0)
        + (plan.riskPoints ? 5 : 0)
        + (plan.stopLoss?.price != null || plan.stopLoss?.condition ? 5 : 0)
        + (plan.takeProfit?.price != null || plan.takeProfit?.condition ? 4 : 0)
        + (plan.exitConditions ? 4 : 0),
    },
    reviewability: {
      max: KNOWLEDGE_ACTION_WEIGHTS.reviewability,
      score: (plan.researchLogic ? 5 : 0)
        + (plan.validationWindow ? 5 : 0)
        + (plan.preTradeChecklist?.length >= 4 ? 5 : 0),
    },
  }
  const total = Object.values(dimensions).reduce(
    (sum, item) => sum + item.score,
    0,
  )
  return {
    version: KNOWLEDGE_ACTION_VERSION,
    total,
    grade: scoreGrade(total),
    dimensions,
    missing,
  }
}

export function buildJudgeKnowledgeActionAssessment(
  advice,
  candidate = null,
) {
  const plan = advice?.version
    ? advice
    : buildKnowledgeActionPlan(advice || {})
  const baseline = scoreKnowledgeActionPlan(plan)
  const candidateDimensions = candidate?.dimensions || {}
  const dimensions = {}
  for (const [key, weight] of Object.entries(KNOWLEDGE_ACTION_WEIGHTS)) {
    const proposedRaw = candidateDimensions[key]
    const proposed = finite(
      proposedRaw && typeof proposedRaw === 'object'
        ? proposedRaw.score
        : proposedRaw,
    )
    const baselineScore = baseline.dimensions[key].score
    dimensions[key] = {
      max: weight,
      score: proposed == null
        ? baselineScore
        : Math.max(0, Math.min(weight, baselineScore, Math.round(proposed))),
    }
  }
  const total = Object.values(dimensions).reduce(
    (sum, item) => sum + item.score,
    0,
  )
  const stringList = (value) => (Array.isArray(value) ? value : [])
    .map((item) => text(item, 200))
    .filter(Boolean)
    .slice(0, 8)
  return {
    version: KNOWLEDGE_ACTION_VERSION,
    total,
    grade: scoreGrade(total),
    dimensions,
    missing: baseline.missing,
    findings: stringList(candidate?.findings),
    violations: stringList(candidate?.violations),
    principle: '先定义，再行动；先守纪律，再谈收益',
  }
}

export function latestKnowledgeActionReview(events, code) {
  let latest = null
  for (const event of Array.isArray(events) ? events : []) {
    if (
      event?.kind !== 'execution'
      || event.code !== code
      || !event.knowledgeActionReview
    ) continue
    if (!latest || (event.at || 0) >= (latest.at || 0)) latest = event
  }
  return latest?.knowledgeActionReview || null
}

export function evaluateKnowledgeActionCycle({
  plan,
  execution = {},
  outcome = {},
} = {}) {
  const normalizedPlan = plan?.version
    ? plan
    : buildKnowledgeActionPlan(plan || {})
  const planScore = scoreKnowledgeActionPlan(normalizedPlan)
  const violations = []
  const expectedSide = actionSide(normalizedPlan.action)
  const side = execution.side === 'sell' ? 'sell' : 'buy'
  const price = finite(execution.price)
  const qty = finite(execution.qty)
  const stop = finite(normalizedPlan.stopLoss?.price)
  const target = finite(normalizedPlan.takeProfit?.price)
  const disciplinedStop = side === 'sell'
    && price != null
    && stop != null
    && price <= stop * 1.02
    && price >= stop * 0.97

  if (expectedSide && side !== expectedSide && !disciplinedStop) {
    violations.push('执行方向与事前动作不一致')
  }
  if (
    qty != null
    && normalizedPlan.plannedQuantity != null
    && qty > normalizedPlan.plannedQuantity
  ) {
    violations.push('实际手数超过事前计划')
  }
  if (
    side === 'buy'
    && price != null
    && normalizedPlan.entryZone
    && (
      price < normalizedPlan.entryZone.low * 0.995
      || price > normalizedPlan.entryZone.high * 1.005
    )
  ) {
    violations.push('买入价偏离事前触发区间')
  }
  if (side === 'sell' && price != null && stop != null && price < stop * 0.97) {
    violations.push('跌破止损后延迟执行')
  }

  let executionScore = 100
  for (const violation of violations) {
    if (/手数/.test(violation)) executionScore -= 45
    else if (/方向/.test(violation)) executionScore -= 35
    else if (/止损/.test(violation)) executionScore -= 30
    else executionScore -= 20
  }
  executionScore = Math.max(0, executionScore)

  const pnl = finite(outcome.pnl)
  const luckyProfit = violations.length > 0 && pnl != null && pnl > 0
  let attribution = 'randomness'
  if (violations.length) attribution = 'execution_error'
  else if (!outcome.validationComplete) attribution = 'randomness'
  else if (outcome.invalidated || disciplinedStop) attribution = 'judgment_error'
  else if (
    outcome.targetHit
    || (
      side === 'sell'
      && price != null
      && target != null
      && price >= target * 0.995
    )
  ) attribution = 'plan_validated'

  const labels = {
    plan_validated: '计划验证',
    judgment_error: '认知错误',
    execution_error: '执行错误',
    randomness: '偶然波动',
  }
  let summary
  if (luckyProfit) {
    summary = '本次虽有盈利，但违反事前仓位或执行规则，盈利不能掩盖低质量执行'
  } else if (disciplinedStop) {
    summary = '已按事前止损纪律退出；执行正确，亏损用于校正原交易认知'
  } else if (!outcome.validationComplete) {
    summary = '验证周期尚未结束，当前盈亏只视为偶然波动，不提前给交易质量下结论'
  } else if (attribution === 'plan_validated') {
    summary = '交易按计划执行并完成验证，结果支持原交易逻辑'
  } else if (attribution === 'execution_error') {
    summary = `执行偏离事前规则：${violations.join('、')}`
  } else {
    summary = '执行遵守计划，但结果否定原假设，应校正研究认知而非追责执行'
  }

  return {
    version: KNOWLEDGE_ACTION_VERSION,
    planScore: planScore.total,
    cognitiveScore: planScore.total,
    executionScore,
    overallScore: Math.round(planScore.total * 0.4 + executionScore * 0.6),
    disciplineVerdict: executionScore >= 85
      ? '严格执行'
      : executionScore >= 65 ? '基本执行' : '纪律失守',
    attribution,
    attributionLabel: labels[attribution],
    violations,
    luckyProfit,
    pnl,
    summary,
    principle: '先守纪律，再谈收益',
  }
}
