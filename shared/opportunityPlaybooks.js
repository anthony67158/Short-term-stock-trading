export const OPPORTUNITY_PLAYBOOK_VERSION = 'opportunity-playbook.v1'

export const PLAYBOOKS = Object.freeze([
  'MOMENTUM_BREAKOUT',
  'LEADER_PULLBACK',
  'ACCUMULATION',
  'CATALYST',
  'PANIC_REVERSAL',
  'RANGE_REVERSION',
])

const LABELS = Object.freeze({
  MOMENTUM_BREAKOUT: '主升突破',
  LEADER_PULLBACK: '核心回踩',
  ACCUMULATION: '资金潜伏',
  CATALYST: '催化先手',
  PANIC_REVERSAL: '恐慌修复',
  RANGE_REVERSION: '区间低吸',
})

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

function bell(value, center, width) {
  const number = finite(value)
  if (number == null) return 40
  return clamp(100 - Math.abs(number - center) / Math.max(width, 0.01) * 100)
}

function booleanScore(value, yes = 100, no = 20) {
  return value === true ? yes : value === false ? no : 50
}

function patternBlend(base, pattern, coverage, maximumWeight) {
  const available = clamp((finite(coverage) ?? 0) * 100) / 100
  const weight = maximumWeight * available
  return clamp(base * (1 - weight) + (finite(pattern) ?? 0) * weight)
}

function sectorStrength(candidate = {}) {
  const sector = candidate.sector || {}
  const phase = String(sector.phase || '')
  const action = String(sector.actionability || '')
  let score = finite(sector.nextScore ?? sector.forecast?.next?.score) ?? 50
  if (['ACCUMULATION', 'STARTUP'].includes(phase)) score += 12
  if (phase === 'ACCELERATION') score += 5
  if (['DIVERGENCE', 'RETREAT'].includes(phase)) score -= 18
  if (action === 'LAYOUT') score += 10
  if (action === 'AVOID') score -= 20
  return clamp(score)
}

function roleStrength(candidate = {}) {
  const role = String(
    candidate.stockRole
    || candidate.sectorOpportunity?.stock?.role
    || candidate.stock?.role
    || '',
  ).toLowerCase()
  if (/leader|core|龙头|核心/.test(role)) return 100
  if (/front|elastic|前排|弹性/.test(role)) return 82
  if (/follower|补涨|跟随/.test(role)) return 58
  if (/laggard|后排|掉队/.test(role)) return 20
  return 50
}

function flowStrength(candidate = {}) {
  const fund = candidate.fund || {}
  const quote = candidate.quote || {}
  const shadow = candidate.shadowFeatures || {}
  const mainNet = finite(
    fund.mainNetYi
    ?? shadow.mainNetYi
    ?? (
      quote.mainInflow == null
        ? null
        : Number(quote.mainInflow) / 1e8
    ),
  )
  const retailNet = finite(
    fund.retailNetYi
    ?? fund.smallNetYi
    ?? shadow.retailNetYi,
  )
  const mainRatio = finite(fund.mainRatio ?? quote.mainRatio) ?? 0
  let score = 50 + clamp(mainRatio * 3, -28, 28)
  if (mainNet != null) score += clamp(mainNet * 4, -24, 24)
  if (mainNet > 0 && retailNet < 0) score += 10
  if (mainNet < 0 && retailNet > 0) score -= 18
  return clamp(score)
}

function liquidityStrength(candidate = {}) {
  const quote = candidate.quote || {}
  const shadow = candidate.shadowFeatures || {}
  const learned = finite(shadow.liquidityComposite)
  if (learned != null && learned > 0) return clamp(learned)
  const amount = Math.max(0, finite(quote.amount) || 0)
  const turnover = Math.max(0, finite(quote.turnover) || 0)
  return clamp(
    20
    + Math.log10(Math.max(1, amount)) * 8
    + Math.min(turnover, 12) * 2
    - 48,
  )
}

function evidenceFor(key, factors, candidate) {
  const values = {
    MOMENTUM_BREAKOUT: [
      `动量${Math.round(factors.momentum)}分`,
      `板块承接${Math.round(factors.sector)}分`,
    ],
    LEADER_PULLBACK: [
      `核心地位${Math.round(factors.role)}分`,
      `回踩质量${Math.round(factors.pullback)}分`,
    ],
    ACCUMULATION: [
      `资金结构${Math.round(factors.flow)}分`,
      `价格尚未加速${Math.round(factors.underReaction)}分`,
    ],
    CATALYST: [
      `催化强度${Math.round(factors.catalyst)}分`,
      `价格低反应${Math.round(factors.underReaction)}分`,
    ],
    PANIC_REVERSAL: [
      `修复结构${Math.round(factors.reversal)}分`,
      `流动性${Math.round(factors.liquidity)}分`,
    ],
    RANGE_REVERSION: [
      `区间位置${Math.round(factors.pullback)}分`,
      `承接强度${Math.round(factors.flow)}分`,
    ],
  }[key] || []
  const patternEvidence = {
    MOMENTUM_BREAKOUT: factors.patternMomentum >= 70
      ? `突破形态${Math.round(factors.patternMomentum)}分`
      : null,
    LEADER_PULLBACK: factors.patternPullback >= 70
      ? `回踩形态${Math.round(factors.patternPullback)}分`
      : null,
    ACCUMULATION: factors.patternAccumulation >= 70
      ? `量价承接${Math.round(factors.patternAccumulation)}分`
      : null,
    PANIC_REVERSAL: factors.patternReversal >= 70
      ? `下影修复${Math.round(factors.patternReversal)}分`
      : null,
    RANGE_REVERSION: factors.patternRange >= 70
      ? `低波动结构${Math.round(factors.patternRange)}分`
      : null,
  }[key]
  return [
    ...values,
    patternEvidence,
    ...(candidate.evidence || []).slice(0, 2),
  ].filter(Boolean).slice(0, 4)
}

export function scoreOpportunityPlaybooks(
  candidate = {},
  marketContext = {},
) {
  const quote = candidate.quote || {}
  const shadow = candidate.shadowFeatures || {}
  const pct = finite(quote.pct) ?? 0
  const volumeRatio = finite(quote.volumeRatio) ?? 1
  const vwapDistance = finite(shadow.vwapDistancePct) ?? 0
  const orderFlow = finite(shadow.orderImbalanceShort)
  const overheat = finite(
    candidate.crowdingRisk
    ?? shadow.overheatReversalRisk,
  ) ?? Math.max(0, pct - 4) * 12
  const formula = String(candidate.formulaId || '')
  const entryType = String(candidate.entryPlan?.type || candidate.priceType || '')
  const origin = String(candidate.origin || '')
  const sector = sectorStrength(candidate)
  const role = roleStrength(candidate)
  const flow = flowStrength(candidate)
  const liquidity = liquidityStrength(candidate)
  const momentum = clamp(
    bell(pct, 4.5, 6) * 0.38
    + bell(volumeRatio, 1.8, 1.8) * 0.2
    + clamp((orderFlow ?? 0) + 50) * 0.2
    + sector * 0.14
    + role * 0.08
    - overheat * 0.25,
  )
  const pullback = clamp(
    bell(pct, 0.8, 4) * 0.28
    + bell(vwapDistance, 0, 2.5) * 0.24
    + flow * 0.2
    + role * 0.16
    + sector * 0.12
    + (/PULLBACK/.test(`${formula} ${entryType}`) ? 12 : 0),
  )
  const underReaction = clamp(
    finite(candidate.underReactionScore)
    ?? (
      bell(pct, 0.5, 4) * 0.6
      + bell(volumeRatio, 1.1, 1.5) * 0.4
    ),
  )
  const catalyst = clamp(
    finite(candidate.activationScore)
    ?? finite(candidate.eventScore)
    ?? (origin === 'PRE_CATALYST' ? 68 : 35),
  )
  const reversal = clamp(
    bell(pct, -3, 5) * 0.34
    + clamp((orderFlow ?? 0) + 50) * 0.24
    + flow * 0.2
    + liquidity * 0.12
    + booleanScore(pct < 0 && vwapDistance >= -1) * 0.1,
  )
  const patternCoverage = candidate.strategyPatternPolicy === 'ACTIVE'
    ? finite(shadow.patternHistoryCoverage) ?? 0
    : 0
  const patternMomentum = Math.max(
    finite(shadow.patternPlatformBreakoutScore) ?? 0,
    finite(shadow.patternVolumePriceSurgeScore) ?? 0,
  )
  const patternPullback = Math.max(
    finite(shadow.patternSupportPullbackScore) ?? 0,
    finite(shadow.patternLowVolTrendScore) ?? 0,
  )
  const patternAccumulation = Math.max(
    finite(shadow.patternVolumePriceSurgeScore) ?? 0,
    finite(shadow.patternSupportPullbackScore) ?? 0,
  )
  const patternReversal =
    finite(shadow.patternLowerShadowReversalScore) ?? 0
  const patternRange = Math.max(
    finite(shadow.patternSupportPullbackScore) ?? 0,
    finite(shadow.patternLowVolTrendScore) ?? 0,
  )
  const factors = {
    momentum,
    pullback,
    underReaction,
    catalyst,
    reversal,
    flow,
    sector,
    role,
    liquidity,
    overheat: clamp(overheat),
    patternMomentum,
    patternPullback,
    patternAccumulation,
    patternReversal,
    patternRange,
  }
  const base = {
    MOMENTUM_BREAKOUT:
      momentum * 0.58 + sector * 0.2 + role * 0.12 + liquidity * 0.1,
    LEADER_PULLBACK:
      pullback * 0.5 + role * 0.22 + flow * 0.16 + sector * 0.12,
    ACCUMULATION:
      flow * 0.4 + underReaction * 0.27 + sector * 0.18 + liquidity * 0.15,
    CATALYST:
      catalyst * 0.42 + underReaction * 0.28 + flow * 0.16 + liquidity * 0.14,
    PANIC_REVERSAL:
      reversal * 0.5 + flow * 0.18 + role * 0.12 + liquidity * 0.2,
    RANGE_REVERSION:
      pullback * 0.42 + flow * 0.23 + liquidity * 0.2
        + (100 - clamp(overheat)) * 0.15,
  }
  const raw = {
    MOMENTUM_BREAKOUT: patternBlend(
      base.MOMENTUM_BREAKOUT,
      patternMomentum,
      patternCoverage,
      0.2,
    ),
    LEADER_PULLBACK: patternBlend(
      base.LEADER_PULLBACK,
      patternPullback,
      patternCoverage,
      0.2,
    ),
    ACCUMULATION: patternBlend(
      base.ACCUMULATION,
      patternAccumulation,
      patternCoverage,
      0.12,
    ),
    CATALYST: base.CATALYST,
    PANIC_REVERSAL: patternBlend(
      base.PANIC_REVERSAL,
      patternReversal,
      patternCoverage,
      0.2,
    ),
    RANGE_REVERSION: patternBlend(
      base.RANGE_REVERSION,
      patternRange,
      patternCoverage,
      0.15,
    ),
  }
  const weights = marketContext.playbookWeights || {}
  const scored = PLAYBOOKS.map((key) => {
    const marketWeight = finite(weights[key]) ?? 1
    const score = clamp(raw[key] * marketWeight)
    return {
      key,
      label: LABELS[key],
      score: rounded(score, 1),
      marketWeight: rounded(marketWeight, 2),
      evidence: evidenceFor(key, factors, candidate),
    }
  }).sort((left, right) => right.score - left.score)
  return {
    schemaVersion: OPPORTUNITY_PLAYBOOK_VERSION,
    selected: scored[0],
    alternatives: scored.slice(1, 3),
    factors: Object.fromEntries(
      Object.entries(factors).map(([key, value]) => [
        key,
        rounded(value, 1),
      ]),
    ),
  }
}
