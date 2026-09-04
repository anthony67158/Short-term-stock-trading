export const PRE_CATALYST_EVALUATION_SCHEMA_VERSION =
  'pre-catalyst-evaluation.v1'

function finite(value) {
  if (value == null || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 4) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function normalizedBars(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item) => ({
      date: String(item?.date || ''),
      high: finite(item?.high),
      low: finite(item?.low),
      close: finite(item?.close),
      amount: finite(item?.amount),
    }))
    .filter((item) =>
      /^\d{4}-\d{2}-\d{2}$/.test(item.date)
      && item.high > 0
      && item.low > 0
      && item.close > 0,
    )
    .sort((left, right) => left.date.localeCompare(right.date))
}

function pct(current, base) {
  return current != null && base > 0
    ? (current / base - 1) * 100
    : null
}

function marketReturnFor(marketBars, signalDate, endDate) {
  const rows = normalizedBars(marketBars)
  const base = [...rows]
    .reverse()
    .find((item) => item.date <= signalDate)
  const end = rows.find((item) => item.date === endDate)
  return base && end ? pct(end.close, base.close) : null
}

export function preCatalystScoreBand(value) {
  const score = Math.max(0, Math.min(99, Number(value) || 0))
  const floor = Math.floor(score / 10) * 10
  return `${floor}-${floor + 9}`
}

export function resolvePreCatalystOutcome({
  candidate = {},
  stockBars = [],
  marketBars = [],
} = {}) {
  const context = candidate.evaluationContext || {}
  const signalTradeDate = String(context.signalTradeDate || '')
  const decisionPrice = finite(context.decisionPrice)
  const baselineAmount = finite(context.baselineDailyAmount)
  const future = normalizedBars(stockBars)
    .filter((item) => item.date > signalTradeDate)
    .slice(0, 5)
  const base = {
    schemaVersion: PRE_CATALYST_EVALUATION_SCHEMA_VERSION,
    eventId: String(candidate.event?.eventId || candidate.eventIds?.[0] || ''),
    eventType: String(candidate.event?.eventType || 'UNKNOWN'),
    code: String(candidate.code || ''),
    tradeDate: signalTradeDate,
    scoreBand: preCatalystScoreBand(candidate.activationScore),
    activationScore: round(candidate.activationScore, 1),
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(signalTradeDate)
    || !(decisionPrice > 0)
    || !(baselineAmount > 0)
  ) {
    return {
      ...base,
      mature: false,
      reason: 'DATA_INCOMPLETE',
    }
  }
  if (future.length < 5) {
    return {
      ...base,
      mature: false,
      reason: 'WAITING_FUTURE_BARS',
      observedDays: future.length,
    }
  }
  const activatedBy = (rows) => rows.some((item) =>
    pct(item.high, decisionPrice) >= 3
    && item.amount != null
    && item.amount >= baselineAmount * 1.3
  )
  const end = future[4]
  const return1dPct = pct(future[0].close, decisionPrice)
  const return3dPct = pct(future[2].close, decisionPrice)
  const return5dPct = pct(end.close, decisionPrice)
  const marketReturn5dPct = marketReturnFor(
    marketBars,
    signalTradeDate,
    end.date,
  )
  if (marketReturn5dPct == null) {
    return {
      ...base,
      mature: false,
      reason: 'MARKET_BENCHMARK_INCOMPLETE',
      observedDays: future.length,
    }
  }
  const activated1d = activatedBy(future.slice(0, 1))
  const activated3d = activatedBy(future.slice(0, 3))
  const excessReturn5dPct = return5dPct - marketReturn5dPct
  const maxReturn5dPct = Math.max(
    ...future.map((item) => pct(item.high, decisionPrice)),
  )
  const maxAdverse5dPct = Math.min(
    ...future.map((item) => pct(item.low, decisionPrice)),
  )
  return {
    ...base,
    mature: true,
    reason: '',
    activated1d,
    activated3d,
    return1dPct: round(return1dPct),
    return3dPct: round(return3dPct),
    return5dPct: round(return5dPct),
    marketReturn5dPct: round(marketReturn5dPct),
    excessReturn5dPct: round(excessReturn5dPct),
    maxReturn5dPct: round(maxReturn5dPct),
    maxAdverse5dPct: round(maxAdverse5dPct),
    outcome: activated3d
      ? excessReturn5dPct > 0
        ? 'ACTIVATED_WIN'
        : 'ACTIVATED_LOSS'
      : 'NOT_ACTIVATED',
    maturedAt: Date.now(),
  }
}

function ratio(values, predicate) {
  if (!values.length) return null
  return values.filter(predicate).length / values.length
}

function average(values = []) {
  const valid = values.filter((value) => finite(value) != null)
  if (!valid.length) return null
  return valid.reduce((sum, value) => sum + Number(value), 0)
    / valid.length
}

function wilsonLower(successes, total, z = 1.645) {
  if (!(total > 0)) return null
  const p = successes / total
  const denominator = 1 + z * z / total
  const center = p + z * z / (2 * total)
  const margin = z * Math.sqrt(
    (p * (1 - p) + z * z / (4 * total)) / total,
  )
  return Math.max(0, (center - margin) / denominator)
}

function metrics(rows) {
  const activated = rows.filter((item) => item.activated3d)
  const wins = activated.filter((item) => item.excessReturn5dPct > 0)
  return {
    sampleCount: rows.length,
    activatedCount: activated.length,
    pActivation1d: round(ratio(rows, (item) => item.activated1d)),
    pActivation3d: round(ratio(rows, (item) => item.activated3d)),
    pOutperform5d: round(
      ratio(rows, (item) => item.excessReturn5dPct > 0),
    ),
    pWinGivenActivation: round(
      ratio(activated, (item) => item.excessReturn5dPct > 0),
    ),
    winLowerBound: round(wilsonLower(wins.length, activated.length)),
    averageExcessReturn5dPct: round(
      average(rows.map((item) => item.excessReturn5dPct)),
    ),
    averageMaxAdverse5dPct: round(
      average(rows.map((item) => item.maxAdverse5dPct)),
    ),
  }
}

export function buildPreCatalystEvaluation(
  outcomes = [],
  {
    minimumSamples = 100,
    minimumBucketSamples = 30,
  } = {},
) {
  const mature = (Array.isArray(outcomes) ? outcomes : [])
    .filter((item) => item?.mature === true)
  const overall = metrics(mature)
  const grouped = new Map()
  for (const outcome of mature) {
    const key = `${outcome.eventType}:${outcome.scoreBand}`
    const rows = grouped.get(key) || []
    rows.push(outcome)
    grouped.set(key, rows)
  }
  const buckets = Object.fromEntries(
    [...grouped.entries()].map(([key, rows]) => [
      key,
      {
        ...metrics(rows),
        ready: rows.length >= minimumBucketSamples,
      },
    ]),
  )
  const ready = (
    mature.length >= minimumSamples
    && Number(overall.pActivation3d) >= 0.2
    && Number(overall.winLowerBound) >= 0.5
    && Number(overall.averageExcessReturn5dPct) > 0
  )
  return {
    schemaVersion: PRE_CATALYST_EVALUATION_SCHEMA_VERSION,
    generatedAt: Date.now(),
    state: ready ? 'READY' : 'CALIBRATING',
    probabilitiesPublished: ready,
    minimumSamples,
    minimumBucketSamples,
    ...overall,
    buckets,
  }
}

export function hydratePreCatalystForecasts(
  snapshot,
  evaluation,
) {
  if (!snapshot || !Array.isArray(snapshot.candidates)) return snapshot
  if (
    evaluation?.state !== 'READY'
    || evaluation?.probabilitiesPublished !== true
  ) return snapshot
  return {
    ...snapshot,
    model: {
      ...(snapshot.model || {}),
      state: 'READY',
      sampleCount: Number(evaluation.sampleCount) || 0,
      probabilitiesPublished: true,
    },
    candidates: snapshot.candidates.map((candidate) => {
      const key =
        `${candidate.event?.eventType || 'UNKNOWN'}:`
        + preCatalystScoreBand(candidate.activationScore)
      const bucket = evaluation.buckets?.[key]
      const bucketReady = bucket?.ready === true
        || Number(bucket?.sampleCount) >= Math.max(
          1,
          Number(evaluation.minimumBucketSamples) || 30,
        )
      if (!bucketReady) return candidate
      return {
        ...candidate,
        forecast: {
          state: 'READY',
          pActivation1d: bucket.pActivation1d,
          pActivation3d: bucket.pActivation3d,
          pOutperform5d: bucket.pOutperform5d,
          sampleCount: bucket.sampleCount,
        },
      }
    }),
  }
}
