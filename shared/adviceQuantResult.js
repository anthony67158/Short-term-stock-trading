import { buildQuantAdviceContext } from './quantAdviceContext.js'

export function quantResultFromAdviceMeta(meta, priceHint = null) {
  const quant = meta?.quantResult
  if (!quant || typeof quant !== 'object') return null
  return {
    ...quant,
    price: Number(quant.price) > 0
      ? Number(quant.price)
      : Number(priceHint) > 0 ? Number(priceHint) : null,
  }
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clean(value, max = 120) {
  return String(value || '').trim().slice(0, max)
}

function compact(value, depth = 0) {
  if (value == null || depth > 4) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') return value.slice(0, 300)
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 12)
      .map((item) => compact(item, depth + 1))
      .filter((item) => item != null)
  }
  if (typeof value !== 'object') return null
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, item]) => [key, compact(item, depth + 1)])
      .filter(([, item]) => item != null),
  )
}

function forecast(value) {
  if (!value || typeof value !== 'object') return null
  const direction = clean(value.direction, 30)
  const normalized = {
    targetDate: clean(value.targetDate, 20),
    direction: direction === 'UNKNOWN' ? '' : direction,
    upProb: finite(value.upProb),
    expRet: finite(value.expRet),
    targetLow: finite(value.targetLow),
    targetMid: finite(value.targetMid),
    targetHigh: finite(value.targetHigh),
    horizon: clean(value.horizon, 60),
  }
  return Object.values(normalized).some(
    (item) => item !== null && item !== '',
  )
    ? normalized
    : null
}

export function normalizeReusableQuantEvidence(value) {
  if (!value || typeof value !== 'object') return null
  const primaryForecast = forecast(
    value.forecast || {
      direction: value.direction,
      upProb: value.upProb,
      expRet: value.expRet,
      targetLow: value.targetLow,
      targetMid: value.targetMid,
      targetHigh: value.targetHigh,
      horizon: value.horizon,
    },
  )
  const nextTradeDayForecast = forecast(
    value.nextTradeDayForecast || value.nextTradeDay,
  )
  const currentTradingDayForecast = forecast(
    value.currentTradingDayForecast || value.currentTradingDay,
  )
  const score = finite(value.score)
  const hitProb = finite(value.hitProb)
  const hasMeasuredResult = [
    score,
    hitProb,
    primaryForecast?.upProb,
    primaryForecast?.expRet,
    primaryForecast?.targetLow,
    primaryForecast?.targetMid,
    primaryForecast?.targetHigh,
    nextTradeDayForecast?.upProb,
    nextTradeDayForecast?.expRet,
    currentTradingDayForecast?.upProb,
    currentTradingDayForecast?.expRet,
  ].some((item) => item != null)
    || !!primaryForecast?.direction
    || !!nextTradeDayForecast?.direction
    || !!currentTradingDayForecast?.direction
  if (!hasMeasuredResult) return null

  return {
    selectedModelVersion: clean(value.selectedModelVersion, 40),
    modelVersion: clean(
      value.modelVersion || value.effectiveModelVersion,
      40,
    ),
    runtimeModelVersion: clean(value.runtimeModelVersion, 80),
    modelLabel: clean(value.modelLabel, 120),
    asOf: clean(value.asOf, 60),
    inputAsOf: clean(value.inputAsOf, 60),
    inputSource: clean(value.inputSource, 80),
    inputBarCount: finite(value.inputBarCount),
    score,
    bias: clean(value.bias, 40),
    tDir: clean(value.tDir, 40),
    hitProb,
    forecast: primaryForecast,
    nextTradeDayForecast,
    currentTradingDayForecast,
    highConfSignal: compact(
      value.highConfSignal || (
        typeof value.highConfidence === 'boolean'
          ? { fired: value.highConfidence }
          : null
      ),
    ),
    reliability: compact(value.reliability),
    reads: compact(value.reads),
    eventTag: compact(value.eventTag),
    v2: compact(value.v2),
    v21: compact(value.v21),
    fallback: compact(value.fallback),
    experimental: value.experimental === true,
  }
}

export function reusableQuantEvidenceFromAdvice(advice) {
  if (!advice || typeof advice !== 'object') return null
  const candidates = [
    advice.quantEvidence,
    advice.shortHorizonTactical?.quant,
    advice.quantContext,
  ]
  for (const candidate of candidates) {
    const normalized = normalizeReusableQuantEvidence(candidate)
    if (normalized) return normalized
  }
  return null
}

export function reusableQuantEvidenceFromAdviceEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const advice = entry.advice && typeof entry.advice === 'object'
    ? entry.advice
    : entry
  const candidates = [
    entry.meta?.quantResult,
    entry.result,
    entry.meta?.evidenceSnapshot?.evidence?.quant,
  ]
  for (const candidate of candidates) {
    const normalized = normalizeReusableQuantEvidence(candidate)
    if (normalized) return normalized
  }
  const current = reusableQuantEvidenceFromAdvice(advice)
  if (current) return current
  const trail = Array.isArray(entry.trail) ? entry.trail : []
  for (let index = trail.length - 1; index >= 0; index--) {
    const previous = reusableQuantEvidenceFromAdvice(trail[index])
    if (previous) return previous
  }
  return null
}

export function restoreAdviceEntryQuantEvidence(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const quantEvidence = reusableQuantEvidenceFromAdviceEntry(entry)
  if (!quantEvidence) return entry
  const advice = entry.advice && typeof entry.advice === 'object'
    ? entry.advice
    : null
  const decisionPlan = advice?.decisionPlan
  const evidenceIssues = Array.isArray(decisionPlan?.evidenceIssues)
    ? decisionPlan.evidenceIssues.filter((issue) => !(
        issue?.source === 'quant'
        && /TRIGGERED_REVIEW_REUSE_PREVIOUS|原建议没有可复用的量化结果/.test(
          String(issue?.reason || ''),
        )
      ))
    : null
  const result = entry.result && typeof entry.result === 'object'
    ? { ...entry.result, ...quantEvidence }
    : quantEvidence
  return {
    ...entry,
    result,
    meta: {
      ...(entry.meta || {}),
      quantResult: quantEvidence,
    },
    ...(advice ? {
      advice: {
        ...advice,
        quantContext: advice.quantContext
          || buildQuantAdviceContext(
            quantEvidence,
            quantEvidence.selectedModelVersion,
          ),
        ...(decisionPlan && evidenceIssues
          ? {
              decisionPlan: {
                ...decisionPlan,
                evidenceIssues,
              },
            }
          : {}),
      },
    } : {}),
  }
}
