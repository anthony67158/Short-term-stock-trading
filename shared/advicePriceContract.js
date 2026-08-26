import { executionTriggerDirection } from './executionTrigger.js'

export const ADVICE_PRICE_CONTRACT_SCHEMA_VERSION =
  'advice-price-contract.v1'

const PRICE_FIELDS = Object.freeze([
  ['buyPrice', 'entry', 'ENTRY'],
  ['addPrice', 'add', 'ENTRY'],
  ['reducePrice', 'reduce', 'EXIT'],
  ['stopPrice', 'stop', 'RISK'],
  ['targetPrice', 'target', 'OBJECTIVE'],
  ['pullbackWatchPrice', 'watch_pullback', 'REVIEW_ONLY', '回踩观察'],
  ['breakoutWatchPrice', 'watch_breakout', 'REVIEW_ONLY', '突破观察'],
  ['watchPrice', 'watch', 'REVIEW_ONLY', '观察价'],
  ['leg1Price', 'leg1', 'EXECUTION'],
  ['leg2Price', 'leg2', 'EXECUTION'],
])

const OBSERVATION_KEYS = new Set([
  'watch',
  'watch_pullback',
  'watch_breakout',
])

const ROLE_DISTANCE_LIMIT_PCT = Object.freeze({
  entry: 5,
  add: 5,
  reduce: 8,
  stop: 12,
  target: 25,
  watch: 5,
  watch_pullback: 5,
  watch_breakout: 5,
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
  const all = [
    'entry', 'add', 'reduce', 'stop', 'target',
    'watch', 'watch_pullback', 'watch_breakout',
    'leg1', 'leg2',
  ]
  const lower = [
    'entry', 'add', 'stop', 'watch', 'watch_pullback', 'leg1', 'leg2',
  ]
  const upper = [
    'reduce', 'target', 'watch', 'watch_breakout', 'leg1', 'leg2',
  ]

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
  if (key === 'watch_pullback') return 'LTE'
  if (key === 'watch_breakout') return 'GTE'
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

function observationHorizonPct(atrPct) {
  return +Math.max(
    5,
    Math.min(12, (atrPct ?? 3.2) * 2.5),
  ).toFixed(2)
}

function observationDistance(price, currentPrice) {
  if (!(price > 0) || !(currentPrice > 0)) return null
  return Math.abs(price / currentPrice - 1) * 100
}

function observationIsAhead(direction, price, currentPrice) {
  if (!(currentPrice > 0)) return false
  if (direction === 'LTE') return price < currentPrice
  if (direction === 'GTE') return price > currentPrice
  return false
}

function nearestObservationAnchor(
  anchors,
  key,
  direction,
  currentPrice,
  horizonPct,
) {
  return anchors
    .filter((item) =>
      item.roles.includes(key)
      && !['quote.current', 'quote.open'].includes(item.source)
      && observationIsAhead(direction, item.price, currentPrice)
    )
    .map((item) => ({
      ...item,
      currentDistancePct: observationDistance(item.price, currentPrice),
    }))
    .filter((item) =>
      item.currentDistancePct != null
      && item.currentDistancePct >= 0.2
      && item.currentDistancePct <= horizonPct + 1e-6
    )
    .sort((left, right) =>
      left.currentDistancePct - right.currentDistancePct
    )[0] || null
}

function nearestAnchor(price, key, anchors) {
  const candidates = anchors.filter((item) => {
    if (!item.roles.includes(key)) return false
    if (
      ['entry', 'add'].includes(key)
      && ['quote.current', 'quote.open'].includes(item.source)
    ) {
      return Math.abs(price / item.price - 1) * 100 <= 0.15
    }
    return true
  })
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
  const watchHorizonPct = observationHorizonPct(atrPct)
  const anchors = collectAnchors(payload)
  const levels = []
  const issues = []

  for (const [field, key, purpose, label] of PRICE_FIELDS) {
    const price = roundedPrice(advice[field])
    if (price == null) continue
    const direction = directionFor(key, advice, action)
    const observationLevel = OBSERVATION_KEYS.has(key)
    const withinLegalBand = observationLevel || (
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
    const currentDistancePct = observationLevel
      ? observationDistance(price, currentPrice)
      : null
    const futureFacing = !observationLevel
      || observationIsAhead(direction, price, currentPrice)
    const shortTermReachable = !observationLevel
      || (
        currentDistancePct != null
        && currentDistancePct <= watchHorizonPct + 1e-6
      )
    const entryNotAboveCurrent = !['entry', 'add'].includes(key)
      || currentPrice == null
      || price <= currentPrice
    const strict = withinLegalBand
      && direction !== 'UNKNOWN'
      && evidenceBacked
      && futureFacing
      && shortTermReachable
      && entryNotAboveCurrent
    if (!withinLegalBand) issues.push(`${field}超出当日合法价带`)
    if (direction === 'UNKNOWN') issues.push(`${field}缺少明确触发方向`)
    if (!evidenceBacked) issues.push(`${field}缺少邻近行情、技术或量化锚点`)
    if (!entryNotAboveCurrent) {
      issues.push(
        `${field}高于当前价，不能作为回踩执行价；如需突破确认应使用breakoutWatchPrice`,
      )
    }
    if (observationLevel && !futureFacing) {
      issues.push(`${field}方向已经满足，不再作为未来观察条件`)
    }
    if (observationLevel && !shortTermReachable) {
      issues.push(`${field}超出短线观察范围`)
    }
    levels.push({
      key,
      field,
      purpose,
      ...(label ? { label } : {}),
      price,
      direction,
      status: levelStatus(direction, price, currentPrice),
      strict,
      currentDistancePct: currentDistancePct == null
        ? null
        : +currentDistancePct.toFixed(2),
      horizonPct: observationLevel ? watchHorizonPct : null,
      basis: nearest?.source || null,
      basisPrice: nearest?.price ?? null,
      basisDistancePct: nearest
        ? +nearest.distancePct.toFixed(2)
        : null,
      tolerancePct: +tolerancePct.toFixed(2),
    })
  }

  const waitAdvice = (
    mode === 'buy_advice'
    && (
      String(action || '').toUpperCase() === 'WATCH'
      || /观望|等待|回避|不建议|暂不/.test(
        String(advice.action || advice.stance || ''),
      )
    )
  )
  if (waitAdvice && currentPrice != null) {
    for (const spec of [{
      key: 'watch_pullback',
      field: 'pullbackWatchPrice',
      direction: 'LTE',
      label: '回踩观察',
    }, {
      key: 'watch_breakout',
      field: 'breakoutWatchPrice',
      direction: 'GTE',
      label: '突破观察',
    }]) {
      if (levels.some((level) =>
        OBSERVATION_KEYS.has(level.key)
        && level.direction === spec.direction
        && level.strict
      )) continue
      const anchor = nearestObservationAnchor(
        anchors,
        spec.key,
        spec.direction,
        currentPrice,
        watchHorizonPct,
      )
      if (!anchor) continue
      levels.push({
        ...spec,
        purpose: 'REVIEW_ONLY',
        price: anchor.price,
        status: 'PENDING',
        strict: true,
        currentDistancePct: +anchor.currentDistancePct.toFixed(2),
        horizonPct: watchHorizonPct,
        basis: anchor.source,
        basisPrice: anchor.price,
        basisDistancePct: 0,
        tolerancePct: +Math.max(
          1,
          Math.min(
            ROLE_DISTANCE_LIMIT_PCT[spec.key],
            atrPct != null
              ? atrPct * 1.5
              : ROLE_DISTANCE_LIMIT_PCT[spec.key],
          ),
        ).toFixed(2),
        derived: true,
      })
    }
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
        const entryNotAboveCurrent = currentPrice == null
          || price <= currentPrice
        return {
          key,
          price,
          strict: (
            withinLegalBand
            && evidenceBacked
            && entryNotAboveCurrent
          ),
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

  const observationLevels = levels.filter((level) =>
    OBSERVATION_KEYS.has(level.key)
    && level.strict === true
  )
  const reviewConditions = observationLevels.map((level) => ({
    key: level.key === 'watch_pullback'
      ? 'WATCH_PULLBACK'
      : level.key === 'watch_breakout'
        ? 'WATCH_BREAKOUT'
        : 'WATCH_PRICE',
    levelKey: level.key,
    direction: level.direction,
    price: level.price,
    status: level.status,
    strict: true,
  }))
  const reviewOperator = reviewConditions.length > 1 ? 'ANY' : 'ALL'

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
      operator: reviewOperator,
      conditions: reviewConditions,
      allMet: reviewConditions.length > 0
        && reviewConditions[
          reviewOperator === 'ANY' ? 'some' : 'every'
        ]((condition) =>
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

export function adviceObservationLevels(advice = {}) {
  const value = advice && typeof advice === 'object' ? advice : {}
  const contract = value.priceContract?.schemaVersion
    === ADVICE_PRICE_CONTRACT_SCHEMA_VERSION
    ? value.priceContract
    : value.decisionPlan?.priceContract?.schemaVersion
      === ADVICE_PRICE_CONTRACT_SCHEMA_VERSION
      ? value.decisionPlan.priceContract
      : null
  const currentPrice = positive(contract?.currentPrice)
  const levels = (Array.isArray(contract?.levels)
    ? contract.levels
    : [])
    .filter((level) =>
      OBSERVATION_KEYS.has(level?.key)
      && level?.strict === true
      && level?.status !== 'MET'
      && positive(level?.price) != null
      && (
        currentPrice == null
        || (
          observationIsAhead(
            level.direction,
            positive(level.price),
            currentPrice,
          )
          && (
            observationDistance(
              positive(level.price),
              currentPrice,
            ) <= (
              positive(level.horizonPct)
              ?? observationHorizonPct(null)
            ) + 1e-6
          )
        )
      )
    )
    .map((level) => ({
      ...level,
      label: text(
        level.label
        || (
          level.key === 'watch_pullback'
            ? '回踩观察'
            : level.key === 'watch_breakout'
              ? '突破观察'
              : level.direction === 'LTE'
                ? '回踩观察'
                : '突破观察'
        ),
        30,
      ),
    }))
  const seen = new Set()
  return levels.filter((level) => {
    const identity = `${level.direction}:${roundedPrice(level.price)}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
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
        label: text(level?.label, 30) || null,
        price: roundedPrice(level?.price),
        direction: text(level?.direction, 20),
        status: text(level?.status, 20),
        strict: level?.strict === true,
        currentDistancePct: finite(level?.currentDistancePct),
        horizonPct: finite(level?.horizonPct),
        basis: text(level?.basis, 80) || null,
        basisPrice: roundedPrice(level?.basisPrice),
        basisDistancePct: finite(level?.basisDistancePct),
        tolerancePct: finite(level?.tolerancePct),
        derived: level?.derived === true,
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
      operator: source.review?.operator === 'ANY' ? 'ANY' : 'ALL',
      conditions: (Array.isArray(source.review?.conditions)
        ? source.review.conditions
        : [])
        .map((condition) => ({
          key: text(condition?.key, 30),
          levelKey: text(condition?.levelKey, 30) || null,
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
