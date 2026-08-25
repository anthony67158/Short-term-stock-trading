import { applyT1ToAlert } from './t1AdvicePolicy.js'
import { adviceSupportsIntent, buildJudgeAdviceContext } from './judgeAdviceContext.js'
import {
  advicePriceLevel,
  sanitizedAdvicePriceContract,
} from './advicePriceContract.js'
import { isAdviceReviewEnabled } from './adviceReviewPolicy.js'
import { executionTriggerDirection } from './executionTrigger.js'

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

export function projectAdviceAlerts(data, code, advice, options = {}) {
  if (!data || !code || !advice) return false
  const now = options.now ?? Date.now()
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
  const judgeContext = buildJudgeAdviceContext(advice)
  const priceContract = sanitizedAdvicePriceContract(advice)
  const oldProjected = alerts.filter(isOwnedAutoAlert)
  if (options.requirePriceContract === true && !priceContract) {
    data.alerts = rest
    return oldProjected.length > 0
  }

  if (candidate && !liveHolder && !candidate.alertMuted) {
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
