import { executionTriggerDirection } from './executionTrigger.js'

export const ADVICE_PRICE_CONTRACT_SCHEMA_VERSION =
  'advice-price-contract.v1'

const PRICE_FIELDS = Object.freeze([
  ['buyPrice', 'entry', 'ENTRY'],
  ['addPrice', 'add', 'ENTRY'],
  ['reducePrice', 'reduce', 'EXIT'],
  ['stopPrice', 'stop', 'RISK'],
  ['targetPrice', 'target', 'OBJECTIVE'],
  ['watchPrice', 'watch', 'REVIEW_ONLY'],
  ['leg1Price', 'leg1', 'EXECUTION'],
  ['leg2Price', 'leg2', 'EXECUTION'],
])

const ROLE_DISTANCE_LIMIT_PCT = Object.freeze({
  entry: 5,
  add: 5,
  reduce: 8,
  stop: 12,
  target: 25,
  watch: 5,
  leg1: 5,
  leg2: 8,
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function positive(value) {
  const number = finite(value)
  return number != null && number > 0 ? number : null
}

function roundedPrice(value) {
  const number = positive(value)
  if (number == null) return null
  return +(number < 10 ? number.toFixed(3) : number.toFixed(2))
}

function text(value, maximum = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function pushAnchor(output, source, value, roles) {
  const price = roundedPrice(value)
  if (price == null) return
  output.push({ source, price, roles })
}

function collectAnchors(payload = {}) {
  const quote = payload.todayQuote || {}
  const tech = payload.tech || {}
  const hints = tech.priceHints || tech
  const quant = payload.quant || {}
  const forecast = quant.forecast || {}
  const next = quant.nextTradeDayForecast || {}
  const highConfidence = quant.highConfSignal || {}
  const references = quant.v2?.priceReferences || {}
  const anchors = []
  const all = ['entry', 'add', 'reduce', 'stop', 'target', 'watch', 'leg1', 'leg2']
  const lower = ['entry', 'add', 'stop', 'watch', 'leg1', 'leg2']
  const upper = ['reduce', 'target', 'watch', 'leg1', 'leg2']

  pushAnchor(anchors, 'quote.current', quote.price ?? payload.currentPrice, all)
  pushAnchor(anchors, 'quote.open', quote.open, all)
  pushAnchor(anchors, 'quote.dayLow', quote.low ?? quote.dayLow, lower)
  pushAnchor(anchors, 'quote.dayHigh', quote.high ?? quote.dayHigh, upper)
  pushAnchor(anchors, 'technical.support', tech.support, lower)
  pushAnchor(anchors, 'technical.resistance', tech.resistance, upper)
  pushAnchor(anchors, 'technical.buyZone.low', hints.buyZone?.low, lower)
  pushAnchor(anchors, 'technical.buyZone.high', hints.buyZone?.high, lower)
  pushAnchor(anchors, 'technical.sellZone.low', hints.sellZone?.low, upper)
  pushAnchor(anchors, 'technical.sellZone.high', hints.sellZone?.high, upper)
  pushAnchor(anchors, 'technical.stopLoss', hints.stopLoss, ['stop'])
  pushAnchor(anchors, 'technical.takeProfit', hints.takeProfit, ['reduce', 'target'])
  pushAnchor(anchors, 'technical.ma5', tech.ma?.ma5, all)
  pushAnchor(anchors, 'technical.ma10', tech.ma?.ma10, all)
  pushAnchor(anchors, 'technical.ma20', tech.ma?.ma20, all)
  pushAnchor(anchors, 'technical.boll.lower', tech.boll?.lower, lower)
  pushAnchor(anchors, 'technical.boll.mid', tech.boll?.mid, all)
  pushAnchor(anchors, 'technical.boll.upper', tech.boll?.upper, upper)
  pushAnchor(anchors, 'intraday.vwap', payload.intraday?.vwap, all)
  pushAnchor(anchors, 'intraday.dayLow', payload.intraday?.dayLow, lower)
  pushAnchor(anchors, 'intraday.dayHigh', payload.intraday?.dayHigh, upper)
  pushAnchor(anchors, 'quant.highConf.buyPrice', highConfidence.buyPrice, lower)
  pushAnchor(anchors, 'quant.highConf.stopLoss', highConfidence.stopLoss, ['stop'])
  pushAnchor(anchors, 'quant.highConf.takeProfit', highConfidence.takeProfit, ['reduce', 'target'])
  for (const [prefix, item] of [
    ['quant.forecast', forecast],
    ['quant.nextTradeDayForecast', next],
  ]) {
    pushAnchor(anchors, `${prefix}.targetLow`, item.targetLow, upper)
    pushAnchor(anchors, `${prefix}.targetMid`, item.targetMid, upper)
    pushAnchor(anchors, `${prefix}.targetHigh`, item.targetHigh, upper)
  }
  pushAnchor(anchors, 'quant.v2.referenceBuyZoneLow', references.referenceBuyZoneLow, lower)
  pushAnchor(anchors, 'quant.v2.referenceBuyZoneHigh', references.referenceBuyZoneHigh, lower)
  pushAnchor(anchors, 'quant.v2.supportPrice', references.supportPrice, lower)
  pushAnchor(anchors, 'quant.v2.resistancePrice', references.resistancePrice, upper)
  pushAnchor(anchors, 'quant.v2.takeProfit', references.indicativeTakeProfitPrice, ['reduce', 'target'])
  pushAnchor(anchors, 'quant.v2.stopLoss', references.indicativeStopLossPrice, ['stop'])
  return anchors
}

function directionFor(key, advice = {}, action = '') {
  const trigger = text(
    advice.timing
    || advice.actionPlan
    || advice.nextAction
    || advice.futurePlan,
  )
  if (key === 'watch') {
    return executionTriggerDirection({
      action: 'WATCH',
      trigger,
      triggerDirection: advice.watchDirection,
    }) || 'UNKNOWN'
  }
  if (key === 'stop') return 'LTE'
  if (key === 'target') return 'GTE'
  if (key === 'entry' || key === 'add') return 'LTE'
  if (key === 'reduce') {
    return executionTriggerDirection({
      action: action || 'REDUCE',
      trigger,
      triggerDirection: advice.decisionPlan?.triggerDirection,
    }) || 'GTE'
  }
  if (key === 'leg1') return advice.dir === 'reverse' ? 'GTE' : 'LTE'
  if (key === 'leg2') return advice.dir === 'reverse' ? 'LTE' : 'GTE'
  return 'UNKNOWN'
}

function nearestAnchor(price, key, anchors) {
  const candidates = anchors.filter((item) => item.roles.includes(key))
  if (!candidates.length) return null
  return candidates
    .map((item) => ({
      ...item,
      distancePct: Math.abs(price / item.price - 1) * 100,
    }))
    .sort((left, right) => left.distancePct - right.distancePct)[0]
}

function levelStatus(direction, price, currentPrice) {
  if (!(currentPrice > 0)) return 'UNKNOWN'
  if (direction === 'GTE') return currentPrice >= price ? 'MET' : 'PENDING'
  if (direction === 'LTE') return currentPrice <= price ? 'MET' : 'PENDING'
  if (direction === 'IMMEDIATE') return 'MET'
  return 'UNKNOWN'
}

function priceZone(value) {
  if (value && typeof value === 'object') {
    const low = roundedPrice(value.low)
    const high = roundedPrice(value.high)
    return low != null && high != null && low <= high
      ? { low, high }
      : null
  }
  const values = String(value || '')
    .replace(/,/g, '')
    .match(/\d+(?:\.\d+)?/g)
    ?.map(Number)
    .filter((item) => Number.isFinite(item) && item > 0)
  if (!values?.length) return null
  const low = roundedPrice(values[0])
  const high = roundedPrice(values[1] ?? values[0])
  return low != null && high != null && low <= high
    ? { low, high }
    : null
}

export function buildAdvicePriceContract({
  mode = '',
  advice = {},
  payload = {},
  evidenceSnapshot = null,
  action = '',
} = {}) {
  const quote = payload.todayQuote || {}
  const currentPrice = roundedPrice(
    quote.price
    ?? payload.intraday?.now
    ?? payload.currentPrice,
  )
  const legalLow = roundedPrice(quote.limitDownPrice)
  const legalHigh = roundedPrice(quote.limitUpPrice)
  const atr = positive(payload.tech?.atr?.atr ?? payload.tech?.atr)
  const atrPct = currentPrice != null && atr != null
    ? atr / currentPrice * 100
    : null
  const anchors = collectAnchors(payload)
  const levels = []
  const issues = []

  for (const [field, key, purpose] of PRICE_FIELDS) {
    const price = roundedPrice(advice[field])
    if (price == null) continue
    const direction = directionFor(key, advice, action)
    const withinLegalBand = (
      (legalLow == null || price >= legalLow)
      && (legalHigh == null || price <= legalHigh)
    )
    const nearest = nearestAnchor(price, key, anchors)
    const tolerancePct = Math.max(
      1,
      Math.min(
        ROLE_DISTANCE_LIMIT_PCT[key],
        atrPct != null ? atrPct * 1.5 : ROLE_DISTANCE_LIMIT_PCT[key],
      ),
    )
    const evidenceBacked = !!nearest
      && nearest.distancePct <= tolerancePct
    const strict = withinLegalBand
      && direction !== 'UNKNOWN'
      && evidenceBacked
    if (!withinLegalBand) issues.push(`${field}超出当日合法价带`)
    else if (direction === 'UNKNOWN') issues.push(`${field}缺少明确触发方向`)
    else if (!evidenceBacked) issues.push(`${field}缺少邻近行情、技术或量化锚点`)
    levels.push({
      key,
      field,
      purpose,
      price,
      direction,
      status: levelStatus(direction, price, currentPrice),
      strict,
      basis: nearest?.source || null,
      basisPrice: nearest?.price ?? null,
      basisDistancePct: nearest
        ? +nearest.distancePct.toFixed(2)
        : null,
      tolerancePct: +tolerancePct.toFixed(2),
    })
  }

  const rawBuyZone = advice.buyZone
  const buyZoneProvided = rawBuyZone != null && rawBuyZone !== ''
  const buyZone = priceZone(rawBuyZone)
  let buyZoneContract = null
  if (buyZoneProvided) {
    if (!buyZone) {
      issues.push('buyZone格式或上下界非法')
    } else {
      const endpoints = [
        ['low', buyZone.low],
        ['high', buyZone.high],
      ].map(([key, price]) => {
        const nearest = nearestAnchor(price, 'entry', anchors)
        const tolerancePct = Math.max(
          1,
          Math.min(
            ROLE_DISTANCE_LIMIT_PCT.entry,
            atrPct != null
              ? atrPct * 1.5
              : ROLE_DISTANCE_LIMIT_PCT.entry,
          ),
        )
        const withinLegalBand = (
          (legalLow == null || price >= legalLow)
          && (legalHigh == null || price <= legalHigh)
        )
        const evidenceBacked = !!nearest
          && nearest.distancePct <= tolerancePct
        return {
          key,
          price,
          strict: withinLegalBand && evidenceBacked,
          basis: nearest?.source || null,
          basisPrice: nearest?.price ?? null,
          basisDistancePct: nearest
            ? +nearest.distancePct.toFixed(2)
            : null,
          tolerancePct: +tolerancePct.toFixed(2),
        }
      })
      buyZoneContract = {
        low: buyZone.low,
        high: buyZone.high,
        strict: endpoints.every((item) => item.strict),
        endpoints,
      }
      if (!buyZoneContract.strict) {
        issues.push('buyZone超出合法价带或缺少邻近行情、技术或量化锚点')
      }
    }
  }

  const watch = levels.find((level) => level.key === 'watch') || null
  const reviewConditions = [
    ...(watch ? [{
      key: 'WATCH_PRICE',
      direction: watch.direction,
      price: watch.price,
      status: watch.status,
      strict: watch.strict,
    }] : []),
  ]

  return {
    schemaVersion: ADVICE_PRICE_CONTRACT_SCHEMA_VERSION,
    mode: text(mode, 30),
    asOf: evidenceSnapshot?.asOf
      || text(quote.asOf || quote.time || '', 60)
      || null,
    evidenceSnapshotId: evidenceSnapshot?.snapshotId || null,
    currentPrice,
    legalRange: {
      low: legalLow,
      high: legalHigh,
    },
    validationStatus: anchors.length
      ? (
          levels.every((level) => level.strict)
          && (
            !buyZoneProvided
            || buyZoneContract?.strict === true
          )
        ) ? 'VERIFIED' : 'REJECTED'
      : 'UNAVAILABLE',
    levels,
    allPricesStrict: anchors.length > 0
      && levels.every((level) => level.strict)
      && (
        !buyZoneProvided
        || buyZoneContract?.strict === true
      ),
    zones: {
      buy: buyZoneContract,
    },
    issues: [...new Set(issues)],
    review: {
      operator: 'ALL',
      conditions: reviewConditions,
      allMet: reviewConditions.length > 0
        && reviewConditions.every((condition) =>
          condition.status === 'MET'
          && condition.strict !== false
        ),
    },
  }
}

export function advicePriceLevel(advice = {}, key = '') {
  const value = advice && typeof advice === 'object' ? advice : {}
  const contract = value.priceContract?.schemaVersion
    === ADVICE_PRICE_CONTRACT_SCHEMA_VERSION
    ? value.priceContract
    : value.decisionPlan?.priceContract?.schemaVersion
      === ADVICE_PRICE_CONTRACT_SCHEMA_VERSION
      ? value.decisionPlan.priceContract
      : null
  return contract?.levels?.find((level) =>
    level?.key === key
    && level.strict === true
    && positive(level.price) != null
  ) || null
}

export function advicePriceLevelForIntent(advice = {}, intent = '') {
  const keys = {
    buy: ['entry'],
    add: ['add', 'entry'],
    reduce: ['reduce', 'target'],
    sell: ['reduce', 'target'],
    stop: ['stop'],
  }[String(intent || '')] || []
  for (const key of keys) {
    const level = advicePriceLevel(advice, key)
    if (level) return level
  }
  return null
}

export function sanitizedAdvicePriceContract(advice = {}) {
  const value = advice && typeof advice === 'object' ? advice : {}
  const source = value.priceContract?.schemaVersion
    === ADVICE_PRICE_CONTRACT_SCHEMA_VERSION
    ? value.priceContract
    : value.decisionPlan?.priceContract?.schemaVersion
      === ADVICE_PRICE_CONTRACT_SCHEMA_VERSION
      ? value.decisionPlan.priceContract
      : null
  if (!source) return null
  return {
    schemaVersion: ADVICE_PRICE_CONTRACT_SCHEMA_VERSION,
    asOf: text(source.asOf, 60) || null,
    evidenceSnapshotId: text(source.evidenceSnapshotId, 120) || null,
    currentPrice: roundedPrice(source.currentPrice),
    legalRange: {
      low: roundedPrice(source.legalRange?.low),
      high: roundedPrice(source.legalRange?.high),
    },
    validationStatus: text(source.validationStatus, 20),
    levels: (Array.isArray(source.levels) ? source.levels : [])
      .map((level) => ({
        key: text(level?.key, 20),
        field: text(level?.field, 30),
        purpose: text(level?.purpose, 30),
        price: roundedPrice(level?.price),
        direction: text(level?.direction, 20),
        status: text(level?.status, 20),
        strict: level?.strict === true,
        basis: text(level?.basis, 80) || null,
        basisPrice: roundedPrice(level?.basisPrice),
        basisDistancePct: finite(level?.basisDistancePct),
        tolerancePct: finite(level?.tolerancePct),
      }))
      .filter((level) => level.key && level.price != null),
    zones: {
      buy: source.zones?.buy ? {
        low: roundedPrice(source.zones.buy.low),
        high: roundedPrice(source.zones.buy.high),
        strict: source.zones.buy.strict === true,
        endpoints: (Array.isArray(source.zones.buy.endpoints)
          ? source.zones.buy.endpoints
          : [])
          .map((endpoint) => ({
            key: text(endpoint?.key, 20),
            price: roundedPrice(endpoint?.price),
            strict: endpoint?.strict === true,
            basis: text(endpoint?.basis, 80) || null,
            basisPrice: roundedPrice(endpoint?.basisPrice),
            basisDistancePct: finite(endpoint?.basisDistancePct),
            tolerancePct: finite(endpoint?.tolerancePct),
          }))
          .filter((endpoint) => endpoint.key && endpoint.price != null),
      } : null,
    },
    allPricesStrict: source.allPricesStrict === true,
    issues: (Array.isArray(source.issues) ? source.issues : [])
      .map((item) => text(item, 120))
      .filter(Boolean)
      .slice(0, 12),
    review: {
      operator: source.review?.operator === 'ALL' ? 'ALL' : 'ALL',
      conditions: (Array.isArray(source.review?.conditions)
        ? source.review.conditions
        : [])
        .map((condition) => ({
          key: text(condition?.key, 30),
          direction: text(condition?.direction, 20) || null,
          price: roundedPrice(condition?.price),
          expected: condition?.expected === true,
          actual: condition?.actual === true,
          status: text(condition?.status, 20),
          strict: condition?.strict !== false,
        }))
        .filter((condition) => condition.key),
      allMet: source.review?.allMet === true,
    },
  }
}

export function priceMatchesAdviceContract(advice, key, price) {
  const level = advicePriceLevel(advice, key)
  const candidate = roundedPrice(price)
  if (!level || candidate == null) return false
  return candidate === roundedPrice(level.price)
}
