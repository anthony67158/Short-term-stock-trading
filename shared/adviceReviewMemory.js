export const ADVICE_REVIEW_MEMORY_VERSION =
  'advice-review-memory.v1'

const VOLUME_STATES = new Set([
  'EXPANDING',
  'CONTRACTING',
  'NORMAL',
  'UNKNOWN',
])
const VWAP_STATES = new Set([
  'ABOVE',
  'BELOW',
  'AROUND',
  'UNKNOWN',
])
const FUND_RELATIONS = new Set([
  'ACCUMULATION',
  'DISTRIBUTION',
  'CONSENSUS_INFLOW',
  'CONSENSUS_OUTFLOW',
  'MIXED',
  'UNKNOWN',
])
const SOURCES = new Set([
  'ADVISOR',
  'FAST_REVIEW',
  'JUDGE',
  'LEGACY_TEXT',
  'UNKNOWN',
])

const VOLUME_LABELS = Object.freeze({
  EXPANDING: '放量',
  CONTRACTING: '缩量',
  NORMAL: '量能平稳',
  UNKNOWN: '量能未知',
})
const VWAP_LABELS = Object.freeze({
  ABOVE: '站在分时均价线上方',
  BELOW: '位于分时均价线下方',
  AROUND: '围绕分时均价线',
  UNKNOWN: '均价线位置未知',
})
const FUND_LABELS = Object.freeze({
  ACCUMULATION: '主力流入、小单流出',
  DISTRIBUTION: '主力流出、小单流入',
  CONSENSUS_INFLOW: '主力与小单同步流入',
  CONSENSUS_OUTFLOW: '主力与小单同步流出',
  MIXED: '资金关系混合',
  UNKNOWN: '资金关系未知',
})

const text = (value, maximum = 500) => String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum)

const finite = (value) => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const round = (value, digits = 3) => {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function isoTime(value) {
  if (value == null || value === '') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : null
}

function enumValue(value, allowed, fallback = 'UNKNOWN') {
  const normalized = String(value || '').trim().toUpperCase()
  return allowed.has(normalized) ? normalized : fallback
}

function volumeStateFrom({
  state,
  ratio,
  textValue,
} = {}) {
  const normalized = enumValue(state, VOLUME_STATES, '')
  if (normalized) return normalized
  const numericRatio = finite(ratio)
  if (numericRatio != null) {
    if (numericRatio >= 1.25) return 'EXPANDING'
    if (numericRatio <= 0.8) return 'CONTRACTING'
    return 'NORMAL'
  }
  const note = text(textValue, 1200)
  if (/缩量/.test(note)) return 'CONTRACTING'
  if (!/未放量|没有放量|量能不足/.test(note) && /放量/.test(note)) {
    return 'EXPANDING'
  }
  if (/量能平稳|平量|量能正常/.test(note)) return 'NORMAL'
  return 'UNKNOWN'
}

function vwapStateFrom({
  state,
  price,
  vwap,
  textValue,
} = {}) {
  const normalized = enumValue(state, VWAP_STATES, '')
  if (normalized) return normalized
  const current = finite(price)
  const average = finite(vwap)
  if (current != null && average > 0) {
    const distancePct = (current - average) / average * 100
    if (distancePct >= 0.1) return 'ABOVE'
    if (distancePct <= -0.1) return 'BELOW'
    return 'AROUND'
  }
  const note = text(textValue, 1200)
  if (/站回|站上|均价线.{0,8}上方|VWAP.{0,8}上方/.test(note)) {
    return 'ABOVE'
  }
  if (/跌破|均价线.{0,8}下方|VWAP.{0,8}下方/.test(note)) {
    return 'BELOW'
  }
  if (/围绕.{0,8}(?:均价线|VWAP)|均价线附近/.test(note)) {
    return 'AROUND'
  }
  return 'UNKNOWN'
}

function flowDirection(value) {
  const number = finite(value)
  if (number == null) return 'UNKNOWN'
  if (number > 0.01) return 'INFLOW'
  if (number < -0.01) return 'OUTFLOW'
  return 'FLAT'
}

function fundRelationFrom({
  relation,
  mainNetYi,
  retailNetYi,
  textValue,
} = {}) {
  const normalized = String(relation || '').trim().toUpperCase()
  if (FUND_RELATIONS.has(normalized)) return normalized
  if (normalized === 'CONSENSUS') {
    const mainDirection = flowDirection(mainNetYi)
    return mainDirection === 'INFLOW'
      ? 'CONSENSUS_INFLOW'
      : mainDirection === 'OUTFLOW'
        ? 'CONSENSUS_OUTFLOW'
        : 'MIXED'
  }
  if (normalized === 'DIVERGENCE') return 'MIXED'

  const mainDirection = flowDirection(mainNetYi)
  const retailDirection = flowDirection(retailNetYi)
  if (mainDirection === 'INFLOW' && retailDirection === 'OUTFLOW') {
    return 'ACCUMULATION'
  }
  if (mainDirection === 'OUTFLOW' && retailDirection === 'INFLOW') {
    return 'DISTRIBUTION'
  }
  if (mainDirection === 'INFLOW' && retailDirection === 'INFLOW') {
    return 'CONSENSUS_INFLOW'
  }
  if (mainDirection === 'OUTFLOW' && retailDirection === 'OUTFLOW') {
    return 'CONSENSUS_OUTFLOW'
  }
  if (
    mainDirection !== 'UNKNOWN'
    && retailDirection !== 'UNKNOWN'
  ) return 'MIXED'

  const note = text(textValue, 1200)
  if (/主力.{0,10}流入.{0,20}(?:小单|散户).{0,10}流出/.test(note)) {
    return 'ACCUMULATION'
  }
  if (/主力.{0,10}流出.{0,20}(?:小单|散户).{0,10}流入/.test(note)) {
    return 'DISTRIBUTION'
  }
  return 'UNKNOWN'
}

function positionLimit(advice = {}, payload = {}) {
  const direct = finite(
    payload.reviewEvent?.maxPositionPct
    ?? payload.shortHorizonTactical?.actionPolicy?.maxPositionPct
    ?? advice.reviewMemory?.conclusion?.maxPositionPct,
  )
  if (direct != null && direct > 0) {
    return Math.min(100, round(direct, 2))
  }
  const match = text(
    advice.positionNote || advice.actionPlan,
    1000,
  ).match(/(?:仓位|单票).{0,12}(?:不超过|上限)\s*(\d+(?:\.\d+)?)%/)
  return match ? Math.min(100, Number(match[1])) : null
}

export function sanitizeAdviceReviewMemory(input = {}) {
  if (!input || typeof input !== 'object') return null
  const market = input.market && typeof input.market === 'object'
    ? input.market
    : {}
  const funds = input.funds && typeof input.funds === 'object'
    ? input.funds
    : {}
  const conclusion = input.conclusion
    && typeof input.conclusion === 'object'
    ? input.conclusion
    : {}
  const volumeState = volumeStateFrom({
    state: market.volumeState,
    ratio:
      market.recentVolumeRatio
      ?? market.quoteVolumeRatio,
    textValue: market.textValue,
  })
  const priceVsVwap = vwapStateFrom({
    state: market.priceVsVwap,
    price: market.price,
    vwap: market.vwap,
    textValue: market.textValue,
  })
  const fundRelation = fundRelationFrom({
    relation: funds.relation,
    mainNetYi: funds.mainNetYi,
    retailNetYi: funds.retailNetYi,
    textValue: funds.textValue,
  })
  const action = text(conclusion.action, 50)
  const executionCondition = text(
    conclusion.executionCondition,
    500,
  )
  const invalidation = text(conclusion.invalidation, 300)
  const hasContent = (
    action
    || executionCondition
    || invalidation
    || volumeState !== 'UNKNOWN'
    || priceVsVwap !== 'UNKNOWN'
    || fundRelation !== 'UNKNOWN'
    || finite(market.price) != null
    || finite(funds.mainNetYi) != null
    || finite(funds.retailNetYi) != null
  )
  if (!hasContent) return null
  return {
    schemaVersion: ADVICE_REVIEW_MEMORY_VERSION,
    observedAt: isoTime(input.observedAt),
    source: enumValue(input.source, SOURCES),
    conclusion: {
      action,
      executionCondition,
      invalidation,
      maxPositionPct: round(conclusion.maxPositionPct, 2),
    },
    market: {
      volumeState,
      volumeLabel: VOLUME_LABELS[volumeState],
      recentVolumeRatio: round(market.recentVolumeRatio, 2),
      quoteVolumeRatio: round(market.quoteVolumeRatio, 2),
      priceVsVwap,
      priceVsVwapLabel: VWAP_LABELS[priceVsVwap],
      price: round(market.price),
      vwap: round(market.vwap),
      vwapDistancePct: round(market.vwapDistancePct, 2),
      directionFromOpen: text(market.directionFromOpen, 20)
        || 'UNKNOWN',
    },
    funds: {
      relation: fundRelation,
      relationLabel: FUND_LABELS[fundRelation],
      mainNetYi: round(funds.mainNetYi, 2),
      retailNetYi: round(funds.retailNetYi, 2),
    },
  }
}

export function buildAdviceReviewMemory({
  advice = {},
  payload = {},
  source = 'ADVISOR',
  now = Date.now(),
} = {}) {
  const intraday = payload.intradayOpenSummary
    || payload.intraday
    || {}
  const quote = payload.todayQuote || {}
  const tactical = payload.shortHorizonTactical || {}
  const fund = payload.stockFund
    || advice.fundContext
    || {}
  const notes = [
    advice.techNote,
    advice.fundNote,
    advice.reason,
    advice.actionPlan,
    advice.exitTiming,
  ].filter(Boolean).join('；')
  const observedAt = (
    intraday.observedAt
    || tactical.asOf
    || quote.asOf
    || quote.asOfLabel
    || fund.fetchedAt
    || (source === 'LEGACY_TEXT' ? null : now)
  )
  return sanitizeAdviceReviewMemory({
    observedAt,
    source,
    conclusion: {
      action: advice.action || advice.stance,
      executionCondition:
        advice.exitTiming
        || advice.actionPlan
        || advice.nextAction,
      invalidation: advice.invalidation,
      maxPositionPct: positionLimit(advice, payload),
    },
    market: {
      volumeState: intraday.volume?.state
        || intraday.volumeState,
      recentVolumeRatio: intraday.volume?.recentToPriorRatio
        ?? intraday.recentVolumeRatio,
      quoteVolumeRatio:
        quote.volRatio
        ?? tactical.stock?.volRatio
        ?? tactical.technical?.volumeRatio,
      priceVsVwap: intraday.priceVsVwap
        || tactical.stock?.priceVsVwap,
      price:
        intraday.currentPrice
        ?? intraday.now
        ?? quote.price
        ?? tactical.stock?.price,
      vwap: intraday.vwap,
      vwapDistancePct: intraday.vwapDistancePct,
      directionFromOpen: intraday.directionFromOpen,
      textValue: notes,
    },
    funds: {
      relation:
        tactical.flow?.relation
        || fund.retailFlow?.relation,
      mainNetYi: fund.mainNetYi,
      retailNetYi: fund.retailNetYi ?? fund.smallNetYi,
      textValue: notes,
    },
  })
}

export function resolveAdviceReviewMemory(advice = {}) {
  return sanitizeAdviceReviewMemory(advice.reviewMemory)
    || buildAdviceReviewMemory({
      advice,
      payload: {
        shortHorizonTactical: advice.shortHorizonTactical,
        stockFund: advice.fundContext,
      },
      source: 'LEGACY_TEXT',
      now: null,
    })
}

export function compareAdviceReviewMemory(
  previousInput,
  currentInput,
) {
  const previous = sanitizeAdviceReviewMemory(previousInput)
  const current = sanitizeAdviceReviewMemory(currentInput)
  const changed = (left, right) => (
    left !== 'UNKNOWN'
    && right !== 'UNKNOWN'
    && left !== right
  )
  const volumeChanged = changed(
    previous?.market?.volumeState,
    current?.market?.volumeState,
  )
  const vwapChanged = changed(
    previous?.market?.priceVsVwap,
    current?.market?.priceVsVwap,
  )
  const fundRelationChanged = changed(
    previous?.funds?.relation,
    current?.funds?.relation,
  )
  const mainDeltaYi = (
    finite(previous?.funds?.mainNetYi) != null
    && finite(current?.funds?.mainNetYi) != null
  )
    ? round(
        current.funds.mainNetYi - previous.funds.mainNetYi,
        2,
      )
    : null
  const retailDeltaYi = (
    finite(previous?.funds?.retailNetYi) != null
    && finite(current?.funds?.retailNetYi) != null
  )
    ? round(
        current.funds.retailNetYi - previous.funds.retailNetYi,
        2,
      )
    : null
  const summary = [
    volumeChanged
      ? `量能由${previous.market.volumeLabel}变为${current.market.volumeLabel}`
      : '',
    vwapChanged
      ? `价格由${previous.market.priceVsVwapLabel}变为${current.market.priceVsVwapLabel}`
      : '',
    fundRelationChanged
      ? `资金关系由${previous.funds.relationLabel}变为${current.funds.relationLabel}`
      : '',
  ].filter(Boolean)
  return {
    volumeChanged,
    vwapChanged,
    fundRelationChanged,
    mainDeltaYi,
    retailDeltaYi,
    hasMaterialChange:
      volumeChanged || vwapChanged || fundRelationChanged,
    summary,
  }
}
