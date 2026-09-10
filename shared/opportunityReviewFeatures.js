export const OPPORTUNITY_REVIEW_FEATURE_SCHEMA_VERSION =
  'opportunity-review-feature.v1'

export const OPPORTUNITY_REVIEW_FEATURE_NAMES = Object.freeze([
  'observationBars',
  'changeFromTriggerPct',
  'lowFromTriggerPct',
  'highFromTriggerPct',
  'closeLocationPct',
  'volumeContinuation',
  'aboveTriggerRatio',
  'aboveVwapRatio',
  'reclaimedVwap',
  'heldAboveVwap',
  'higherLows',
  'lowerHighs',
  'initialPFill',
  'initialPWinGivenFill',
  'initialExpectedNetR',
  'direction_BREAKOUT',
  'direction_PULLBACK',
  'direction_EXIT',
  'direction_UNKNOWN',
])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 6) {
  const number = finite(value)
  return number == null ? 0 : +number.toFixed(digits)
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function average(values) {
  const valid = values.filter((value) => finite(value) != null)
  return valid.length
    ? valid.reduce((sum, value) => sum + Number(value), 0) / valid.length
    : 0
}

function directionOf(value) {
  const normalized = String(value || '').toUpperCase()
  if (/BREAKOUT|GTE/.test(normalized)) return 'BREAKOUT'
  if (/PULLBACK|LTE|BUY|ADD/.test(normalized)) return 'PULLBACK'
  if (/EXIT|REDUCE|SELL|STOP/.test(normalized)) return 'EXIT'
  return 'UNKNOWN'
}

function normalizedRows(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item) => ({
      price: finite(item?.price ?? item?.close),
      high: finite(item?.high ?? item?.price ?? item?.close),
      low: finite(item?.low ?? item?.price ?? item?.close),
      volume: Math.max(0, finite(item?.volume) ?? 0),
      vwap: finite(item?.vwap ?? item?.avg),
    }))
    .filter((item) =>
      item.price > 0
      && item.high > 0
      && item.low > 0
    )
}

export function buildOpportunityReviewFeatureInput({
  code,
  asOf,
  triggerPrice,
  direction,
  rows = [],
  initialScore = {},
} = {}) {
  const normalizedCode = String(code || '')
  const timestamp = finite(asOf)
  const anchor = finite(triggerPrice)
  const path = normalizedRows(rows).slice(0, 12)
  if (
    !/^\d{6}$/.test(normalizedCode)
    || !(timestamp > 0)
    || !(anchor > 0)
    || !path.length
  ) return null
  const firstHalf = path.slice(0, Math.max(1, Math.floor(path.length / 2)))
  const secondHalf = path.slice(Math.max(1, Math.floor(path.length / 2)))
  const latest = path.at(-1)
  const high = Math.max(...path.map((item) => item.high))
  const low = Math.min(...path.map((item) => item.low))
  const range = high - low
  const priorVolume = average(firstHalf.map((item) => item.volume))
  const recentVolume = average(secondHalf.map((item) => item.volume))
  const aboveVwap = path.filter(
    (item) => item.vwap > 0 && item.price >= item.vwap,
  )
  const hadBelowVwap = path.some(
    (item) => item.vwap > 0 && item.price < item.vwap,
  )
  const recent = path.slice(-2)
  const selectedDirection = directionOf(direction)
  const factors = {
    observationBars: path.length,
    changeFromTriggerPct: (latest.price / anchor - 1) * 100,
    lowFromTriggerPct: (low / anchor - 1) * 100,
    highFromTriggerPct: (high / anchor - 1) * 100,
    closeLocationPct: range > 0
      ? (latest.price - low) / range
      : 0.5,
    volumeContinuation: priorVolume > 0
      ? recentVolume / priorVolume
      : 0,
    aboveTriggerRatio: path.filter(
      (item) => item.price >= anchor,
    ).length / path.length,
    aboveVwapRatio: aboveVwap.length / path.length,
    reclaimedVwap: hadBelowVwap
      && latest.vwap > 0
      && latest.price >= latest.vwap ? 1 : 0,
    heldAboveVwap: recent.length >= 2
      && recent.every(
        (item) => item.vwap > 0 && item.price >= item.vwap,
      ) ? 1 : 0,
    higherLows: secondHalf.length
      && Math.min(...secondHalf.map((item) => item.low))
        >= Math.min(...firstHalf.map((item) => item.low)) ? 1 : 0,
    lowerHighs: secondHalf.length
      && Math.max(...secondHalf.map((item) => item.high))
        <= Math.max(...firstHalf.map((item) => item.high)) ? 1 : 0,
    initialPFill: clamp(finite(initialScore.pFill) ?? 0, 0, 1),
    initialPWinGivenFill: clamp(
      finite(initialScore.pWinGivenFill) ?? 0,
      0,
      1,
    ),
    initialExpectedNetR: finite(initialScore.expectedNetR) ?? 0,
  }
  for (const name of [
    'BREAKOUT',
    'PULLBACK',
    'EXIT',
    'UNKNOWN',
  ]) {
    factors[`direction_${name}`] = selectedDirection === name ? 1 : 0
  }
  return {
    schemaVersion: OPPORTUNITY_REVIEW_FEATURE_SCHEMA_VERSION,
    asOf: timestamp,
    code: normalizedCode,
    factors: Object.fromEntries(
      OPPORTUNITY_REVIEW_FEATURE_NAMES.map((name) => [
        name,
        rounded(factors[name]),
      ]),
    ),
  }
}
