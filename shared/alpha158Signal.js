export const ALPHA158_SNAPSHOT_VERSION =
  'alpha158-ranking-snapshot.v1'
export const ALPHA158_SIGNAL_VERSION = 'alpha158-signal.v1'
export const JOINT_OPPORTUNITY_RANK_VERSION =
  'joint-opportunity-rank.v1'

const MAX_ALPHA_WEIGHT = 0.25
const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') {
    return null
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function compactDate(value) {
  const match = String(value || '').match(
    /^(\d{4})-?(\d{2})-?(\d{2})/,
  )
  return match ? `${match[1]}${match[2]}${match[3]}` : null
}

function dateTimestamp(value) {
  const date = compactDate(value)
  if (!date) return null
  const timestamp = Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00+08:00`,
  )
  return Number.isFinite(timestamp) ? timestamp : null
}

function normalizedStock(value = {}) {
  const rawScore = finite(value.rawScore ?? value.score)
  const percentile = finite(value.percentile)
  const rank = Math.trunc(finite(value.rank) || 0)
  if (
    rawScore == null
    || percentile == null
    || percentile < 0
    || percentile > 1
    || rank < 1
  ) return null
  return {
    rawScore,
    percentile,
    rank,
  }
}

export function normalizeAlpha158Snapshot(payload = {}) {
  if (
    payload?.schemaVersion !== ALPHA158_SNAPSHOT_VERSION
    || !compactDate(payload.asOfDate)
    || !String(payload.modelVersion || '')
    || !payload.stocks
    || typeof payload.stocks !== 'object'
    || Array.isArray(payload.stocks)
  ) return null
  const recentRankIc = finite(payload.metrics?.recentRankIc)
  const overallRankIc = finite(payload.metrics?.overallRankIc)
  const requestedWeight = finite(payload.reliabilityWeight) ?? 0
  const active = (
    payload.state === 'ACTIVE'
    && payload.productionEligible === true
    && recentRankIc > 0
    && overallRankIc > 0
  )
  const stocks = new Map()
  for (const [code, value] of Object.entries(payload.stocks)) {
    if (!/^(000|001|002|003|600|601|603|605)\d{3}$/.test(code)) {
      continue
    }
    const normalized = normalizedStock(value)
    if (normalized) stocks.set(code, normalized)
  }
  return {
    schemaVersion: ALPHA158_SNAPSHOT_VERSION,
    state: active ? 'ACTIVE' : 'RESEARCH',
    productionEligible: active,
    asOfDate: compactDate(payload.asOfDate),
    generatedAt: Math.max(0, finite(payload.generatedAt) || 0),
    modelVersion: String(payload.modelVersion),
    reliabilityWeight: active
      ? clamp(requestedWeight, 0, MAX_ALPHA_WEIGHT)
      : 0,
    metrics: {
      recentRankIc,
      overallRankIc,
      recentIc: finite(payload.metrics?.recentIc),
      overallIc: finite(payload.metrics?.overallIc),
    },
    stocks,
  }
}

export function alpha158SignalFor(
  snapshot,
  code,
  {
    expectedDate,
    maximumAgeMs = MAX_SNAPSHOT_AGE_MS,
  } = {},
) {
  const normalizedCode = String(code || '')
  const stock = snapshot?.stocks instanceof Map
    ? snapshot.stocks.get(normalizedCode)
    : null
  const asOf = dateTimestamp(snapshot?.asOfDate)
  const expected = dateTimestamp(expectedDate)
  const ageMs = (
    asOf != null && expected != null
      ? expected - asOf
      : null
  )
  const current = (
    stock
    && snapshot?.state === 'ACTIVE'
    && snapshot?.productionEligible === true
    && snapshot?.reliabilityWeight > 0
    && ageMs != null
    && ageMs >= 0
    && ageMs <= maximumAgeMs
  )
  return {
    schemaVersion: ALPHA158_SIGNAL_VERSION,
    state: current ? 'ACTIVE' : 'UNAVAILABLE',
    reason: current
      ? null
      : !stock
        ? 'SCORE_MISSING'
        : snapshot?.state !== 'ACTIVE'
          ? 'MODEL_NOT_ACTIVE'
          : ageMs == null || ageMs < 0 || ageMs > maximumAgeMs
            ? 'SNAPSHOT_STALE'
            : 'MODEL_NOT_ACTIVE',
    modelVersion: String(snapshot?.modelVersion || '') || null,
    asOfDate: compactDate(snapshot?.asOfDate),
    rawScore: stock?.rawScore ?? null,
    percentile: stock?.percentile ?? null,
    rank: stock?.rank ?? null,
    reliabilityWeight: current
      ? clamp(snapshot.reliabilityWeight, 0, MAX_ALPHA_WEIGHT)
      : 0,
    recentRankIc: finite(snapshot?.metrics?.recentRankIc),
  }
}

export function buildJointOpportunityRanking({
  opportunityScore,
  alpha158Signal,
} = {}) {
  const v3Score = finite(opportunityScore?.rankingScore)
  const alphaPercentile = finite(alpha158Signal?.percentile)
  const alphaWeight = (
    opportunityScore?.state === 'READY'
    && opportunityScore?.usagePolicy === 'DIRECT'
    && alpha158Signal?.state === 'ACTIVE'
    && alphaPercentile != null
  ) ? clamp(
      finite(alpha158Signal.reliabilityWeight) || 0,
      0,
      MAX_ALPHA_WEIGHT,
    ) : 0
  if (v3Score == null) {
    return {
      schemaVersion: JOINT_OPPORTUNITY_RANK_VERSION,
      state: 'UNAVAILABLE',
      reason: 'V3_RANKING_UNAVAILABLE',
      v3Score: null,
      alpha158Score: alphaPercentile,
      alpha158Weight: 0,
      jointScore: null,
    }
  }
  const jointScore = alphaWeight > 0
    ? v3Score * (1 - alphaWeight) + alphaPercentile * alphaWeight
    : v3Score
  return {
    schemaVersion: JOINT_OPPORTUNITY_RANK_VERSION,
    state: alphaWeight > 0 ? 'BLENDED' : 'V3_ONLY',
    reason: alphaWeight > 0
      ? null
      : alpha158Signal?.reason || 'ALPHA158_UNAVAILABLE',
    v3Score: +v3Score.toFixed(6),
    alpha158Score: alphaPercentile == null
      ? null
      : +alphaPercentile.toFixed(6),
    alpha158Weight: +alphaWeight.toFixed(6),
    jointScore: +jointScore.toFixed(6),
    alpha158ModelVersion:
      String(alpha158Signal?.modelVersion || '') || null,
  }
}
