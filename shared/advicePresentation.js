import {
  actionabilityLabel,
  humanizeAdviceTextFields,
  marketRegimeLabel,
} from './userFacingLanguage.js'
import { adviceObservationLevels } from './advicePriceContract.js'

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

const withYuan = (value) =>
  /元$/.test(String(value)) ? String(value) : `${value}元`

function observationTriggerText(levels = []) {
  const conditions = levels
    .filter((level) =>
      ['watch_pullback', 'watch_breakout', 'watch'].includes(level.key)
      && level.value
      && level.value !== '等待重新定价'
    )
    .map((level) => {
      const symbol = level.direction === 'LTE'
        ? '≤'
        : level.direction === 'GTE' ? '≥' : '到达'
      return `${level.label}${symbol}${withYuan(level.value)}`
    })
  return conditions.length
    ? `${conditions.join('；')}。任一到价后自动启动复核并记录提醒。`
    : ''
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

function priceLevels(advice, { observationOnly = false } = {}) {
  if (observationOnly) {
    const contracted = adviceObservationLevels(advice)
      .map((level) => ({
        key: level.key,
        label: level.label,
        value: displayNumber(level.price),
        tone: level.direction === 'GTE' ? 'red' : 'muted',
        direction: level.direction,
        distanceText: Number.isFinite(
          Number(level.currentDistancePct),
        )
          ? `距现价${level.direction === 'GTE' ? '+' : '-'}${Number(level.currentDistancePct).toFixed(1)}%`
          : '',
      }))
    if (contracted.length) return contracted
    return uniqueItems([
      advice.pullbackWatchPrice != null && {
        key: 'watch_pullback',
        label: '回踩观察',
        value: displayNumber(advice.pullbackWatchPrice),
        tone: 'muted',
        direction: 'LTE',
      },
      advice.breakoutWatchPrice != null && {
        key: 'watch_breakout',
        label: '突破观察',
        value: displayNumber(advice.breakoutWatchPrice),
        tone: 'red',
        direction: 'GTE',
      },
      advice.watchPrice != null
        && clean(advice.watchPrice, 200).length <= 24
        && {
          key: 'watch',
          label: '观察价',
          value: displayNumber(advice.watchPrice),
          tone: 'muted',
        },
    ].filter(Boolean), 2)
  }
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
      label: '观察价',
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

function deferredPlanPresentation(plan) {
  const policy = plan?.actionPolicy || {}
  const nextSession = policy.nextSessionPlan
  const entryIntent = policy.entryIntent
  const next = nextSession || (
    entryIntent?.reviewMode === 'ENTRY_CONFIRMATION'
    && entryIntent?.directionApproved === true
      ? entryIntent
      : null
  )
  if (
    !next
    || !['PROBE', 'BUY', 'PROBE_ADD', 'ADD'].includes(
      next.action,
    )
  ) return null
  const sessionLabel = {
    AFTERNOON: '下午盘中',
    OPENING: '开盘后',
    NEXT_TRADING_DAY: '下一交易日盘中',
  }[nextSession?.session] || '当前盘中'
  const actionLabel = ['PROBE_ADD', 'ADD'].includes(next.action)
    ? '条件加仓'
    : next.action === 'PROBE'
      ? '条件试仓'
      : '条件买入'
  const maxPositionPct = Number(next.maxPositionPct)
  const positionLimit = (
    ['PROBE', 'PROBE_ADD'].includes(next.action)
    && Number.isFinite(maxPositionPct)
    && maxPositionPct > 0
  ) ? `，仓位不超过${maxPositionPct}%` : ''
  const sessionPrefix = nextSession
    ? nextSession.session === 'NEXT_TRADING_DAY'
      ? '次日'
      : nextSession.session === 'AFTERNOON'
        ? '下午'
        : '开盘后'
    : '盘中'
  const addSide = ['PROBE_ADD', 'ADD'].includes(next.action)
  return {
    actionLabel: `${sessionPrefix}${actionLabel}`,
    instruction: `${
      addSide ? '加仓方向' : '买入方向'
    }已通过；${clean(
      next.trigger || `${sessionLabel}确认入场时机`,
      240,
    )}${positionLimit}；触发后只确认入场时机，确认通过后给出具体${
      addSide ? '加仓' : '买入'
    }价和手数，再由你人工确认。`,
  }
}

function decisionPlanSummary(plan) {
  if (plan?.schemaVersion !== 'decision-plan.v2') return null
  const actionability = clean(plan.actionability, 30)
  const deferredPlan = deferredPlanPresentation(plan)
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
  const statusText = deferredPlan
    ? `${deferredPlan.actionLabel}方向已通过，当前只等待入场时机确认`
    : plan.manualConfirmationOnly === true
    ? '短线核心信号已共振，仅限人工确认小仓试错'
    : actionability === 'READY'
    ? '证据、价格与账户风险检查均已通过'
    : actionability === 'MANUAL_PROBE'
      ? '板块与个股短线条件已通过，仅限人工确认小仓试错'
    : actionability === 'BLOCKED'
        ? (plan.blockedReasons || []).join('；') || '执行条件未满足'
        : '等待触发条件'
  return {
    decisionId: clean(plan.decisionId, 100),
    action: clean(plan.action, 30),
    actionLabel: clean(plan.actionLabel, 40),
    actionability,
    triggerDirection: clean(plan.triggerDirection, 20),
    statusText: clean(statusText, 320),
    marketRegime: clean(
      plan.marketRegime?.label
      || marketRegimeLabel(plan.marketRegime?.regime),
      40,
    ),
    actionabilityLabel: actionabilityLabel(actionability),
    manualConfirmationOnly: plan.manualConfirmationOnly === true,
    deferredPlan,
    opportunity: plan.opportunity
      ? {
          sectorName: clean(plan.opportunity.sectorName, 60),
          stockRole: clean(plan.opportunity.stockRole, 30),
        }
      : null,
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
  const deferredPlan = deferredPlanPresentation(plan)
  const reasons = (Array.isArray(plan.blockedReasons)
    ? plan.blockedReasons
    : []).map((item) => clean(item, 160)).filter(Boolean)
  if (plan.actionability === 'BLOCKED') {
    return `暂不执行：${reasons.join('；') || '执行条件未满足'}`
  }
  if (plan.actionability === 'WATCH') {
    if (deferredPlan) {
      return `该预案生成于休市阶段；盘中复核前不下单。${deferredPlan.instruction}`
    }
    return clean(plan.trigger, 500) || fallback || '等待触发条件后重新评估'
  }
  const lots = Number(plan.quantity?.lots) || 0
  const price = displayNumber(plan.prices?.reference)
  const core = `${plan.actionLabel || '操作'}${lots > 0 ? `${lots}手` : ''}${price ? `，参考${price}元` : ''}`
  if (
    plan.actionability === 'MANUAL_PROBE'
    || plan.manualConfirmationOnly === true
  ) {
    return `人工确认：${plan.action === 'ADD' ? '小仓加仓' : '小仓试错'}${lots > 0 ? `${lots}手` : ''}${price ? `，参考${price}元` : ''}；不进入自动执行`
  }
  return core || fallback
}

function operationGuide(advice, plan, levels, observationOnly) {
  const reviewText = clean(advice.reviewTrigger, 180)
  const policyReasons = (
    (
      plan?.actionPolicy?.overridden
      || plan?.manualConfirmationOnly === true
    )
    && Array.isArray(plan?.actionPolicy?.reasons)
  )
    ? plan.actionPolicy.reasons
        .map((item) => clean(item, 120))
        .filter(Boolean)
        .slice(0, 4)
    : []
  const policyStep = policyReasons.length
    ? {
        key: 'policy',
        label: plan?.manualConfirmationOnly === true
          ? '为何仅试仓'
          : '为何不操作',
        text: policyReasons.join('；'),
        tone: plan?.manualConfirmationOnly === true
          ? 'watch'
          : 'risk',
      }
    : null
  const invalidation = first(
    plan?.invalidation,
    advice.knowledgeActionPlan?.invalidation,
    advice.invalidation,
  )
  if (!plan) return null

  if (observationOnly) {
    const deferredPlan = deferredPlanPresentation(plan)
    const paths = levels
      .filter((level) =>
        ['watch_pullback', 'watch_breakout', 'watch'].includes(
          level.key,
        )
        && level.value !== '等待重新定价'
      )
      .map((level) => {
        if (level.key === 'watch_pullback') {
          return {
            key: level.key,
            label: '回踩路径',
            text: deferredPlan
              ? `价格回落至${withYuan(level.value)}附近后只确认承接与入场时机；通过即给具体买入价和手数。`
              : `价格回落至${withYuan(level.value)}附近，重新评估方向；军师确认前不买入。`,
          }
        }
        if (level.key === 'watch_breakout') {
          return {
            key: level.key,
            label: '突破路径',
            text: deferredPlan
              ? `价格上行至${withYuan(level.value)}附近且放量站稳后只确认入场时机；通过即给具体买入价和手数。`
              : `价格上行至${withYuan(level.value)}附近且放量站稳，重新评估方向；确认前不追涨。`,
          }
        }
        return {
          key: level.key,
          label: '到价后',
          text: `价格到达${withYuan(level.value)}附近后重新生成建议；确认前不下单。`,
        }
      })
    if (!paths.length) {
      paths.push({
        key: 'reprice',
        label: '等待条件',
        text: first(
          plan.trigger,
          advice.actionPlan,
          advice.timing,
          '等待取得有效观察价后重新生成建议。',
        ),
      })
    }
    return {
      now: deferredPlan
        ? `${deferredPlan.actionLabel}方向已通过；当前只等待入场时机确认，确认后给出具体价格和手数。`
        : '暂不买入，不挂单、不追涨。',
      steps: [
        deferredPlan && {
          key: 'next-session',
          label: deferredPlan.actionLabel,
          text: deferredPlan.instruction,
          tone: 'watch',
        },
        policyStep,
        ...paths,
        invalidation && {
          key: 'cancel',
          label: '取消关注',
          text: invalidation,
          tone: 'risk',
        },
        reviewText && {
          key: 'review',
          label: '下次复核',
          text: reviewText,
        },
      ].filter(Boolean),
    }
  }

  const lots = Number(plan.quantity?.lots) || 0
  const price = displayNumber(plan.prices?.reference)
  const actionText = `${plan.actionLabel || '操作'}${lots > 0 ? `${lots}手` : ''}${price ? `，参考${price}元` : ''}`
  const stop = displayNumber(plan.prices?.stop)
  const target = displayNumber(plan.prices?.target)
  const exitParts = [
    stop && `止损${stop}元`,
    target && `目标${target}元`,
  ].filter(Boolean)
  return {
    now: plan.actionPolicy?.overridden && plan.action === 'HOLD'
      ? '继续持有，当前不加仓；等待短线条件重新确认。'
      : plan.actionability === 'BLOCKED'
      ? '暂不操作，不挂单；条件恢复后重新生成建议。'
      : (
        plan.actionability === 'MANUAL_PROBE'
        || plan.manualConfirmationOnly === true
      )
        ? `仅限人工确认小仓试错：${actionText}。`
        : `${actionText}；仅在核对价格和账户后人工执行。`,
    steps: [
      policyStep,
      plan.trigger && {
        key: 'trigger',
        label: '执行条件',
        text: clean(plan.trigger, 240),
      },
      exitParts.length && {
        key: 'exit',
        label: '退出纪律',
        text: [
          exitParts.join('，'),
          clean(advice.exitTiming, 180),
        ].filter(Boolean).join('；'),
        tone: 'risk',
      },
      invalidation && {
        key: 'invalid',
        label: '计划失效',
        text: invalidation,
        tone: 'risk',
      },
      reviewText && {
        key: 'review',
        label: '下次复核',
        text: reviewText,
      },
    ].filter(Boolean),
  }
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
        receipt: advice.reviewCycle.receipt
          ? {
              checked: Array.isArray(advice.reviewCycle.receipt.checked)
                ? advice.reviewCycle.receipt.checked
                  .map((item) => clean(item, 40))
                  .filter(Boolean)
                  .slice(0, 8)
                : [],
              changes: Array.isArray(advice.reviewCycle.receipt.changes)
                ? advice.reviewCycle.receipt.changes
                  .map((item) => clean(item, 60))
                  .filter(Boolean)
                  .slice(0, 4)
                : [],
              summary: clean(
                advice.reviewCycle.receipt.summary,
                160,
              ),
            }
          : null,
      }
    : null
}

function shortHorizonSummary(advice = {}) {
  const stage = clean(
    advice.decisionPlan?.opportunityLifecycle?.stageLabel,
    40,
  )
  const horizon = clean(advice.shortHorizon, 40)
  const edge = clean(advice.edge, 120)
  const risk = clean(advice.crowdingRisk, 120)
  const catalyst = clean(advice.catalystWindow, 80)
  const reviewTrigger = clean(advice.reviewTrigger, 120)
  if (!stage && !horizon && !edge && !risk && !catalyst && !reviewTrigger) {
    return null
  }
  return {
    stage,
    horizon: horizon || '1-5个交易日',
    edge,
    risk,
    catalyst,
    reviewTrigger,
  }
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
  const observationOnly = plan?.action === 'WATCH'
    && (
      plan.mode === 'buy_advice'
      || /观望|等待|回避|不建议|暂不/.test(
        String(advice.action || advice.stance || ''),
      )
    )
  const deferredPlan = deferredPlanPresentation(plan)
  const planAdvice = plan ? {
    ...advice,
    action: deferredPlan?.actionLabel || (
      (
        plan.actionability === 'MANUAL_PROBE'
        || plan.manualConfirmationOnly === true
      )
        ? plan.action === 'ADD'
          ? '小仓加仓'
          : '小仓试错'
        : plan.actionability === 'RESEARCH_ONLY'
          ? `观察·${plan.actionLabel || '建议'}`
          : plan.actionability === 'BLOCKED'
            ? '观望'
            : plan.action === 'BUY'
              ? '现在买入'
              : plan.actionLabel || advice.action
    ),
    title: deferredPlan
      ? `${deferredPlan.actionLabel}：方向已通过，待时机确认`
      : plan.actionPolicy?.overridden
      ? plan.action === 'HOLD'
        ? '短线条件未确认，继续持有'
        : '短线条件未确认，暂不操作'
      : plan.actionability === 'BLOCKED'
      ? '执行条件未满足，暂不操作'
      : (
        plan.actionability === 'MANUAL_PROBE'
        || plan.manualConfirmationOnly === true
      )
        ? `短线试仓：${advice.title || advice.headline || '板块与个股条件共振'}`
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
    addPrice: observationOnly
      ? null
      : plan.action === 'ADD'
      ? plan.prices?.reference
      : advice.addPrice,
    reducePrice: observationOnly
      ? null
      : ['REDUCE', 'EXIT'].includes(plan.action)
      ? plan.prices?.reference
      : advice.reducePrice,
    stopPrice: observationOnly ? null : plan.prices?.stop,
    targetPrice: observationOnly ? null : plan.prices?.target,
  } : advice
  const contract = advice.knowledgeActionPlan || {}
  const review = reviewSummary(advice)
  const levels = priceLevels(planAdvice, { observationOnly })
  if (observationOnly && levels.length === 0) {
    levels.push({
      key: 'watch',
      label: '观察价',
      value: '等待重新定价',
      tone: 'muted',
    })
  }
  const guide = operationGuide(
    advice,
    plan,
    levels,
    observationOnly,
  )
  return {
    observationOnly,
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
    operationGuide: guide,
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
    levels,
    trigger: {
      title: observationOnly
        ? '到价后的动作'
        : '触发与失效',
      conditionLabel: observationOnly ? '触发规则' : '触发',
      confirmationLabel: observationOnly ? '自动复核' : '确认',
      invalidationLabel: observationOnly ? '取消关注' : '失效',
      validationLabel: observationOnly ? '有效期' : '验证',
      condition: observationOnly
        ? first(
            observationTriggerText(levels),
            advice.actionPlan,
            advice.timing,
            contract.triggerConditions,
          )
        : first(
            contract.triggerConditions,
            advice.timing,
            advice.nextOpenPlan,
          ),
      confirmation: observationOnly
        ? '自动重新采集分时、VWAP、量能、主力与散户资金并生成新结论；确认后再提示人工操作，未确认不买。'
        : first(
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
    tactical: shortHorizonSummary(advice),
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
