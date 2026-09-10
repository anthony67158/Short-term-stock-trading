import {
  normalizeQuantModelVersion,
  quantModelLabel,
} from './modelVersion.js'

const clean = (value, max = 240) =>
  String(value || '').trim().slice(0, max)

const finite = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function forecastOf(value) {
  if (!value || typeof value !== 'object') return null
  const forecast = {
    targetDate: clean(value.targetDate, 20),
    direction: clean(value.direction, 20),
    upProb: finite(value.upProb),
    expRet: finite(value.expRet),
    targetLow: finite(value.targetLow),
    targetMid: finite(value.targetMid),
    targetHigh: finite(value.targetHigh),
  }
  return Object.values(forecast).some(
    (item) => item !== null && item !== '',
  )
    ? forecast
    : null
}

export function buildQuantAdviceContext(
  quant,
  requestedVersion = 'default',
) {
  if (!quant || typeof quant !== 'object') return null
  const selectedModelVersion = normalizeQuantModelVersion(
    quant.selectedModelVersion || requestedVersion,
  )
  const effectiveModelVersion = normalizeQuantModelVersion(
    quant.effectiveModelVersion || quant.modelVersion,
  )
  const runtimeModelVersion = ''
  const nextTradeDayForecast = forecastOf(
    quant.nextTradeDayForecast,
  )
  return {
    selectedModelVersion,
    effectiveModelVersion,
    runtimeModelVersion,
    modelLabel: quantModelLabel(),
    horizon: clean(quant.horizon || quant.forecast?.horizon, 120),
    asOf: clean(quant.asOf, 40),
    ...(quant.inputAsOf ? {
      inputAsOf: clean(quant.inputAsOf, 40),
      inputSource: clean(quant.inputSource, 80),
    } : {}),
    ...(nextTradeDayForecast ? { nextTradeDayForecast } : {}),
    experimental: false,
    fallback: null,
    reliability: null,
  }
}

export function quantJudgeDiscipline() {
  return ''
}
