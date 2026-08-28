export const SECTOR_FORECAST_SCHEMA_VERSION = 'sector-forecast.v1'

const PHASES = new Set([
  'ACCUMULATION',
  'STARTUP',
  'ACCELERATION',
  'DIVERGENCE',
  'RETREAT',
])

const ACTIONS = new Set([
  'LAYOUT',
  'WAIT_PULLBACK',
  'WATCH_ONLY',
  'AVOID',
])

const TIMING_LANES = new Set([
  'EARLY_LAYOUT',
  'CONFIRMING',
  'EXTENDED_WATCH',
  'WEAK',
])

const finite = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const clamp = (value, low = 0, high = 100) =>
  Math.max(low, Math.min(high, finite(value, low)))

const rounded = (value, digits = 2) => {
  const number = finite(value)
  return number === null ? null : +number.toFixed(digits)
}

const mean = (values = []) => {
  const valid = values.map((value) => finite(value)).filter((value) => value !== null)
  return valid.length
    ? valid.reduce((sum, value) => sum + value, 0) / valid.length
    : null
}

const positivePct = (values = []) => {
  const valid = values.map((value) => finite(value)).filter((value) => value !== null)
  return valid.length
    ? valid.filter((value) => value > 0).length / valid.length * 100
    : 0
}

function linearSlope(values = []) {
  const valid = values.map((value) => finite(value))
  if (valid.length < 2 || valid.some((value) => value === null)) return 0
  const xMean = (valid.length - 1) / 2
  const yMean = mean(valid)
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < valid.length; index++) {
    numerator += (index - xMean) * (valid[index] - yMean)
    denominator += (index - xMean) ** 2
  }
  return denominator > 0 ? numerator / denominator : 0
}

function consecutiveDirection(values = []) {
  const valid = values.map((value) => finite(value)).filter((value) => value !== null)
  if (!valid.length) return 0
  const direction = Math.sign(valid.at(-1))
  if (!direction) return 0
  let streak = 0
  for (let index = valid.length - 1; index >= 0; index--) {
    if (Math.sign(valid[index]) !== direction) break
    streak += direction
  }
  return streak
}

function returnPct(start, end) {
  const from = finite(start)
  const to = finite(end)
  return from !== null && to !== null && from > 0
    ? (to / from - 1) * 100
    : null
}

function safeText(value, limit = 240) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function safeTextList(value, limit = 6) {
  const list = Array.isArray(value) ? value : []
  return list.map((item) => safeText(item, 180)).filter(Boolean).slice(0, limit)
}

function flowAcceleration(ratios) {
  const recent = ratios.slice(-3)
  const prior = ratios.slice(-6, -3)
  const recentMean = mean(recent)
  const priorMean = mean(prior)
  if (recentMean === null || priorMean === null) return 50
  return clamp(50 + (recentMean - priorMean) * 8)
}

function pricePosition(history) {
  const closes = history
    .map((item) => finite(item.close))
    .filter((value) => value !== null && value > 0)
  if (closes.length < 2) return 50
  const low = Math.min(...closes)
  const high = Math.max(...closes)
  return high > low ? (closes.at(-1) - low) / (high - low) * 100 : 50
}

function priceFundRelation(latest) {
  const ratio = finite(latest?.mainRatio)
  const pct = finite(latest?.pct)
  if (ratio === null || pct === null) return 'UNKNOWN'
  if (ratio > 0 && pct > 0) return 'RESONANCE'
  if (ratio > 0 && pct <= 0) return 'ACCUMULATION'
  if (ratio < 0 && pct >= 0) return 'DISTRIBUTION'
  if (ratio < 0 && pct < 0) return 'WEAKENING'
  return 'NEUTRAL'
}

function crowdingPenaltyOf({
  pctPercentile,
  currentPct,
  limitUpPct,
  pricePositionPct,
  momentum5Pct,
}) {
  let penalty = 0
  if (currentPct >= 3 && pctPercentile >= 0.9) penalty += 14
  if (currentPct >= 4.5 && pctPercentile >= 0.97) penalty += 8
  if (currentPct >= 7) penalty += 10
  else if (currentPct >= 5) penalty += 6
  if (limitUpPct >= 25) penalty += 12
  else if (limitUpPct >= 12) penalty += 6
  if (pricePositionPct >= 90 && finite(momentum5Pct, 0) >= 5) penalty += 8
  return Math.min(45, penalty)
}

function divergencePenaltyOf({
  relation,
  currentPct,
  latestMainRatio,
  inflowBreadthPct,
  upBreadthPct,
}) {
  let penalty = 0
  if (relation === 'DISTRIBUTION') penalty += 22
  if (currentPct > 0 && latestMainRatio < 0) penalty += 10
  if (upBreadthPct >= 50 && inflowBreadthPct < 30) penalty += 10
  return Math.min(40, penalty)
}

function layoutTimingOf({
  currentPct,
  momentum5Pct,
  pricePositionPct,
  limitUpPct,
  relation,
  scores,
  penalties,
}) {
  const dailyMove = finite(currentPct, 0)
  const momentum5 = finite(momentum5Pct, 0)
  const position = finite(pricePositionPct, 50)
  const limitBreadth = finite(limitUpPct, 0)
  const dailyTiming = dailyMove < -2.5
    ? 20
    : dailyMove <= 2.5
      ? clamp(100 - Math.abs(dailyMove - 0.8) * 10)
      : dailyMove <= 5
        ? clamp(72 - (dailyMove - 2.5) * 15)
        : 5
  const momentumTiming = momentum5 < -5
    ? 15
    : momentum5 <= 1
      ? 78
      : momentum5 <= 6
        ? clamp(100 - (momentum5 - 3) * 7)
        : momentum5 <= 10
          ? clamp(55 - (momentum5 - 6) * 10)
          : 5
  const positionTiming = position <= 30
    ? 72
    : position <= 70
      ? 100
      : position <= 85
        ? 70
        : position <= 92 ? 35 : 10
  const breadthTiming = limitBreadth <= 3
    ? 100
    : limitBreadth <= 8
      ? 76
      : limitBreadth <= 15 ? 38 : 5
  const priceTiming = (
    dailyTiming * 0.38
    + momentumTiming * 0.32
    + positionTiming * 0.2
    + breadthTiming * 0.1
  )
  const capitalSignal = (
    scores.flowPersistence * 0.34
    + scores.flowAcceleration * 0.28
    + scores.fundStrength * 0.28
    + scores.priceFund * 0.1
  )
  const layoutScore = clamp(
    capitalSignal * 0.62
      + priceTiming * 0.38
      - finite(penalties.divergence, 0) * 0.7
      - finite(penalties.missingData, 0) * 0.3,
  )
  const extended = (
    dailyMove >= 6.5
    || momentum5 >= 12
    || (position >= 92 && momentum5 >= 8)
    || limitBreadth >= 15
    || finite(penalties.crowding, 0) >= 24
  )
  let lane = 'WEAK'
  if (extended) {
    lane = 'EXTENDED_WATCH'
  } else if (
    ['ACCUMULATION', 'RESONANCE'].includes(relation)
    && capitalSignal >= 50
    && dailyMove <= 2.5
    && momentum5 < 6
    && layoutScore >= 58
  ) {
    lane = 'EARLY_LAYOUT'
  } else if (
    relation === 'RESONANCE'
    && dailyMove < 5
    && momentum5 < 10
    && layoutScore >= 52
  ) {
    lane = 'CONFIRMING'
  }
  return {
    lane,
    layoutScore: rounded(layoutScore, 1),
    capitalSignal: rounded(capitalSignal, 1),
    priceTiming: rounded(priceTiming, 1),
    chaseRisk: extended,
  }
}

export function buildSectorForecastFeatures({
  sector = {},
  history = [],
  sectorPercentiles = {},
  breadth = {},
  leadership = {},
  market = {},
} = {}) {
  const ordered = (Array.isArray(history) ? history : [])
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.date || '')))
    .slice()
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
    .slice(-30)
  const latest = ordered.at(-1) || {}
  const ratios = ordered.map((item) => finite(item.mainRatio)).filter((value) => value !== null)
  const amounts = ordered.map((item) => finite(item.mainInflow)).filter((value) => value !== null)
  const closes = ordered.map((item) => finite(item.close)).filter((value) => value !== null)
  const currentPct = finite(sector.pct, finite(latest.pct, 0))
  const latestMainRatio = finite(sector.mainRatio, finite(latest.mainRatio, 0))
  const flowStreak = consecutiveDirection(ratios)
  const flowPersistence = clamp(
    positivePct(ratios.slice(-10)) * 0.72
      + clamp(Math.max(0, flowStreak) / 5 * 100) * 0.28,
  )
  const amountSlope = linearSlope(amounts.slice(-5))
  const amountScale = Math.max(
    Math.abs(mean(amounts.slice(-5)) || 0),
    1,
  )
  const ratioSlope = linearSlope(ratios.slice(-5))
  const flowAccelerationScore = clamp(
    flowAcceleration(ratios) * 0.65
      + clamp(50 + ratioSlope * 12) * 0.2
      + clamp(50 + amountSlope / amountScale * 100) * 0.15,
  )
  const position = pricePosition(ordered)
  const momentum5 = closes.length >= 6
    ? returnPct(closes.at(-6), closes.at(-1))
    : returnPct(closes[0], closes.at(-1))
  const relation = priceFundRelation({
    mainRatio: latestMainRatio,
    pct: currentPct,
  })
  const upBreadthPct = clamp(breadth.upPct)
  const inflowBreadthPct = clamp(breadth.inflowPct)
  const limitUpPct = clamp(breadth.limitUpPct)
  const pctPercentile = clamp(sectorPercentiles.pct, 0, 1)
  const crowding = crowdingPenaltyOf({
    pctPercentile,
    currentPct,
    limitUpPct,
    pricePositionPct: position,
    momentum5Pct: momentum5,
  })
  const divergence = divergencePenaltyOf({
    relation,
    currentPct,
    latestMainRatio,
    inflowBreadthPct,
    upBreadthPct,
  })
  const scores = {
    flowPersistence: rounded(flowPersistence, 1),
    flowAcceleration: rounded(flowAccelerationScore, 1),
    fundStrength: rounded((
      clamp(sectorPercentiles.mainInflow, 0, 1) * 0.6
        + clamp(sectorPercentiles.mainRatio, 0, 1) * 0.4
    ) * 100, 1),
    priceFund: {
      RESONANCE: 82,
      ACCUMULATION: 92,
      DISTRIBUTION: 20,
      WEAKENING: 10,
      NEUTRAL: 50,
      UNKNOWN: 35,
    }[relation],
    breadth: rounded(upBreadthPct * 0.45 + inflowBreadthPct * 0.55, 1),
    leadership: rounded(clamp(leadership.strength)),
    liquidity: rounded(clamp(sectorPercentiles.amount, 0, 1) * 100, 1),
    marketFit: rounded(clamp(market.score, 0, 100), 1),
  }
  const penalties = {
    crowding,
    divergence,
    missingData: ordered.length < 5 ? 15 : 0,
  }
  const timing = layoutTimingOf({
    currentPct,
    momentum5Pct: momentum5,
    pricePositionPct: position,
    limitUpPct,
    relation,
    scores,
    penalties,
  })
  return {
    schemaVersion: SECTOR_FORECAST_SCHEMA_VERSION,
    code: String(sector.code || ''),
    name: safeText(sector.name, 60),
    dataAsOf: String(latest.date || ''),
    sampleDays: ordered.length,
    raw: {
      currentPct: rounded(currentPct),
      mainInflow: finite(sector.mainInflow, finite(latest.mainInflow)),
      mainRatio: rounded(latestMainRatio),
      amount: finite(sector.amount),
      leadCode: /^\d{6}$/.test(String(sector.leadCode || ''))
        ? String(sector.leadCode)
        : null,
      leadName: safeText(sector.leadName, 40) || null,
      leadPct: rounded(finite(sector.leadPct)),
      momentum5Pct: rounded(momentum5),
      pricePositionPct: rounded(position),
      flowStreak,
    },
    scores: {
      ...scores,
      earlyTiming: timing.priceTiming,
    },
    relation,
    breadth: {
      upPct: rounded(upBreadthPct),
      inflowPct: rounded(inflowBreadthPct),
      limitUpPct: rounded(limitUpPct),
      memberCount: Math.max(0, Math.trunc(finite(breadth.memberCount, 0))),
    },
    leadership: {
      strength: rounded(clamp(leadership.strength)),
      coreHealthy: leadership.coreHealthy === true,
    },
    market: {
      score: rounded(clamp(market.score)),
      riskState: ['RISK_ON', 'NEUTRAL', 'RISK_OFF'].includes(market.riskState)
        ? market.riskState
        : 'NEUTRAL',
    },
    percentiles: {
      mainInflow: rounded(clamp(sectorPercentiles.mainInflow, 0, 1) * 100),
      mainRatio: rounded(clamp(sectorPercentiles.mainRatio, 0, 1) * 100),
      pct: rounded(pctPercentile * 100),
      leadPct: rounded(clamp(sectorPercentiles.leadPct, 0, 1) * 100),
    },
    penalties,
    timing,
  }
}

function lifecycleOf(features) {
  const score = features.scores
  const penalties = features.penalties
  if (
    penalties.divergence >= 20
    || features.relation === 'DISTRIBUTION'
  ) return 'DIVERGENCE'
  if (
    score.flowPersistence < 30
    && score.fundStrength < 35
  ) return 'RETREAT'
  if (features.timing?.lane === 'EXTENDED_WATCH') return 'ACCELERATION'
  if (features.timing?.lane === 'EARLY_LAYOUT') return 'ACCUMULATION'
  if (features.timing?.lane === 'CONFIRMING') return 'STARTUP'
  if (
    score.flowPersistence >= 60
    && score.flowAcceleration >= 55
    && Math.abs(finite(features.raw.currentPct, 0)) < 2
    && finite(features.raw.momentum5Pct, 0) < 5
  ) return 'ACCUMULATION'
  if (
    score.fundStrength >= 55
    && score.breadth >= 50
    && score.leadership >= 55
  ) return 'STARTUP'
  return score.fundStrength < 40 ? 'RETREAT' : 'DIVERGENCE'
}

function actionabilityOf(
  phase,
  nextScore,
  weekScore,
  penalties,
  timing = {},
) {
  if (phase === 'RETREAT') return 'AVOID'
  if (
    phase === 'ACCELERATION'
    || timing.lane === 'EXTENDED_WATCH'
  ) return 'WATCH_ONLY'
  if (phase === 'DIVERGENCE') {
    return Math.max(nextScore, weekScore) >= 55
      ? 'WAIT_PULLBACK'
      : 'AVOID'
  }
  if (
    penalties.crowding >= 20
    || penalties.divergence > 0
    || penalties.missingData > 0
  ) return 'WAIT_PULLBACK'
  if (
    timing.lane === 'EARLY_LAYOUT'
    && finite(timing.layoutScore, 0) >= 58
  ) return 'LAYOUT'
  return Math.max(nextScore, weekScore) >= 62
    ? 'LAYOUT'
    : 'WAIT_PULLBACK'
}

function reasonsFor(features, phase) {
  const reasons = []
  if (features.timing?.lane === 'EARLY_LAYOUT') {
    reasons.push('资金先行，价格尚未充分启动')
  }
  if (features.timing?.lane === 'CONFIRMING') {
    reasons.push('趋势刚启动，等待个股低风险介入')
  }
  if (features.scores.flowPersistence >= 60) {
    reasons.push(`近10日资金持续性${features.scores.flowPersistence}分`)
  }
  if (features.scores.flowAcceleration >= 55) {
    reasons.push(`资金流入加速度${features.scores.flowAcceleration}分`)
  }
  if (features.relation === 'ACCUMULATION') reasons.push('价格未涨而资金逆势承接')
  if (features.relation === 'RESONANCE') reasons.push('价格与资金共振')
  if (features.scores.breadth >= 55) reasons.push(`成分股扩散${features.scores.breadth}分`)
  if (features.scores.leadership >= 60) reasons.push(`龙头中军结构${features.scores.leadership}分`)
  if (!reasons.length) reasons.push(`板块处于${phase}阶段`)
  return reasons.slice(0, 5)
}

function risksFor(features, phase) {
  const risks = []
  if (features.penalties.crowding > 0) {
    risks.push(
      features.breadth.limitUpPct >= 12
        ? '板块涨停扩散且位置过热，追高可买性差'
        : '当日涨幅或价格位置过热，存在追高风险',
    )
  }
  if (features.penalties.divergence > 0) risks.push('价格与资金背离，板块处于分歧')
  if (features.market.riskState === 'RISK_OFF') risks.push('市场风险偏好偏弱')
  if (features.penalties.missingData > 0) risks.push('历史样本不足，置信度降级')
  if (phase === 'RETREAT') risks.push('资金与结构同步走弱')
  return [...new Set(risks)].slice(0, 5)
}

export function scoreSectorForecast(features = {}) {
  const score = features.scores || {}
  const penalties = features.penalties || {}
  const weighted = (weights) => Object.entries(weights)
    .reduce((sum, [key, weight]) => sum + clamp(score[key]) * weight, 0)
  const nextBase = weighted({
    flowPersistence: 0.2,
    flowAcceleration: 0.14,
    fundStrength: 0.15,
    priceFund: 0.1,
    earlyTiming: 0.2,
    breadth: 0.08,
    leadership: 0.05,
    liquidity: 0.04,
    marketFit: 0.04,
  })
  const weekBase = weighted({
    flowPersistence: 0.24,
    flowAcceleration: 0.14,
    fundStrength: 0.13,
    priceFund: 0.1,
    earlyTiming: 0.18,
    breadth: 0.07,
    leadership: 0.04,
    liquidity: 0.04,
    marketFit: 0.06,
  })
  const totalPenalty = clamp(
    finite(penalties.crowding, 0)
      + finite(penalties.divergence, 0)
      + finite(penalties.missingData, 0),
    0,
    80,
  )
  const nextScore = rounded(clamp(nextBase - totalPenalty), 1)
  const weekScore = rounded(clamp(weekBase - totalPenalty * 0.85), 1)
  const phase = lifecycleOf(features)
  const actionability = actionabilityOf(
    phase,
    nextScore,
    weekScore,
    penalties,
    features.timing,
  )
  return {
    schemaVersion: SECTOR_FORECAST_SCHEMA_VERSION,
    code: String(features.code || ''),
    name: safeText(features.name, 60),
    dataAsOf: features.dataAsOf || '',
    phase: PHASES.has(phase) ? phase : 'DIVERGENCE',
    actionability: ACTIONS.has(actionability)
      ? actionability
      : 'WATCH_ONLY',
    forecast: {
      layout: {
        score: rounded(finite(features.timing?.layoutScore, 0), 1),
      },
      next: { score: nextScore, probability: null },
      week: {
        score: weekScore,
        probability: null,
        drawdownEstimate: null,
      },
    },
    factors: {
      ...features.scores,
      relation: features.relation,
      flowStreak: finite(features.raw?.flowStreak, 0),
      currentPct: finite(features.raw?.currentPct),
      momentum5Pct: finite(features.raw?.momentum5Pct),
      upBreadthPct: finite(features.breadth?.upPct),
      inflowBreadthPct: finite(features.breadth?.inflowPct),
      limitUpPct: finite(features.breadth?.limitUpPct),
    },
    penalties: {
      crowding: finite(penalties.crowding, 0),
      divergence: finite(penalties.divergence, 0),
      missingData: finite(penalties.missingData, 0),
      total: totalPenalty,
    },
    timing: {
      lane: TIMING_LANES.has(features.timing?.lane)
        ? features.timing.lane
        : 'WEAK',
      layoutScore: rounded(finite(features.timing?.layoutScore, 0), 1),
      capitalSignal: rounded(
        finite(features.timing?.capitalSignal, 0),
        1,
      ),
      priceTiming: rounded(finite(features.timing?.priceTiming, 0), 1),
      chaseRisk: features.timing?.chaseRisk === true,
    },
    reasons: reasonsFor(features, phase),
    risks: risksFor(features, phase),
    source: {
      featureSampleDays: finite(features.sampleDays, 0),
      leadCode: features.raw?.leadCode || null,
      leadName: features.raw?.leadName || null,
      marketRiskState: features.market?.riskState || 'NEUTRAL',
    },
    explanation: {
      whyNow: '',
      catalysts: [],
      risks: [],
      counterCase: '',
      invalidation: '',
      evidence: [],
    },
    stocks: [],
  }
}

export function rankSectorForecasts(items = [], horizon = 'next') {
  const key = ['week', 'layout'].includes(horizon)
    ? horizon
    : 'next'
  const timingOrder = {
    EARLY_LAYOUT: 0,
    CONFIRMING: 1,
    EXTENDED_WATCH: 2,
    WEAK: 3,
  }
  return (Array.isArray(items) ? items : [])
    .filter((item) =>
      item?.schemaVersion === SECTOR_FORECAST_SCHEMA_VERSION
      && /^BK\d+$/.test(String(item.code || ''))
    )
    .slice()
    .sort((left, right) => {
      if (key === 'layout') {
        const laneDelta = (
          timingOrder[left.timing?.lane] ?? 99
        ) - (
          timingOrder[right.timing?.lane] ?? 99
        )
        if (laneDelta) return laneDelta
      }
      return (
        finite(right.forecast?.[key]?.score, -1)
          - finite(left.forecast?.[key]?.score, -1)
        || String(left.code).localeCompare(String(right.code))
      )
    })
    .map((item, index) => ({ ...item, rank: index + 1 }))
}

export function mergeSectorForecastExplanation(forecast, raw = {}) {
  if (!forecast || typeof forecast !== 'object') return forecast
  if (raw && raw.code && String(raw.code) !== String(forecast.code)) {
    return forecast
  }
  return {
    ...forecast,
    explanation: {
      whyNow: safeText(raw?.whyNow, 500),
      catalysts: safeTextList(raw?.catalysts),
      risks: safeTextList(raw?.risks),
      counterCase: safeText(raw?.counterCase, 320),
      invalidation: safeText(raw?.invalidation, 320),
      evidence: (Array.isArray(raw?.evidence) ? raw.evidence : [])
        .map((item) => ({
          title: safeText(item?.title, 160),
          source: safeText(item?.source, 80),
          date: safeText(item?.date, 30),
          pendingVerification: true,
        }))
        .filter((item) => item.title)
        .slice(0, 8),
    },
  }
}

function completeOutcomes(rows, field) {
  return rows.filter((item) => finite(item[field]) !== null)
}

function topSet(rows, field) {
  const complete = completeOutcomes(rows, field)
    .slice()
    .sort((left, right) => finite(right[field]) - finite(left[field]))
  const count = complete.length ? Math.max(1, Math.ceil(complete.length * 0.2)) : 0
  return new Set(complete.slice(0, count).map((item) => item.code))
}

export function labelSectorForecastOutcomes(prediction = {}, priceMap = {}) {
  const signalDate = String(prediction.signalDate || '')
  const rows = (Array.isArray(prediction.sectors) ? prediction.sectors : [])
    .map((sector) => {
      const prices = (Array.isArray(priceMap?.[sector.code])
        ? priceMap[sector.code]
        : [])
        .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.date || '')))
        .slice()
        .sort((left, right) => String(left.date).localeCompare(String(right.date)))
      const signal = prices.find((item) => item.date === signalDate)
      const future = prices.filter((item) => item.date > signalDate)
      const next = future[0]
      const fifth = future[4]
      const nextReturn = signal && next
        ? returnPct(signal.close, next.close)
        : null
      const weekReturn = next && fifth
        ? returnPct(next.open, fifth.close)
        : null
      const window = next && fifth ? future.slice(0, 5) : []
      const lows = window
        .map((item) => finite(item.low))
        .filter((value) => value !== null)
      const drawdown = next && lows.length
        ? returnPct(next.open, Math.min(...lows))
        : null
      return {
        signalDate,
        code: String(sector.code || ''),
        rank: Math.max(1, Math.trunc(finite(sector.rank, 999))),
        nextDate: next?.date || null,
        weekEndDate: fifth?.date || null,
        nextReturnPct: rounded(nextReturn),
        weekReturnPct: rounded(weekReturn),
        weekMaxDrawdownPct: rounded(drawdown),
        nextTopQuintile: null,
        weekTopQuintile: null,
        nextExcessPct: null,
        weekExcessPct: null,
      }
    })
  const nextComplete = completeOutcomes(rows, 'nextReturnPct')
  const weekComplete = completeOutcomes(rows, 'weekReturnPct')
  const nextMean = mean(nextComplete.map((item) => item.nextReturnPct))
  const weekMean = mean(weekComplete.map((item) => item.weekReturnPct))
  const nextTop = topSet(rows, 'nextReturnPct')
  const weekTop = topSet(rows, 'weekReturnPct')
  return rows.map((item) => ({
    ...item,
    nextTopQuintile: item.nextReturnPct === null
      ? null
      : nextTop.has(item.code),
    weekTopQuintile: item.weekReturnPct === null
      ? null
      : weekTop.has(item.code),
    nextExcessPct: item.nextReturnPct === null || nextMean === null
      ? null
      : rounded(item.nextReturnPct - nextMean),
    weekExcessPct: item.weekReturnPct === null || weekMean === null
      ? null
      : rounded(item.weekReturnPct - weekMean),
  }))
}

function dcg(rows, labelField, k) {
  return rows.slice(0, k).reduce((sum, item, index) =>
    sum + (item[labelField] === true ? 1 : 0) / Math.log2(index + 2), 0)
}

function ndcg(rows, labelField, k) {
  const ordered = rows.slice().sort((left, right) =>
    Number(right[labelField] === true) - Number(left[labelField] === true)
  )
  const ideal = dcg(ordered, labelField, k)
  return ideal > 0 ? dcg(rows, labelField, k) / ideal : 0
}

export function summarizeSectorForecastOutcomes(outcomes = [], { topK = 5 } = {}) {
  const rows = (Array.isArray(outcomes) ? outcomes : [])
    .slice()
    .sort((left, right) => finite(left.rank, 999) - finite(right.rank, 999))
  const k = Math.max(1, Math.min(rows.length || 1, Math.trunc(finite(topK, 5))))
  const top = rows.slice(0, k)
  const rate = (field) => {
    const complete = top.filter((item) => item[field] !== null)
    return complete.length
      ? rounded(complete.filter((item) => item[field] === true).length / complete.length * 100)
      : null
  }
  return {
    sampleSectors: rows.length,
    topK: k,
    topNextHitRatePct: rate('nextTopQuintile'),
    topWeekHitRatePct: rate('weekTopQuintile'),
    topNextAverageExcessPct: rounded(mean(top.map((item) => item.nextExcessPct))),
    topWeekAverageExcessPct: rounded(mean(top.map((item) => item.weekExcessPct))),
    topWeekMaxDrawdownPct: rounded(
      Math.min(
        ...top.map((item) => finite(item.weekMaxDrawdownPct))
          .filter((value) => value !== null),
      ),
    ),
    ndcgAtK: {
      next: rounded(ndcg(rows, 'nextTopQuintile', k), 4),
      week: rounded(ndcg(rows, 'weekTopQuintile', k), 4),
    },
  }
}
