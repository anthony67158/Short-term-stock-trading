import {
  isDecisionEngineAdvice,
} from './decisionEngineSource.js'

export const HOLDING_FOLLOW_UP_VERSION = 'holding-follow-up.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function compactReasons(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )].slice(0, 3)
}

export function holdingAddReviewPlan(advice = {}) {
  if (advice?.reviewDecision?.terminal === true) return null
  const v3Plan = advice?.holdingAddPlan
  if (
    isDecisionEngineAdvice(advice)
    && v3Plan?.schemaVersion === 'holding-add-plan.v1'
  ) {
    const budget = advice?.decisionPlan?.entryBudget
    const route = String(v3Plan.route || '')
    const watchPrice = finite(v3Plan.price)
    if (
      budget?.state !== 'ESTIMATED'
      || !(Number(budget.lots) > 0)
      || !['PULLBACK', 'BREAKOUT'].includes(route)
      || watchPrice == null
    ) return null
    const probe = v3Plan.plannedAction === 'PROBE_ADD'
    return {
      schemaVersion: HOLDING_FOLLOW_UP_VERSION,
      status: 'ENTRY_CONFIRMATION',
      paths: [{
        key: route === 'PULLBACK'
          ? 'holding_add_pullback'
          : 'holding_add_breakout',
        label: route === 'PULLBACK'
          ? '回踩加仓复核'
          : '突破加仓复核',
        price: watchPrice,
        direction: route === 'PULLBACK' ? 'LTE' : 'GTE',
      }],
      reasons: compactReasons([
        advice.quantNote,
        advice.actionPlan,
      ]),
      summary: probe
        ? '系统加仓方向已通过，到价后确认小仓加仓'
        : '系统加仓方向已通过，到价后确认加仓',
      reviewIntent: {
        mode: 'ENTRY_CONFIRMATION',
        plannedAction: probe ? 'PROBE_ADD' : 'ADD',
        actionLabel: probe ? '条件小仓加仓' : '条件加仓',
        directionApproved: true,
        maxPositionPct: Math.min(
          probe ? 5 : 20,
          finite(v3Plan.maxPositionPct) || (probe ? 5 : 20),
        ),
        manualConfirmationOnly:
          v3Plan.manualConfirmationOnly === true,
      },
    }
  }
  if (advice?.monitoringPlan) return null
  const action = String(
    advice?.decisionPlan?.action
    || advice?.action
    || advice?.stance
    || '',
  ).toUpperCase()
  if (
    ['ADD', 'REDUCE', 'EXIT'].includes(action)
    || /加仓|减仓|清仓|卖出|止损/.test(action)
  ) return null
  const executionText = [
    advice?.actionPlan,
    advice?.nextAction,
    advice?.opQty,
    advice?.serverAdjust,
  ].filter(Boolean).join(' ')
  if (
    /今日无可卖|T\+1.{0,20}(?:锁定|不可卖)|下一交易日.{0,20}(?:减仓|卖出|降低风险)/.test(
      executionText,
    )
  ) return null

  const tactical = advice?.shortHorizonTactical || {}
  const timing = tactical.timing || {}
  const policy = tactical.actionPolicy || {}
  const paths = [
    {
      key: 'holding_add_pullback',
      label: '回踩加仓复核',
      price: finite(timing.pullbackPrice),
      direction: 'LTE',
    },
    {
      key: 'holding_add_breakout',
      label: '突破加仓复核',
      price: finite(timing.breakoutPrice),
      direction: 'GTE',
    },
  ].filter((item) => item.price != null)
  if (!paths.length) return null

  const riskTier = String(policy.riskTier || 'NONE')
  const directionApproved = ['PROBE', 'FULL'].includes(riskTier)
  if (!directionApproved) return null
  const reasons = compactReasons(policy.reasons)
  const probe = riskTier === 'PROBE'
  const probePositionLimitPct = probe
    ? Math.min(5, finite(policy.maxPositionPct) || 5)
    : null
  return {
    schemaVersion: HOLDING_FOLLOW_UP_VERSION,
    status: directionApproved ? 'ENTRY_CONFIRMATION' : 'REASSESSMENT',
    paths,
    reasons,
    summary: directionApproved
      ? probe
        ? '加仓方向已通过，任一到价后确认小仓加仓'
        : '加仓方向已通过，任一到价后确认加仓'
      : `本轮不直接加仓${reasons.length ? `：${reasons.join('；')}` : ''}`,
    reviewIntent: directionApproved
      ? {
          mode: 'ENTRY_CONFIRMATION',
          plannedAction: probe ? 'PROBE_ADD' : 'ADD',
          actionLabel: probe ? '条件小仓加仓' : '条件加仓',
          directionApproved: true,
          maxPositionPct: probePositionLimitPct,
          manualConfirmationOnly: true,
        }
      : {
          mode: 'REASSESSMENT',
          plannedAction: 'WATCH',
          actionLabel: '重新评估加仓',
          directionApproved: false,
          maxPositionPct: null,
          manualConfirmationOnly: false,
        },
  }
}
