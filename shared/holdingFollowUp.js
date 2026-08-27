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
