import {
  actionabilityLabel,
  humanizeAdviceTextFields,
  marketRegimeLabel,
  strategyStateLabel,
} from './userFacingLanguage.js'

const clean = (value, limit = 800) => {
  if (value == null) return ''
  const result = String(value).trim().replace(/\s+/g, ' ')
  return result.length > limit
    ? `${result.slice(0, limit - 1)}…`
    : result
}

const first = (...values) =>
  values.map((value) => clean(value)).find(Boolean) || ''

const displayNumber = (value) => {
  if (value == null || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return clean(value, 120)
}

const quantity = (advice) => {
  const direct = first(advice.opQty)
  if (direct) return direct
  const planned = displayNumber(advice.planQty)
  if (!planned || planned === '0') return ''
  return /手/.test(planned) ? planned : `${planned}手`
}

function uniqueItems(items, limit = Infinity) {
  const values = new Set()
  const result = []
  for (const item of items) {
    const value = clean(item?.value ?? item?.text)
    if (!value || values.has(value)) continue
    values.add(value)
    result.push(item.value == null ? { ...item, text: value } : {
      ...item,
      value,
    })
    if (result.length >= limit) break
  }
  return result
}

function priceLevels(advice) {
  const entry = first(advice.buyZone, advice.buyPrice, advice.addPrice)
  const entryLabel = advice.buyZone
    ? '买入区间'
    : advice.buyPrice != null
      ? '建议买入价'
      : '加仓参考'
  return uniqueItems([
    entry && {
      key: 'entry',
      label: entryLabel,
      value: entry,
      tone: 'red',
    },
    advice.watchPrice != null
      && clean(advice.watchPrice, 200).length <= 24
      && {
      key: 'watch',
      label: '关注价',
      value: displayNumber(advice.watchPrice),
      tone: 'muted',
    },
    advice.reducePrice != null && {
      key: 'reduce',
      label: '减仓参考',
      value: displayNumber(advice.reducePrice),
      tone: 'green',
    },
    advice.targetPrice != null && {
      key: 'target',
      label: '目标价',
      value: displayNumber(advice.targetPrice),
      tone: 'red',
    },
    advice.stopPrice != null && {
      key: 'stop',
      label: '止损价',
      value: displayNumber(advice.stopPrice),
      tone: 'green',
    },
  ].filter(Boolean), 4)
}

function coreEvidence(advice) {
  return uniqueItems([
    { key: 'quant', label: '量化', text: clean(advice.quantNote, 180) },
    { key: 'fund', label: '资金', text: clean(advice.fundNote, 180) },
    { key: 'trend', label: '趋势', text: clean(advice.techNote, 180) },
    { key: 'news', label: '消息', text: clean(advice.newsNote, 180) },
  ], 3)
}

function modelSummary(advice) {
  const context = advice.quantContext
  if (!context || typeof context !== 'object') return null
  const reliability = context.reliability || {}
  const next30m = displayNumber(
    reliability.balancedAccuracyPct?.next30m,
  )
  const sessionClose = displayNumber(
    reliability.balancedAccuracyPct?.sessionClose,
  )
  const threshold = displayNumber(reliability.thresholdPct)
  const reliabilityText = next30m || sessionClose || threshold
    ? `30分钟 ${next30m || '—'}% · 收盘 ${sessionClose || '—'}% · 门槛 ${threshold || '—'}%`
    : ''
  const next = context.nextTradeDayForecast
  const nextTradeDayText = next && typeof next === 'object'
    ? [
        `次日 ${clean(next.targetDate, 20).slice(5) || '—'}`,
        clean(next.direction, 20) || '方向待定',
        `上涨${displayNumber(next.upProb) || '—'}%`,
        `预期${Number(next.expRet) >= 0 ? '+' : ''}${displayNumber(next.expRet) || '—'}%`,
        `${displayNumber(next.targetLow) || '—'}~${displayNumber(next.targetHigh) || '—'}`,
      ].join(' · ')
    : ''
  return {
    label: clean(context.modelLabel, 120),
    horizon: clean(context.horizon, 120),
    asOf: clean(context.inputAsOf || context.asOf, 40),
    ...(context.inputAsOf ? { asOfLabel: '输入截至' } : {}),
    experimental: context.experimental === true,
    fallback: context.fallback || null,
    reliabilityText,
    ...(nextTradeDayText ? { nextTradeDayText } : {}),
  }
}

function decisionPlanSummary(plan) {
  if (plan?.schemaVersion !== 'decision-plan.v2') return null
  const actionability = clean(plan.actionability, 30)
  const evidenceBasis = plan.evidenceBasis
    ? {
        state: clean(plan.evidenceBasis.state, 30),
        label: clean(plan.evidenceBasis.label, 80),
        dataAsOf: clean(plan.evidenceBasis.dataAsOf, 60),
        phase: clean(plan.evidenceBasis.phase, 60),
        isLive: plan.evidenceBasis.isLive === true,
      }
    : null
  const evidenceIssues = Array.isArray(plan.evidenceIssues)
    ? plan.evidenceIssues.map((issue) => ({
        source: clean(issue?.source, 40),
        label: clean(issue?.label, 60),
        status: clean(issue?.status, 30),
        reason: clean(issue?.reason, 160),
        impact: clean(issue?.impact, 200),
        recovery: clean(issue?.recovery, 200),
      })).filter((issue) => issue.source && issue.label)
    : []
  const statusText = actionability === 'READY'
    ? '策略条件与账户风险检查均已通过'
    : actionability === 'RESEARCH_ONLY'
      ? (plan.blockedReasons || []).join('；') || '仅供观察，暂不可直接执行'
      : actionability === 'BLOCKED'
        ? (plan.blockedReasons || []).join('；') || '执行条件未满足'
        : '等待触发条件'
  const outOfSample = plan.strategy?.outOfSample
  const compoundedReturn = Number(outOfSample?.compoundedReturn)
  return {
    decisionId: clean(plan.decisionId, 100),
    action: clean(plan.action, 30),
    actionLabel: clean(plan.actionLabel, 40),
    actionability,
    triggerDirection: clean(plan.triggerDirection, 20),
    statusText: clean(statusText, 320),
    strategyId: clean(plan.strategy?.strategyId, 80),
    specVersion: clean(plan.strategy?.specVersion, 80),
    strategyName: clean(plan.strategy?.name, 80),
    strategyFamily: clean(plan.strategy?.family, 80),
    governanceState: clean(plan.strategy?.governanceState, 40),
    governanceLabel: plan.strategy?.governanceState
      ? strategyStateLabel(plan.strategy.governanceState)
      : '',
    routeMode: clean(plan.strategy?.routeMode, 40),
    eligibleRegimes: Array.isArray(plan.strategy?.eligibleRegimes)
      ? plan.strategy.eligibleRegimes.map(
          (item) => marketRegimeLabel(item),
        ).filter(Boolean)
      : [],
    outOfSample: outOfSample
      ? {
          folds: Number(outOfSample.folds) || 0,
          positiveFolds: Number(outOfSample.positiveFolds) || 0,
          returnPct: Number.isFinite(compoundedReturn)
            ? +(compoundedReturn * 100).toFixed(2)
            : null,
        }
      : null,
    strategySignalPassed: plan.strategy?.signalPassed,
    productionEligible: plan.strategy?.productionEligible === true,
    marketRegime: clean(
      plan.marketRegime?.label
      || marketRegimeLabel(plan.marketRegime?.regime),
      40,
    ),
    actionabilityLabel: actionabilityLabel(actionability),
    marketScore: displayNumber(plan.marketRegime?.score),
    asOf: clean(plan.asOf, 40),
    validUntil: clean(plan.validUntil, 40),
    maxLossAmount: displayNumber(plan.risk?.maxLossAmount),
    budgetPct: displayNumber(plan.risk?.budgetPct),
    estimatedFees: displayNumber(plan.costs?.estimatedFees),
    evidenceBasis,
    evidenceIssues,
  }
}

function decisionInstruction(plan, fallback = '') {
  if (!plan) return fallback
  const reasons = (Array.isArray(plan.blockedReasons)
    ? plan.blockedReasons
    : []).map((item) => clean(item, 160)).filter(Boolean)
  if (plan.actionability === 'BLOCKED') {
    return `暂不执行：${reasons.join('；') || '执行条件未满足'}`
  }
  if (plan.actionability === 'WATCH') {
    return clean(plan.trigger, 500) || fallback || '等待触发条件后重新评估'
  }
  const lots = Number(plan.quantity?.lots) || 0
  const price = displayNumber(plan.prices?.reference)
  const core = `${plan.actionLabel || '操作'}${lots > 0 ? `${lots}手` : ''}${price ? `，参考${price}元` : ''}`
  if (plan.actionability === 'RESEARCH_ONLY') {
    return `仅供观察：${core}；策略通过实盘启用审核前，不能直接执行`
  }
  return core || fallback
}

function reviewSummary(advice = {}) {
  return advice.reviewCycle && typeof advice.reviewCycle === 'object'
    ? {
        status: advice.reviewCycle.status || '',
        sequence: Number(advice.reviewCycle.sequence) || 0,
        reviewedAt: Number(advice.reviewCycle.reviewedAt) || 0,
        nextReviewAt: Number(advice.reviewCycle.nextReviewAt) || 0,
        previousAction: clean(advice.reviewCycle.previousAction, 80),
        changeType: clean(advice.reviewCycle.changeType, 40),
        reason: clean(advice.reviewCycle.reason, 160),
      }
    : null
}

export function trustCalibrationText(trust = {}) {
  if (trust?.calibrated !== true) return ''
  const samples = Number(trust.calibrationSamples)
  const winRate = Number(trust.historicalWinRate)
  if (!Number.isFinite(samples) || !Number.isFinite(winRate)) return ''
  return `已按同信心档${samples}次结果校准 · 历史命中率${winRate}%`
}

function buildLegacyAdvicePresentation(advice = {}) {
  const plan = advice.decisionPlan?.schemaVersion === 'decision-plan.v2'
    ? advice.decisionPlan
    : null
  const planAdvice = plan ? {
    ...advice,
    action: plan.actionability === 'RESEARCH_ONLY'
      ? `观察·${plan.actionLabel || '建议'}`
      : plan.actionability === 'BLOCKED'
        ? '观望'
        : plan.actionLabel || advice.action,
    title: plan.actionability === 'BLOCKED'
      ? '执行条件未满足，暂不操作'
      : plan.actionability === 'RESEARCH_ONLY'
        ? `仅供观察：${advice.title || advice.headline || plan.actionLabel || '等待确认'}`
        : advice.title,
    actionPlan: decisionInstruction(plan, advice.actionPlan),
    planQty: plan.quantity?.lots,
    opQty: plan.action === 'BUY'
      ? null
      : plan.quantity?.lots > 0
        ? `${plan.actionLabel || '操作'}${plan.quantity.lots}手`
        : '无需操作',
    planAmount: plan.costs?.estimatedNetAmount,
    opAmount: plan.costs?.estimatedNetAmount,
    planWeight: (
      plan.currentWeightPct != null
      && plan.targetWeightPct != null
    )
      ? `${plan.currentWeightPct}% → ${plan.targetWeightPct}%`
      : advice.planWeight,
    buyZone: null,
    buyPrice: plan.action === 'BUY'
      ? plan.prices?.reference
      : null,
    watchPrice: plan.prices?.watch,
    addPrice: plan.action === 'ADD'
      ? plan.prices?.reference
      : advice.addPrice,
    reducePrice: ['REDUCE', 'EXIT'].includes(plan.action)
      ? plan.prices?.reference
      : advice.reducePrice,
    stopPrice: plan.prices?.stop,
    targetPrice: plan.prices?.target,
  } : advice
  const contract = advice.knowledgeActionPlan || {}
  const review = reviewSummary(advice)
  return {
    verdict: {
      action: first(planAdvice.action, planAdvice.stance),
      title: first(
        planAdvice.title,
        planAdvice.headline,
        planAdvice.action,
        planAdvice.stance,
      ),
      tone: first(planAdvice.tone, 'muted'),
      confidence: first(planAdvice.confidence),
    },
    execution: {
      instruction: first(
        planAdvice.actionPlan,
        planAdvice.nextAction,
        planAdvice.timing,
        contract.executionPlan,
      ),
      quantity: quantity(planAdvice),
      amount: first(planAdvice.opAmount, planAdvice.planAmount),
      position: first(
        planAdvice.posAfter,
        planAdvice.planWeight,
        planAdvice.positionNote,
        contract.positionRule,
      ),
    },
    planSteps: [
      advice.nextOpenPlan && {
        key: 'nextOpen',
        label: '下个开盘',
        text: clean(advice.nextOpenPlan),
      },
      advice.futurePlan && {
        key: 'future',
        label: '后续路径',
        text: clean(advice.futurePlan),
      },
    ].filter(Boolean),
    levels: priceLevels(planAdvice),
    trigger: {
      condition: first(
        contract.triggerConditions,
        advice.timing,
        advice.nextOpenPlan,
      ),
      confirmation: first(
        advice.exitTiming,
        contract.exitConditions,
      ),
      invalidation: first(
        contract.invalidation,
        advice.invalidation,
      ),
      validationWindow: first(contract.validationWindow),
    },
    evidence: coreEvidence(advice),
    model: modelSummary(advice),
    decisionPlan: decisionPlanSummary(plan),
    review,
  }
}

function executionPlanSummary(plan) {
  if (plan?.schemaVersion !== 'execution-plan.v1') return null
  return {
    schemaVersion: plan.schemaVersion,
    planId: clean(plan.planId, 100),
    decisionId: clean(plan.decisionId, 100),
    status: clean(plan.status, 30),
    canArm: plan.canArm === true,
    side: clean(plan.side, 10),
    targetLots: Number(plan.targetLots) || 0,
    filledLots: Number(plan.filledLots) || 0,
    remainingLots: Number(plan.remainingLots) || 0,
    referencePrice: displayNumber(plan.referencePrice),
    triggerDirection: clean(plan.triggerDirection, 20),
    validUntil: clean(plan.validUntil, 40),
    methodType: clean(plan.executionMethod?.type, 40),
    methodLabel: clean(plan.executionMethod?.label, 40),
    sliceCount: Array.isArray(plan.slices) ? plan.slices.length : 0,
  }
}

export function compileAdvicePresentationV3(advice = {}) {
  const displayAdvice = humanizeAdviceTextFields(advice)
  const view = buildLegacyAdvicePresentation(displayAdvice)
  return {
    schemaVersion: 'advice-presentation.v3',
    ...view,
    executionPlan: executionPlanSummary(displayAdvice.executionPlan),
  }
}

export function buildAdvicePresentation(advice = {}) {
  const displayAdvice = humanizeAdviceTextFields(advice)
  if (displayAdvice.presentation?.schemaVersion === 'advice-presentation.v3') {
    return {
      ...displayAdvice.presentation,
      review: reviewSummary(displayAdvice),
      executionPlan: executionPlanSummary(displayAdvice.executionPlan),
    }
  }
  return compileAdvicePresentationV3(displayAdvice)
}
