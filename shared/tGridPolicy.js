function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function beijingMinutes(now) {
  const date = new Date(Number(now) + 8 * 60 * 60 * 1000)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}

export function evaluateTGridEligibility({
  marketRegime = 'UNKNOWN',
  hasBasePosition = false,
  sellableLots = 0,
  adv20 = 0,
  atrPct = null,
  amplitudePct = null,
  materialNegativeNews = false,
  isLimitDown = false,
  completedToday = 0,
  netBuyLots = 0,
  now = Date.now(),
  limits = {},
} = {}) {
  const minimumAdv20 = finite(limits.minimumAdv20) ?? 80_000_000
  const minimumAtrPct = finite(limits.minimumAtrPct) ?? 1.2
  const maximumAtrPct = finite(limits.maximumAtrPct) ?? 5
  const minimumAmplitudePct = finite(limits.minimumAmplitudePct) ?? 2.5
  const maximumRounds = Math.max(
    1,
    Math.trunc(finite(limits.maximumRounds) || 2),
  )
  const maximumNetBuyLots = Math.max(
    0,
    Math.trunc(finite(limits.maximumNetBuyLots) || 1),
  )
  const cutoffMinutes = Math.max(
    570,
    Math.min(900, Math.trunc(finite(limits.cutoffMinutes) || 870)),
  )
  const reasons = []
  if (marketRegime !== 'RANGE') reasons.push('MARKET_NOT_RANGE')
  if (!hasBasePosition) reasons.push('NO_BASE_POSITION')
  if (!(Number(sellableLots) > 0)) reasons.push('NO_SELLABLE_BASE')
  if (!(Number(adv20) >= minimumAdv20)) reasons.push('LIQUIDITY_TOO_LOW')
  if (
    !(finite(atrPct) >= minimumAtrPct)
    || !(finite(atrPct) <= maximumAtrPct)
  ) reasons.push('ATR_OUT_OF_RANGE')
  if (!(finite(amplitudePct) >= minimumAmplitudePct)) {
    reasons.push('AMPLITUDE_TOO_LOW')
  }
  if (materialNegativeNews) reasons.push('MATERIAL_NEGATIVE_NEWS')
  if (isLimitDown) reasons.push('LIMIT_DOWN_RISK')
  if (Number(completedToday) >= maximumRounds) {
    reasons.push('DAILY_ROUND_LIMIT')
  }
  if (Number(netBuyLots) >= maximumNetBuyLots) {
    reasons.push('MAX_NET_BUY_REACHED')
  }
  if (beijingMinutes(now) >= cutoffMinutes) {
    reasons.push('RESTORE_CUTOFF_REACHED')
  }
  return {
    schemaVersion: 't-grid-eligibility.v1',
    eligible: reasons.length === 0,
    reasons,
    limits: {
      minimumAdv20,
      minimumAtrPct,
      maximumAtrPct,
      minimumAmplitudePct,
      maximumRounds,
      maximumNetBuyLots,
      cutoffMinutes,
    },
  }
}

export function buildTGridExperiment({
  eligibility,
  referencePrice,
  baseLots,
  maxNetBuyLots = 1,
  atrPct = 2,
} = {}) {
  if (eligibility?.eligible !== true) {
    return {
      schemaVersion: 't-grid-experiment.v1',
      eligible: false,
      automaticExecution: false,
      reasons: eligibility?.reasons || ['NOT_ELIGIBLE'],
      levels: [],
    }
  }
  const price = finite(referencePrice)
  const lots = Math.max(0, Math.trunc(finite(baseLots) || 0))
  if (!(price > 0) || lots <= 0) {
    throw new Error('做T实验缺少有效参考价或底仓')
  }
  const perLevelLots = Math.max(
    1,
    Math.min(
      Math.trunc(finite(maxNetBuyLots) || 1),
      Math.max(1, Math.floor(lots / 3)),
    ),
  )
  const atr = price * Math.max(0.012, Math.min(0.05, (
    finite(atrPct) || 2
  ) / 100))
  const round = (value) => +(value < 10
    ? value.toFixed(3)
    : value.toFixed(2))
  return {
    schemaVersion: 't-grid-experiment.v1',
    eligible: true,
    automaticExecution: false,
    referencePrice: price,
    restoreBy: '14:30',
    maximumRounds: eligibility.limits.maximumRounds,
    maximumNetBuyLots: Math.min(
      perLevelLots,
      eligibility.limits.maximumNetBuyLots,
    ),
    levels: [
      {
        sequence: 1,
        side: 'BUY',
        lots: perLevelLots,
        price: round(price - atr),
        condition: '回落后缩量企稳且未破区间下沿',
      },
      {
        sequence: 2,
        side: 'SELL',
        lots: perLevelLots,
        price: round(price + atr),
        condition: '反弹至区间上沿且出现滞涨',
      },
    ],
  }
}
