export const MARKET_OPPORTUNITY_CONTEXT_VERSION =
  'market-opportunity-context.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value))
}

function rounded(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function phaseFrom({
  score,
  breadthBalance,
  breakRatePct,
  limitUp,
  limitDown,
  hardRisk,
}) {
  if (hardRisk && score < 35) return 'PANIC'
  if (score >= 68 && breadthBalance >= 0.12) return 'TREND_EXPANSION'
  if (score >= 58 && limitUp >= 25 && breakRatePct <= 25) {
    return 'MAINLINE_ADVANCE'
  }
  if (score <= 42 && breadthBalance < -0.12) return 'RETREAT'
  if (score < 52 && limitDown > 0 && breakRatePct >= 30) {
    return 'HIGH_VOLATILITY'
  }
  if (Math.abs(breadthBalance) <= 0.12) return 'ROTATION'
  return score >= 50 ? 'RECOVERY' : 'DIVERGENCE'
}

function playbookWeights(phase) {
  return {
    TREND_EXPANSION: {
      MOMENTUM_BREAKOUT: 1.22,
      LEADER_PULLBACK: 1.12,
      ACCUMULATION: 0.92,
      CATALYST: 0.94,
      PANIC_REVERSAL: 0.55,
      RANGE_REVERSION: 0.7,
    },
    MAINLINE_ADVANCE: {
      MOMENTUM_BREAKOUT: 1.18,
      LEADER_PULLBACK: 1.2,
      ACCUMULATION: 0.9,
      CATALYST: 0.92,
      PANIC_REVERSAL: 0.62,
      RANGE_REVERSION: 0.72,
    },
    RECOVERY: {
      MOMENTUM_BREAKOUT: 1,
      LEADER_PULLBACK: 1.16,
      ACCUMULATION: 1.08,
      CATALYST: 1,
      PANIC_REVERSAL: 1.08,
      RANGE_REVERSION: 0.92,
    },
    ROTATION: {
      MOMENTUM_BREAKOUT: 0.78,
      LEADER_PULLBACK: 1.05,
      ACCUMULATION: 1.16,
      CATALYST: 1.12,
      PANIC_REVERSAL: 0.92,
      RANGE_REVERSION: 1.14,
    },
    DIVERGENCE: {
      MOMENTUM_BREAKOUT: 0.72,
      LEADER_PULLBACK: 0.94,
      ACCUMULATION: 1.04,
      CATALYST: 1.06,
      PANIC_REVERSAL: 0.96,
      RANGE_REVERSION: 1.02,
    },
    HIGH_VOLATILITY: {
      MOMENTUM_BREAKOUT: 0.68,
      LEADER_PULLBACK: 0.88,
      ACCUMULATION: 0.82,
      CATALYST: 1.04,
      PANIC_REVERSAL: 1.18,
      RANGE_REVERSION: 0.86,
    },
    RETREAT: {
      MOMENTUM_BREAKOUT: 0.58,
      LEADER_PULLBACK: 0.78,
      ACCUMULATION: 0.9,
      CATALYST: 1,
      PANIC_REVERSAL: 1.04,
      RANGE_REVERSION: 0.82,
    },
    PANIC: {
      MOMENTUM_BREAKOUT: 0.48,
      LEADER_PULLBACK: 0.7,
      ACCUMULATION: 0.76,
      CATALYST: 0.92,
      PANIC_REVERSAL: 1.24,
      RANGE_REVERSION: 0.72,
    },
  }[phase]
}

export function buildMarketOpportunityContext(input = {}) {
  const market = input.market || input
  const gate = input.marketGate || {}
  const regime = gate.regime || market.regime || {}
  const breadth = market.breadth || regime.breadth || {}
  const sentiment = market.sentiment || regime.sentiment || {}
  const up = finite(breadth.up)
  const down = finite(breadth.down)
  const flat = finite(breadth.flat) || 0
  const total = up != null && down != null
    ? Math.max(1, up + down + flat)
    : null
  const breadthBalance = total == null ? 0 : (up - down) / total
  const score = rounded(
    finite(regime.score)
    ?? finite(market.score)
    ?? clamp(50 + breadthBalance * 50),
    1,
  )
  const limitUp = finite(breadth.limitUp) ?? 0
  const limitDown = finite(breadth.limitDown) ?? 0
  const breakRatePct = finite(sentiment.breakRatePct) ?? 25
  const hardRiskSignals = [
    ...(Array.isArray(regime.hardRiskSignals)
      ? regime.hardRiskSignals
      : []),
    ...(Array.isArray(gate.hardRiskSignals)
      ? gate.hardRiskSignals
      : []),
  ].filter(Boolean)
  const hardRisk = regime.hardRiskOff === true
    || gate.hardRiskOff === true
    || hardRiskSignals.length > 0
  const phase = phaseFrom({
    score,
    breadthBalance,
    breakRatePct,
    limitUp,
    limitDown,
    hardRisk,
  })
  const opportunityFactor = clamp(
    0.72
      + (score - 50) / 125
      + breadthBalance * 0.24
      - Math.max(0, breakRatePct - 30) / 180
      - (hardRisk ? 0.18 : 0),
    0.35,
    1.25,
  )
  const baseRiskPct = clamp(
    0.45 * opportunityFactor,
    0.18,
    0.6,
  )
  return {
    schemaVersion: MARKET_OPPORTUNITY_CONTEXT_VERSION,
    phase,
    score,
    breadthBalance: rounded(breadthBalance, 4),
    limitUp,
    limitDown,
    breakRatePct,
    opportunityFactor: rounded(opportunityFactor, 3),
    baseRiskPct: rounded(baseRiskPct, 3),
    hardRisk,
    hardRiskSignals: [...new Set(hardRiskSignals)].slice(0, 6),
    playbookWeights: playbookWeights(phase),
    note: hardRisk
      ? '市场尾部风险上升，仅保留独立强势、催化和修复类机会'
      : '市场状态用于切换打法和风险预算，不作为普通机会的一票否决',
  }
}
