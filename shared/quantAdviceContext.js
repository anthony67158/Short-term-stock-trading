import {
  normalizeQuantModelVersion,
  quantModelLabel,
  QUANT_MODEL_V21,
  V21_EXPERIMENTAL_RELIABILITY,
} from './modelVersion.js'

const clean = (value, max = 240) =>
  String(value || '').trim().slice(0, max)

const finite = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function reliabilityOf(value, selected) {
  const source = value && typeof value === 'object'
    ? value
    : selected === QUANT_MODEL_V21
      ? V21_EXPERIMENTAL_RELIABILITY
      : null
  if (!source) return null
  const next30m = finite(source.balancedAccuracyPct?.next30m)
  const sessionClose = finite(
    source.balancedAccuracyPct?.sessionClose,
  )
  const thresholdPct = finite(source.thresholdPct)
  return {
    productionGatePassed: source.productionGatePassed === true,
    thresholdPct,
    balancedAccuracyPct: {
      next30m,
      sessionClose,
    },
  }
}

function fallbackOf(value) {
  if (!value || typeof value !== 'object') return null
  const from = normalizeQuantModelVersion(value.from)
  const to = normalizeQuantModelVersion(value.to)
  const reason = clean(value.reason, 300)
  return reason ? { from, to, reason } : null
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
  const runtimeModelVersion = clean(
    quant.runtimeModelVersion
      || (effectiveModelVersion === 'v2' ? 'v2.0-daily' : ''),
    80,
  )
  return {
    selectedModelVersion,
    effectiveModelVersion,
    runtimeModelVersion,
    modelLabel: clean(
      quant.modelLabel || quantModelLabel(effectiveModelVersion),
      120,
    ),
    horizon: clean(quant.horizon || quant.forecast?.horizon, 120),
    asOf: clean(quant.asOf, 40),
    experimental: selectedModelVersion === QUANT_MODEL_V21,
    fallback: fallbackOf(quant.fallback),
    reliability: reliabilityOf(
      quant.reliability,
      selectedModelVersion,
    ),
  }
}

export function quantJudgeDiscipline(context) {
  if (!context || context.selectedModelVersion !== QUANT_MODEL_V21) {
    return ''
  }
  if (context.fallback) {
    return '用户虽选择V2.1，但本次实际V2.0回退；只能按V2.0日终窗口解释，不得冒充盘中双头信号。'
  }
  return 'V2.1是未达58%生产门槛的手动实验模型：其概率不得单独构成confirm；必须同时有确定性分时信号和非量化证据共振，LLM置信度上限85。'
}
