import { applyT1ToAlert } from './t1AdvicePolicy.js'
import { adviceSupportsIntent, buildJudgeAdviceContext } from './judgeAdviceContext.js'
import {
  adviceObservationLevels,
  advicePriceLevel,
  sanitizedAdvicePriceContract,
} from './advicePriceContract.js'
import { isAdviceReviewEnabled } from './adviceReviewPolicy.js'
import { executionTriggerDirection } from './executionTrigger.js'
import { holdingAddReviewPlan } from './holdingFollowUp.js'

function roundPrice(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 10 ? +n.toFixed(3) : +n.toFixed(2)
}

function defaultId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
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

function reviewIntentOf(advice = {}) {
  const policy = advice.decisionPlan?.actionPolicy || {}
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
    maxPositionPct: null,
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
    options.t1Status == null ||
    Number(options.t1Status.liveQty) > 0
  )
  const rest = alerts.filter((a) => !isOwnedAutoAlert(a))
  if (!liveHolder && !candidate) {
    if (rest.length !== alerts.length) changed = true
    data.alerts = rest
    return changed
  }
  const owner = liveHolder || candidate || {}
  const name = advice.name || owner.name || code
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
  const judgeContext = buildJudgeAdviceContext(advice)
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
        })
      } else {
        projected.push({
          ...baseAlert({ idFactory, now, code, name, op: 'lte', value: buyPrice, note: '买点' }),
          candCode: code,
          phase: 'armed',
          ...(triggerZone ? { triggerZone } : {}),
          ...((triggerZone || priceContract) ? { judgeContext } : {}),
        })
        changed = true
      }
      if (Number(candidate.alertSyncedPrice) !== buyPrice) {
        candidate.alertSyncedPrice = buyPrice
        changed = true
      }
    }
  }

  const holdingFollowUp = liveHolder
    ? holdingAddReviewPlan(advice)
    : null
  if (holdingFollowUp?.paths?.length) {
    for (const path of holdingFollowUp.paths) {
      const op = path.direction === 'LTE' ? 'lte' : 'gte'
      const reviewPrice = roundPrice(path.price)
      if (reviewPrice == null) continue
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
        const refreshed = refreshReviewAlert(previous, {
          ...previous,
          note: path.label,
          judgeContext,
          reviewIntent: holdingFollowUp.reviewIntent,
        }, adviceAt)
        if (JSON.stringify(refreshed) !== JSON.stringify(previous)) {
          changed = true
        }
        projected.push(refreshed)
        continue
      }
      projected.push({
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
        reviewIntent: holdingFollowUp.reviewIntent,
        phase: 'armed',
      })
      changed = true
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
        note: kind === 'add' ? '补仓点' : '减仓点',
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

  if (oldProjected.length !== projected.length) changed = true
  data.alerts = [...projected, ...rest]
  return changed
}
