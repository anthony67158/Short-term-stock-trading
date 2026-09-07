import {
  A_SHARE_STANDARD_FEE_POLICY,
  executionPrice,
  tradeFees,
} from './ashareStrategyExecution.js'

export const ADVICE_OUTCOME_POLICY_VERSION = 3

export const ADVICE_ACTION_LABELS = {
  bull: '买入/加仓',
  hold: '继续持有',
  bear: '减仓/清仓',
  wait: '观望/等待',
  other: '其他',
}

export function adviceActionKind(action) {
  const text = String(action || '')
  const hold = /持有|持股|继续持|按兵不动|拿住|捂|不动/.test(text)
    && !/加|减|清/.test(text)
  if (hold) return 'hold'
  if (/买|加|正T|立即|回调再买|抄底|吸|上车|建仓|补仓/.test(text)) {
    return 'bull'
  }
  if (/减|清|反T|止损|离场/.test(text)) return 'bear'
  if (/观望|不建议|回避|谨慎|等待/.test(text)) return 'wait'
  return 'other'
}

export function effectiveAdviceActionKind(record = {}) {
  const planned = String(record.decisionPlanAction || '').toUpperCase()
  const actionability = String(
    record.decisionPlanActionability || '',
  ).toUpperCase()
  if (['BUY', 'ADD', 'T_BUY_FIRST'].includes(planned)) {
    return actionability === 'READY' ? 'bull' : 'wait'
  }
  if (['REDUCE', 'EXIT', 'T_SELL_FIRST'].includes(planned)) {
    return 'bear'
  }
  if (['WATCH'].includes(planned)) return 'wait'
  if (['HOLD'].includes(planned)) return 'hold'
  return adviceActionKind(record.action)
}

export function adviceExpectancySnapshot(advice = {}) {
  const plan = advice?.decisionPlan
  const value = plan?.risk?.tradeExpectancy
  if (value?.schemaVersion !== 'trade-expectancy.v1') return null
  return {
    schemaVersion: value.schemaVersion,
    state: String(value.state || ''),
    source: String(value.source || ''),
    modelVersion: String(value.modelVersion || ''),
    pFill: Number.isFinite(Number(value.probability?.pFill))
      ? Number(value.probability.pFill)
      : null,
    pWinGivenFill:
      Number.isFinite(Number(value.probability?.pWinGivenFill))
        ? Number(value.probability.pWinGivenFill)
        : null,
    sampleCount:
      Number.isFinite(Number(value.probability?.sampleCount))
        ? Number(value.probability.sampleCount)
        : null,
    expectedNetR:
      Number.isFinite(Number(value.expectancy?.expectedNetRGivenFill))
        ? Number(value.expectancy.expectedNetRGivenFill)
        : null,
    netRLowerBound:
      Number.isFinite(Number(value.expectancy?.netRLowerBound))
        ? Number(value.expectancy.netRLowerBound)
        : null,
    breakEvenWinProbability:
      Number.isFinite(Number(value.plan?.breakEvenWinProbability))
        ? Number(value.plan.breakEvenWinProbability)
        : null,
    plannedNetRiskReward:
      Number.isFinite(Number(value.plan?.netRiskReward))
        ? Number(value.plan.netRiskReward)
        : null,
    plannedLossAmount:
      Number.isFinite(Number(value.plan?.lossAmount))
        ? Number(value.plan.lossAmount)
        : null,
    stressLossAmount:
      Number.isFinite(Number(value.stress?.lossAmount))
        ? Number(value.stress.lossAmount)
        : null,
  }
}

function sellNet(price, shares = 100) {
  const fillPrice = executionPrice(price, 'SELL', 5)
  const gross = fillPrice * shares
  const fees = tradeFees(
    'SELL',
    gross,
    A_SHARE_STANDARD_FEE_POLICY,
  )
  return gross - fees.total
}

export function resolveBullAdviceOutcome(record = {}, candles = []) {
  const entry = Number(record.entryPrice || record.priceAtAdvice)
  const stop = Number(record.stop)
  const target = Number(record.target)
  const rows = Array.isArray(candles) ? candles : []
  if (!(entry > 0) || rows.length < 3) return null

  const entryFill = executionPrice(entry, 'BUY', 5)
  const entryGross = entryFill * 100
  const entryFees = tradeFees(
    'BUY',
    entryGross,
    A_SHARE_STANDARD_FEE_POLICY,
  )
  const entryCost = entryGross + entryFees.total
  const stopNet = stop > 0 ? sellNet(stop) : null
  const initialRisk = stopNet != null
    ? entryCost - stopNet
    : null
  let outcome = 'TIME_EXIT'
  let exitPrice = Number(rows[2]?.close)
  let note = '3个交易日届满，按收盘退出'

  for (const candle of rows.slice(0, 3)) {
    const low = Number(candle?.low ?? candle?.close)
    const high = Number(candle?.high ?? candle?.close)
    const open = Number(candle?.open ?? candle?.close)
    const stopHit = stop > 0 && low <= stop
    const targetHit = target > 0 && high >= target
    if (stopHit) {
      outcome = targetHit ? 'AMBIGUOUS_STOP_FIRST' : 'STOP_LOSS'
      exitPrice = Math.min(
        Number.isFinite(open) && open > 0 ? open : stop,
        stop,
      )
      note = targetHit
        ? '同一日同时触及止损和目标，按保守路径先止损'
        : `先触及止损${stop}`
      break
    }
    if (targetHit) {
      outcome = 'TAKE_PROFIT'
      exitPrice = target
      note = `先触及目标${target}`
      break
    }
  }

  if (!(exitPrice > 0)) return null
  const netPnl = sellNet(exitPrice) - entryCost
  const realizedNetR = initialRisk > 0
    ? netPnl / initialRisk
    : null
  return {
    outcome,
    exitPrice: +exitPrice.toFixed(3),
    netPnl: +netPnl.toFixed(2),
    realizedNetR:
      realizedNetR == null ? null : +realizedNetR.toFixed(3),
    hit: netPnl > 0,
    note,
  }
}

export function isAdviceOutcomeCurrent(record) {
  return !!record
    && record.verified === true
    && record.hit != null
    && Number(record.outcomePolicyVersion) === ADVICE_OUTCOME_POLICY_VERSION
}

export function adviceNeedsVerification(record) {
  return !isAdviceOutcomeCurrent(record)
}

export function adviceCandleLimit(records, code, now = Date.now()) {
  const times = (Array.isArray(records) ? records : [])
    .filter((record) =>
      record?.code === code
      && adviceNeedsVerification(record)
      && Number.isFinite(Number(record.at))
    )
    .map((record) => Number(record.at))
  if (!times.length) return 8
  const oldest = Math.min(...times)
  const ageDays = Math.max(0, (Number(now) - oldest) / 86400000)
  return Math.max(8, Math.min(500, Math.ceil(ageDays * 5 / 7) + 10))
}

function beijingDayKey(timestamp) {
  const date = new Date((Number(timestamp) || 0) + 8 * 3600000)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown'
}

export function adviceEpisodeKey(record = {}) {
  const kind = adviceActionKind(record.action)
  const planId = String(record.planId || '').trim()
  if (planId) {
    return `${record.mode || 'other'}|${record.code || 'unknown'}|${kind}|${planId}`
  }
  return `${record.mode || 'other'}|${record.code || 'unknown'}|${kind}|${beijingDayKey(record.at)}`
}

export function dedupeAdviceEpisodes(records = []) {
  const latest = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    if (!record) continue
    const key = adviceEpisodeKey(record)
    const current = latest.get(key)
    if (!current || (Number(record.at) || 0) >= (Number(current.at) || 0)) {
      latest.set(key, record)
    }
  }
  return [...latest.values()]
}

function summarizeGroups(records, keyOf, nameKey) {
  const grouped = {}
  for (const record of records) {
    const key = keyOf(record)
    if (!grouped[key]) {
      grouped[key] = {
        [nameKey]: key,
        total: 0,
        hit: 0,
        sumPct: 0,
      }
    }
    grouped[key].total++
    if (record.hit) grouped[key].hit++
    grouped[key].sumPct += Number(record.resultPct) || 0
  }
  return Object.values(grouped).map((group) => ({
    ...group,
    winRate: group.total
      ? Math.round((group.hit / group.total) * 100)
      : null,
    avgPct: group.total
      ? +(group.sumPct / group.total).toFixed(2)
      : null,
  }))
}

function wilsonLowerBound(successes, samples, z = 1.96) {
  if (!(samples > 0)) return null
  const p = successes / samples
  const denominator = 1 + z ** 2 / samples
  const center = p + z ** 2 / (2 * samples)
  const margin = z * Math.sqrt(
    (p * (1 - p) + z ** 2 / (4 * samples)) / samples,
  )
  return (center - margin) / denominator
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
}

function expectationCalibration(records) {
  const calibrated = records.filter((record) => (
    Number.isFinite(Number(record.expectancy?.pWinGivenFill))
    && typeof record.hit === 'boolean'
    && effectiveAdviceActionKind(record) === 'bull'
  ))
  const brier = mean(calibrated.map((record) => {
    const probability = Number(record.expectancy.pWinGivenFill)
    return (probability - (record.hit ? 1 : 0)) ** 2
  }))
  const rRecords = records.filter((record) => (
    Number.isFinite(Number(record.realizedNetR))
  ))
  const realizedRs = rRecords.map(
    (record) => Number(record.realizedNetR),
  )
  const averageR = mean(realizedRs)
  const variance = realizedRs.length > 1
    ? realizedRs.reduce(
        (sum, value) => sum + (value - averageR) ** 2,
        0,
      ) / (realizedRs.length - 1)
    : null
  const lowerBound = variance != null
    ? averageR - 1.96 * Math.sqrt(variance / realizedRs.length)
    : null
  const buckets = [
    [0, 0.5],
    [0.5, 0.6],
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 1.01],
  ].map(([minimum, maximum]) => {
    const items = calibrated.filter((record) => {
      const probability = Number(record.expectancy.pWinGivenFill)
      return probability >= minimum && probability < maximum
    })
    const wins = items.filter((record) => record.hit).length
    return {
      range: `${Math.round(minimum * 100)}-${
        Math.min(100, Math.round(maximum * 100))
      }`,
      samples: items.length,
      predictedPct: items.length
        ? +(mean(items.map(
            (record) => Number(record.expectancy.pWinGivenFill),
          )) * 100).toFixed(1)
        : null,
      actualPct: items.length
        ? +(wins / items.length * 100).toFixed(1)
        : null,
    }
  })
  return {
    samples: calibrated.length,
    brierScore: brier == null ? null : +brier.toFixed(4),
    buckets,
    realizedRSamples: realizedRs.length,
    averageRealizedNetR:
      averageR == null ? null : +averageR.toFixed(3),
    realizedNetRLowerBound:
      lowerBound == null ? null : +lowerBound.toFixed(3),
  }
}

export function summarizeAdviceOutcomes(records) {
  const source = Array.isArray(records) ? records : []
  const rawLog = source.filter(isAdviceOutcomeCurrent)
  const log = dedupeAdviceEpisodes(rawLog)
  const groups = summarizeGroups(
    log,
    (record) => record.mode || 'other',
    'mode',
  )
  const actions = summarizeGroups(
    log,
    (record) => adviceActionKind(record.action),
    'kind',
  ).map((group) => ({
    ...group,
    label: ADVICE_ACTION_LABELS[group.kind] || group.kind,
    reliable: group.total >= 8,
  }))
  const total = log.length
  const hit = log.filter((record) => record.hit).length
  const sumPct = log.reduce(
    (sum, record) => sum + (Number(record.resultPct) || 0),
    0,
  )
  const bands = [
    { key: 'high', label: '较可信(≥68)', min: 68, max: Infinity },
    { key: 'mid', label: '中等(48~68)', min: 48, max: 68 },
    { key: 'low', label: '低(<48)', min: -Infinity, max: 48 },
  ]
  const byTrust = bands.map((band) => {
    const items = log.filter((record) => {
      const trust = Number(record.trust)
      return Number.isFinite(trust)
        && trust >= band.min
        && trust < band.max
    })
    const bandHits = items.filter((record) => record.hit).length
    const bandPct = items.reduce(
      (sum, record) => sum + (Number(record.resultPct) || 0),
      0,
    )
    return {
      band: band.key,
      label: band.label,
      total: items.length,
      hit: bandHits,
      winRate: items.length
        ? Math.round((bandHits / items.length) * 100)
        : null,
      avgPct: items.length
        ? +(bandPct / items.length).toFixed(2)
        : null,
    }
  })

  return {
    groups,
    actions,
    byTrust,
    noTrust: log.filter(
      (record) => !Number.isFinite(Number(record.trust)),
    ).length,
    total,
    hit,
    winRate: total ? Math.round((hit / total) * 100) : null,
    winRateLowerBoundPct: total
      ? +(wilsonLowerBound(hit, total) * 100).toFixed(1)
      : null,
    avgPct: total ? +(sumPct / total).toFixed(2) : null,
    expectancyCalibration: expectationCalibration(log),
    pending: dedupeAdviceEpisodes(source.filter(adviceNeedsVerification)).length,
    raw: {
      total: rawLog.length,
      hit: rawLog.filter((record) => record.hit).length,
      winRate: rawLog.length
        ? Math.round(rawLog.filter((record) => record.hit).length / rawLog.length * 100)
        : null,
      avgPct: rawLog.length
        ? +(rawLog.reduce((sum, record) => sum + (Number(record.resultPct) || 0), 0) / rawLog.length).toFixed(2)
        : null,
    },
    duplicateRefreshes: Math.max(0, rawLog.length - log.length),
  }
}
