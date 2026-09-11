import { applyT1ToAlert } from './t1AdvicePolicy.js'
import {
  DECISION_ENGINE_ID,
  isDecisionEngineAdvice,
} from './decisionEngineSource.js'
import { adviceSupportsIntent, buildJudgeAdviceContext } from './judgeAdviceContext.js'
import {
  adviceObservationLevels,
  advicePriceLevel,
  sanitizedAdvicePriceContract,
} from './advicePriceContract.js'
import { isAdviceReviewEnabled } from './adviceReviewPolicy.js'
import { executionTriggerDirection } from './executionTrigger.js'
import { holdingAddReviewPlan } from './holdingFollowUp.js'
import { monitoringAlerts, monitoringPlanOf } from './monitoringPlan.js'
import {
  sanitizeStrategyPatternConfirmation,
} from './strategyPatternConfirmation.js'

function roundPrice(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 10 ? +n.toFixed(3) : +n.toFixed(2)
}

function defaultId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function isCurrentDecisionAlert(alert, entry, now = Date.now()) {
  if (!alert?.candCode && !alert?.actCode) return true
  const advice = entry?.advice || entry
  if (
    !isDecisionEngineAdvice(advice)
    || alert.decisionEngine !== DECISION_ENGINE_ID
  ) return false
  return alert.decisionId === advice.decisionPlan?.decisionId
    && Date.parse(alert.validUntil) > now
}

export function decisionActionAlertMessage(alert, quote) {
  const price = Number(quote?.price)
  const reference = Number(alert.value)
  if (!(price > 0 && reference > 0)) return null
  if (alert.actionSide === 'BUY'
    && Math.abs(price / reference - 1) > 0.015) return null
  return alert.timing || alert.judgeContext?.actionPlan || null
}

function decisionAlert(alert, advice) {
  if (!isDecisionEngineAdvice(advice)) return alert
  return {
    ...alert, decisionEngine: DECISION_ENGINE_ID,
    decisionId: advice.decisionPlan.decisionId,
    validUntil: advice.decisionPlan.validUntil,
    actionSide: ['BUY', 'ADD'].includes(advice.decisionPlan.action) ? 'BUY' : 'SELL',
    timing: advice.actionPlan,
    // An approved decision action is a notification, not a second LLM decision.
    phase: alert.reviewOnly ? alert.phase : null,
  }
}

function baseAlert({ idFactory, now, code, name, op, value, note }) {
  return {
    id: idFactory(),
    enabled: true,
    createdAt: now,
    triggeredAt: null,
    triggeredMsg: '',
    code,
    name,
    type: 'price',
    op,
    value,
    note,
  }
}

function strategyPatternConfirmationFor(advice = {}, route = '') {
  const normalizedRoute = String(route || '').toUpperCase()
  const plans = [
    ...(Array.isArray(advice.decisionPaths) ? advice.decisionPaths : []),
    advice.selectedDecisionPlan,
  ].filter(Boolean)
  const selected = plans.find((plan) =>
    !normalizedRoute
    || String(plan?.route || plan?.entryPlan?.type || '').toUpperCase()
      === normalizedRoute
  )
  return sanitizeStrategyPatternConfirmation(
    selected?.entryPlan?.strategyPatternConfirmation,
  )
}

function reviewIntentOf(advice = {}) {
  const policy = advice.decisionPlan?.actionPolicy || {}
  const inheritedMaxPositionPct = Number(
    advice.reviewMemory?.conclusion?.maxPositionPct,
  )
  const source = (
    policy.entryIntent?.reviewMode === 'ENTRY_CONFIRMATION'
      ? policy.entryIntent
      : policy.nextSessionPlan?.reviewMode === 'ENTRY_CONFIRMATION'
        ? policy.nextSessionPlan
        : null
  )
  const plannedAction = String(source?.action || '')
  if (
    source?.directionApproved === true
    && ['PROBE', 'BUY', 'PROBE_ADD', 'ADD'].includes(plannedAction)
  ) {
    const maxPositionPct = Number(source.maxPositionPct)
    return {
      mode: 'ENTRY_CONFIRMATION',
      plannedAction,
      actionLabel: String(
        source.actionLabel
        || (
          ['PROBE', 'PROBE_ADD'].includes(plannedAction)
            ? '条件试仓'
            : '条件买入'
        ),
      ),
      directionApproved: true,
      maxPositionPct: Number.isFinite(maxPositionPct)
        && maxPositionPct > 0
        ? Math.min(5, maxPositionPct)
        : null,
      manualConfirmationOnly:
        source.manualConfirmationOnly === true,
    }
  }
  return {
    mode: 'REASSESSMENT',
    plannedAction: 'WATCH',
    actionLabel: '观望',
    directionApproved: false,
    maxPositionPct:
      Number.isFinite(inheritedMaxPositionPct)
      && inheritedMaxPositionPct > 0
        ? Math.min(100, inheritedMaxPositionPct)
        : null,
    manualConfirmationOnly: false,
  }
}

export function decisionExitReviewOf(advice = {}) {
  const action = String(advice.decisionPlan?.action || '').toUpperCase()
  if (
    !isDecisionEngineAdvice(advice)
    || advice.decisionSource?.hardProtection === true
    || advice.decisionSource?.exitReviewRequired === false
    || advice.reviewDecision?.terminal === true
    || !['EXIT', 'REDUCE'].includes(action)
  ) return null
  return {
    mode: 'EXIT_REASSESSMENT',
    plannedAction: action,
    actionLabel: action === 'EXIT' ? '清仓复核' : '减仓复核',
    directionApproved: false,
    manualConfirmationOnly: false,
  }
}

function refreshReviewAlert(previous, next, adviceAt) {
  const triggeredAt = Number(previous?.triggeredAt) || 0
  const superseded = (
    previous?.enabled === false
    && ['superseded', 'invalid', 'stopped'].includes(
      String(previous?.phase || ''),
    )
  )
  const resolvedByNewAdvice = (
    triggeredAt > 0
    && Number(adviceAt) > triggeredAt
  )
  if (
    previous?.reviewOnly !== true
    || (!superseded && !resolvedByNewAdvice)
  ) return next
  return {
    ...next,
    enabled: true,
    phase: 'armed',
    triggeredAt: null,
    triggeredMsg: '',
    decisionPrice: null,
  }
}

function holdingAddReviewAlerts({
  advice,
  adviceAt,
  alerts,
  code,
  idFactory,
  judgeContext,
  name,
  now,
}) {
  const followUp = holdingAddReviewPlan(advice)
  if (!followUp?.paths?.length) return []
  return followUp.paths.flatMap((path) => {
    const op = path.direction === 'LTE' ? 'lte' : 'gte'
    const reviewPrice = roundPrice(path.price)
    if (reviewPrice == null) return []
    const previous = alerts.find((alert) =>
      alert?.actCode === code
      && alert.reviewOnly === true
      && alert.reviewKey === path.key
    )
    const samePlan = !!(
      previous?.judgeContext?.planId
      && judgeContext.planId
      && previous.judgeContext.planId === judgeContext.planId
    )
    if (
      previous
      && samePlan
      && Number(previous.value) === reviewPrice
      && previous.op === op
    ) {
      return [refreshReviewAlert(previous, {
        ...previous,
        note: path.label,
        judgeContext,
        reviewIntent: followUp.reviewIntent,
        ...(path.strategyPatternConfirmation ? {
          strategyPatternConfirmation:
            sanitizeStrategyPatternConfirmation(
              path.strategyPatternConfirmation,
            ),
        } : {}),
      }, adviceAt)]
    }
    return [{
      ...baseAlert({
        idFactory,
        now,
        code,
        name,
        op,
        value: reviewPrice,
        note: path.label,
      }),
      actCode: code,
      reviewOnly: true,
      reviewKey: path.key,
      reviewCategory: 'holding-add',
      judgeContext,
      reviewIntent: followUp.reviewIntent,
      ...(path.strategyPatternConfirmation ? {
        strategyPatternConfirmation:
          sanitizeStrategyPatternConfirmation(
            path.strategyPatternConfirmation,
          ),
      } : {}),
      phase: 'armed',
    }]
  })
}

export function projectAdviceAlerts(data, code, advice, options = {}) {
  if (!data || !code || !advice) return false
  const now = options.now ?? Date.now()
  const adviceAt = Number(options.adviceAt) || 0
  const idFactory = options.idFactory || defaultId
  const alerts = Array.isArray(data.alerts) ? data.alerts : []
  const holding = Array.isArray(data.holding) ? data.holding : []
  const plan = Array.isArray(data.plan) ? data.plan : []
  let changed = !Array.isArray(data.alerts)

  const isOwnedAutoAlert = (a) => a && a.code === code && (a.candCode === code || a.actCode === code)
  if (
    data.settings?.aiAutoAlert === false
    || !isAdviceReviewEnabled(data.settings, code)
  ) {
    const next = alerts.filter((a) => !isOwnedAutoAlert(a))
    if (next.length !== alerts.length) changed = true
    data.alerts = next
    return changed
  }

  const holder = holding.find((x) => x && x.code === code)
  const candidate = plan.find((x) => x && x.code === code)
  const liveHolder = holder && (
    options.t1Status == null
    || Number(options.t1Status.liveQty) > 0
  ) ? holder : null
  const rest = alerts.filter((a) => !isOwnedAutoAlert(a))
  if (!liveHolder && !candidate) {
    if (rest.length !== alerts.length) changed = true
    data.alerts = rest
    return changed
  }
  const owner = liveHolder || candidate || {}
  const name = advice.name || owner.name || code
  const judgeContext = buildJudgeAdviceContext(advice)
  const holdingAddReviews = liveHolder
    ? holdingAddReviewAlerts({
        advice,
        adviceAt,
        alerts,
        code,
        idFactory,
        judgeContext,
        name,
        now,
      })
    : []
  if (liveHolder && monitoringPlanOf(advice)) {
    const retained = rest.filter((alert) => !(
      alert.code === code && alert.planId === liveHolder.id
      && !(alert.op === 'lte' ? liveHolder.slManual : liveHolder.tpManual)
    ))
    const next = [
      ...retained,
      ...monitoringAlerts(data, code, advice, now)
        .map((alert) => decisionAlert(alert, advice)),
      ...holdingAddReviews.map((alert) => decisionAlert(alert, advice)),
    ]
    const changed = JSON.stringify(alerts) !== JSON.stringify(next)
    data.alerts = next
    return changed
  }
  const projected = []
  if (advice.reviewDecision?.terminal === true) {
    if (candidate) {
      if (
        candidate.alertSyncedPrice != null
        || candidate.reviewSyncedPrice != null
        || candidate.reviewSyncedPrices != null
      ) changed = true
      candidate.alertSyncedPrice = null
      candidate.reviewSyncedPrice = null
      candidate.reviewSyncedPrices = null
    }
    data.alerts = rest
    return changed || rest.length !== alerts.length
  }
  const reviewIntent = reviewIntentOf(advice)
  const priceContract = sanitizedAdvicePriceContract(advice)
  const oldProjected = alerts.filter(isOwnedAutoAlert)
  if (options.requirePriceContract === true && !priceContract) {
    data.alerts = rest
    return oldProjected.length > 0
  }
  const waitAdvice = (
    advice.decisionPlan?.action === 'WATCH'
    || /观望|等待|回避|不建议|暂不/.test(
      String(advice.action || advice.stance || ''),
    )
  )
  const contractEntry = priceContract?.levels?.find((level) =>
    level?.key === 'entry'
    && roundPrice(level.price) != null
  )
  const contractCurrentPrice = roundPrice(priceContract?.currentPrice)
  const entryPrice = roundPrice(contractEntry?.price)
  const entryAboveCurrent = (
    entryPrice != null
    && contractCurrentPrice != null
    && entryPrice > contractCurrentPrice
  )
  const executionOpen =
    advice.decisionPlan?.actionPolicy?.executionOpen
  const deferredBySession = executionOpen === false
    || (
      executionOpen == null
      && advice.decisionPlan?.evidenceBasis?.isLive === false
    )
  const deferredEntry = (
    candidate
    && !liveHolder
    && !waitAdvice
    && contractEntry
    && (deferredBySession || entryAboveCurrent)
  )
  const effectiveWaitAdvice = waitAdvice || !!deferredEntry
  const watchLevels = deferredEntry
    ? [{
        key: entryAboveCurrent
          ? 'watch_breakout'
          : 'watch_pullback',
        label: entryAboveCurrent ? '突破观察' : '回踩观察',
        price: entryPrice,
        direction: entryAboveCurrent ? 'GTE' : 'LTE',
        strict: true,
      }]
    : adviceObservationLevels(advice)
  if (
    candidate
    && effectiveWaitAdvice
    && candidate.alertSyncedPrice != null
  ) {
    candidate.alertSyncedPrice = null
    changed = true
  }
  if (
    candidate
    && effectiveWaitAdvice
    && !watchLevels.length
    && candidate.reviewSyncedPrices != null
  ) {
    candidate.reviewSyncedPrices = null
    changed = true
  }
  if (candidate && !effectiveWaitAdvice) {
    if (candidate.reviewSyncedPrice != null) {
      candidate.reviewSyncedPrice = null
      changed = true
    }
    if (candidate.reviewSyncedPrices != null) {
      candidate.reviewSyncedPrices = null
      changed = true
    }
  }

  if (
    candidate
    && !liveHolder
    && !candidate.alertMuted
    && effectiveWaitAdvice
    && watchLevels.length
  ) {
    const syncedPrices = {}
    for (const watchLevel of watchLevels) {
      const op = watchLevel.direction === 'LTE' ? 'lte' : 'gte'
      const reviewPrice = roundPrice(watchLevel.price)
      if (reviewPrice == null) continue
      const reviewKey = watchLevel.key
      const patternConfirmation = strategyPatternConfirmationFor(
        advice,
        reviewKey === 'watch_breakout' ? 'BREAKOUT'
          : reviewKey === 'watch_pullback' ? 'PULLBACK'
            : '',
      )
      const previous = alerts.find((alert) =>
        alert?.candCode === code
        && alert.reviewOnly === true
        && (
          alert.reviewKey === reviewKey
          || (
            !alert.reviewKey
            && Number(alert.value) === reviewPrice
            && alert.op === op
          )
        )
      )
      if (previous) {
        const refreshed = refreshReviewAlert(previous, {
          ...previous,
          value: reviewPrice,
          op,
          note: watchLevel.label,
          reviewKey,
          judgeContext,
          reviewIntent,
          ...(patternConfirmation
            ? { strategyPatternConfirmation: patternConfirmation }
            : {}),
        }, adviceAt)
        if (JSON.stringify(refreshed) !== JSON.stringify(previous)) {
          changed = true
        }
        projected.push(refreshed)
      } else {
        projected.push({
          ...baseAlert({
            idFactory,
            now,
            code,
            name,
            op,
            value: reviewPrice,
            note: watchLevel.label,
          }),
          candCode: code,
          reviewOnly: true,
          reviewKey,
          judgeContext,
          reviewIntent,
          ...(patternConfirmation
            ? { strategyPatternConfirmation: patternConfirmation }
            : {}),
          phase: 'armed',
        })
        changed = true
      }
      syncedPrices[reviewKey] = reviewPrice
    }
    if (
      JSON.stringify(candidate.reviewSyncedPrices || {})
      !== JSON.stringify(syncedPrices)
    ) {
      candidate.reviewSyncedPrices = syncedPrices
      changed = true
    }
  }

  if (
    candidate
    && !liveHolder
    && !candidate.alertMuted
    && !effectiveWaitAdvice
  ) {
    const contractLevel = advicePriceLevel(advice, 'entry')
    if (priceContract && !contractLevel) {
      data.alerts = rest
      return oldProjected.length !== 0
    }
    const triggerZone = judgeContext.addZone
    const buyPrice = roundPrice(
      contractLevel?.price
      ?? triggerZone?.high
      ?? advice.buyPrice,
    )
    if (buyPrice != null) {
      const patternConfirmation =
        strategyPatternConfirmationFor(advice)
      const previous = alerts.find((a) => a && a.candCode === code)
      const samePlan = !!(
        previous?.judgeContext?.planId
        && judgeContext.planId
        && previous.judgeContext.planId === judgeContext.planId
      )
      if (previous && (Number(previous.value) === buyPrice || samePlan)) {
        projected.push({
          ...previous,
          value: buyPrice,
          ...(triggerZone ? { triggerZone } : {}),
          ...((triggerZone || priceContract) ? { judgeContext } : {}),
          ...(patternConfirmation
            ? { strategyPatternConfirmation: patternConfirmation }
            : {}),
        })
      } else {
        projected.push({
          ...baseAlert({ idFactory, now, code, name, op: 'lte', value: buyPrice, note: '买点' }),
          candCode: code,
          phase: 'armed',
          ...(triggerZone ? { triggerZone } : {}),
          ...((triggerZone || priceContract) ? { judgeContext } : {}),
          ...(patternConfirmation
            ? { strategyPatternConfirmation: patternConfirmation }
            : {}),
        })
        changed = true
      }
      if (Number(candidate.alertSyncedPrice) !== buyPrice) {
        candidate.alertSyncedPrice = buyPrice
        changed = true
      }
    }
  }

  projected.push(...holdingAddReviews)

  const exitReview = liveHolder
    ? decisionExitReviewOf(advice)
    : null
  let exitReviewProjected = false
  if (exitReview) {
    const contractLevel = advicePriceLevel(advice, 'reduce')
      || advicePriceLevel(advice, 'target')
    const reviewPrice = roundPrice(
      contractLevel?.price
      ?? advice.decisionPlan?.prices?.reference
      ?? advice.reducePrice,
    )
    if (reviewPrice != null) {
      const direction = executionTriggerDirection({
        action: advice.decisionPlan.action,
        trigger: advice.decisionPlan.trigger || advice.actionPlan,
        triggerDirection: advice.decisionPlan.triggerDirection,
      })
      const op = direction === 'GTE' ? 'gte' : 'lte'
      const previous = alerts.find((alert) =>
        alert?.actCode === code
        && alert.reviewOnly === true
        && alert.reviewCategory === 'holding-exit'
      )
      const samePlan = !!(
        previous?.judgeContext?.decisionPlan?.decisionId
        && previous.judgeContext.decisionPlan.decisionId
          === advice.decisionPlan.decisionId
      )
      const next = previous && samePlan
        ? refreshReviewAlert(previous, {
            ...previous,
            value: reviewPrice,
            op,
            note: '退出前复核',
            reviewKey: 'holding-exit',
            reviewCategory: 'holding-exit',
            judgeContext,
            reviewIntent: exitReview,
          }, adviceAt)
        : {
            ...baseAlert({
              idFactory,
              now,
              code,
              name,
              op,
              value: reviewPrice,
              note: '退出前复核',
            }),
            actCode: code,
            reviewOnly: true,
            reviewKey: 'holding-exit',
            reviewCategory: 'holding-exit',
            judgeContext,
            reviewIntent: exitReview,
            phase: 'armed',
          }
      projected.push(next)
      exitReviewProjected = true
      if (!previous || !samePlan || JSON.stringify(previous) !== JSON.stringify(next)) {
        changed = true
      }
    }
  }

  const opQty = advice.opQty || ''
  const timing = advice.exitTiming || advice.actionPlan || ''
  const t1Status = options.t1Status || null
  const nextTradeDay = options.nextTradeDay || ''
  const buildAction = (kind, op, rawPrice, muted) => {
    if (muted) return
    const contractLevel = advicePriceLevel(advice, kind)
      || (kind === 'reduce'
        ? advicePriceLevel(advice, 'target')
        : null)
    if (priceContract && !contractLevel) return
    const triggerZone = kind === 'add'
      ? judgeContext.addZone
      : judgeContext.reduceZone
    const zoneTrigger = kind === 'add'
      ? triggerZone?.high
      : triggerZone?.low
    const value = roundPrice(
      contractLevel?.price
      ?? zoneTrigger
      ?? rawPrice,
    )
    if (value == null) return
    const actionQty = kind === 'add'
      ? (/加仓|补仓|买回|接回/.test(opQty) ? opQty : '')
      : (/减仓|卖出|清仓/.test(opQty) ? opQty : '')
    const previous = alerts.find((a) => a && a.actCode === code && a.actKind === kind)
    const samePlan = !!(
      previous?.judgeContext?.planId
      && judgeContext.planId
      && previous.judgeContext.planId === judgeContext.planId
    )
    if (previous && (Number(previous.value) === value || samePlan)) {
      const source = (actionQty || timing)
        ? {
            ...previous,
            value,
            opQty: actionQty,
            ...(timing ? { timing } : {}),
            ...(triggerZone ? { triggerZone } : {}),
            judgeContext,
          }
        : {
            ...previous,
            value,
            ...(triggerZone ? { triggerZone } : {}),
            judgeContext,
          }
      const refreshed = applyT1ToAlert(source, kind === 'reduce' ? t1Status : null, nextTradeDay)
      if (JSON.stringify(refreshed) !== JSON.stringify(previous)) changed = true
      projected.push(refreshed)
      return
    }
    const next = {
      ...baseAlert({
        idFactory,
        now,
        code,
        name,
        op,
        value,
        note: kind === 'add'
          ? '补仓点'
          : advice.decisionPlan?.positionEffect?.fullExit === true
            ? '清仓观察位'
            : '减仓观察位',
      }),
      actCode: code,
      actKind: kind,
      opQty: actionQty,
      timing,
      ...(triggerZone ? { triggerZone } : {}),
      judgeContext,
      phase: 'armed',
    }
    projected.push(applyT1ToAlert(next, kind === 'reduce' ? t1Status : null, nextTradeDay))
    changed = true
  }

  if (liveHolder) {
    if (adviceSupportsIntent('add', judgeContext)) {
      buildAction('add', 'lte', advice.addPrice, liveHolder.muteAdd)
    }
    if (!exitReviewProjected) {
      const reduceDirection = executionTriggerDirection({
        action: advice.decisionPlan?.action || 'REDUCE',
        trigger: advice.actionPlan
          || advice.nextAction
          || advice.exitTiming,
        triggerDirection: advice.decisionPlan?.triggerDirection,
      })
      buildAction(
        'reduce',
        reduceDirection === 'LTE' ? 'lte' : 'gte',
        advice.reducePrice,
        liveHolder.muteReduce,
      )
    }
  }

  if (oldProjected.length !== projected.length) changed = true
  const finalProjected = projected.map((alert) =>
    decisionAlert(alert, advice)
  )
  if (JSON.stringify(finalProjected) !== JSON.stringify(oldProjected)) changed = true
  data.alerts = [...finalProjected, ...rest]
  return changed
}
