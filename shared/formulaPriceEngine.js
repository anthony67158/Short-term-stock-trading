export const FORMULA_PRICE_SCHEMA_VERSION = 'formula-price-decision.v1'

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function price(value) {
  const number = finite(value)
  return number != null && number > 0 ? +number.toFixed(2) : null
}

function withinLegalBand(value, quote = {}) {
  const current = price(value)
  if (current == null) return false
  const lower = price(quote.limitDownPrice)
  const upper = price(quote.limitUpPrice)
  return (
    (lower == null || current >= lower)
    && (upper == null || current <= upper)
  )
}

function emptyDecision(input, blockers = []) {
  return {
    schemaVersion: FORMULA_PRICE_SCHEMA_VERSION,
    code: String(input.code || ''),
    formulaId: null,
    positionMode: String(input.positionMode || 'UNOWNED'),
    action: input.positionMode === 'HELD' ? 'HOLD' : 'AVOID',
    primaryPrice: null,
    priceType: null,
    stopPrice: null,
    targetPrice: null,
    riskReward: null,
    validUntil: null,
    priceContractValid: false,
    dataComplete: input.dataComplete === true,
    dataFresh: input.dataFresh === true,
    marketAllowsRisk: input.marketAllowsRisk === true,
    hardStopTriggered: false,
    executionState: null,
    sellableQty: null,
    evidence: [],
    blockers,
  }
}

function buildUnownedDecision(input) {
  const matches = (Array.isArray(input.formulaMatches)
    ? input.formulaMatches
    : [])
    .filter((item) => item?.matched)
    .sort((left, right) =>
      Number(right.score || 0) - Number(left.score || 0),
    )
  if (!matches.length) {
    return emptyDecision(input, ['当前没有公式形成有效主路径'])
  }
  if (input.dataComplete !== true || input.dataFresh !== true) {
    return emptyDecision(input, ['关键行情不完整或已过期'])
  }
  if (input.marketAllowsRisk !== true) {
    return emptyDecision(input, ['市场或账户不允许新增风险'])
  }

  const selected = matches[0]
  const current = price(input.quote?.price)
  const primary = price(selected.anchors?.primary)
  const support = price(selected.anchors?.support)
  const resistance = price(selected.anchors?.resistance)
  const atr = finite(selected.anchors?.atr)
  const pullback = selected.priceType === 'PULLBACK_WATCH'
  const directionValid = (
    current != null
    && primary != null
    && (
      (pullback && primary <= current)
      || (!pullback && primary >= current)
    )
  )
  if (!directionValid || !withinLegalBand(primary, input.quote)) {
    return emptyDecision(input, ['公式主价位方向或合法价带不正确'])
  }

  const riskDistance = atr > 0
    ? atr * (pullback ? 0.8 : 1)
    : null
  const derivedStop = riskDistance != null
    ? price(primary - riskDistance)
    : null
  const stop = pullback
    ? derivedStop ?? (support != null ? price(support * 0.98) : null)
    : [derivedStop, support]
        .filter((value) => value != null && value < primary)
        .sort((left, right) => right - left)[0] ?? null
  const target = pullback
    ? resistance
    : stop != null
      ? price(primary + (primary - stop) * 2)
      : null
  const risk = stop != null ? primary - stop : null
  const reward = target != null ? target - primary : null
  const riskReward = risk > 0 && reward > 0
    ? +(reward / risk).toFixed(2)
    : null
  const priceContractValid = (
    stop != null
    && target != null
    && stop < primary
    && target > primary
    && withinLegalBand(stop, input.quote)
    && withinLegalBand(target, input.quote)
    && riskReward >= 1.8
  )
  if (!priceContractValid) {
    return emptyDecision(input, ['公式价位无法形成至少1.8:1的盈亏比'])
  }

  return {
    schemaVersion: FORMULA_PRICE_SCHEMA_VERSION,
    code: String(input.code || ''),
    formulaId: selected.formulaId,
    positionMode: 'UNOWNED',
    action: 'WATCH_BUY',
    primaryPrice: primary,
    priceType: selected.priceType,
    stopPrice: stop,
    targetPrice: target,
    riskReward,
    validUntil: Number(input.now) > 0
      ? Number(input.now) + 60 * 60 * 1000
      : null,
    priceContractValid,
    dataComplete: true,
    dataFresh: true,
    marketAllowsRisk: true,
    hardStopTriggered: false,
    executionState: 'OBSERVE_ONLY',
    sellableQty: null,
    evidence: [
      ...(selected.evidence || []),
      `主价位来自${selected.name || selected.formulaId}`,
    ].slice(0, 4),
    blockers: [],
  }
}

function holdingDecision(input) {
  if (input.dataComplete !== true || input.dataFresh !== true) {
    return emptyDecision(input, ['关键行情不完整或已过期'])
  }
  const current = price(input.quote?.price)
  const technicals = input.technicals || {}
  const stop = price(technicals.stopLoss)
  const support = price(technicals.support)
  const ma10 = price(technicals.ma10)
  const resistance = price(technicals.resistance)
  const atr = finite(technicals.atr)
  const highestClose = price(technicals.highestClose)
  const sellableQty = Math.max(
    0,
    Math.trunc(finite(input.t1Status?.sellableQty) || 0),
  )
  const executionState = sellableQty > 0 ? 'SELLABLE' : 'T1_LOCKED'
  const base = {
    schemaVersion: FORMULA_PRICE_SCHEMA_VERSION,
    code: String(input.code || ''),
    formulaId: 'HOLDING_RISK_POLICY',
    positionMode: 'HELD',
    stopPrice: stop,
    targetPrice: resistance,
    riskReward: null,
    validUntil: null,
    dataComplete: true,
    dataFresh: true,
    marketAllowsRisk: false,
    executionState,
    sellableQty,
    blockers: [],
  }

  if (current != null && stop != null && current <= stop) {
    return {
      ...base,
      action: 'EXIT',
      primaryPrice: stop,
      priceType: 'HARD_STOP',
      priceContractValid: withinLegalBand(stop, input.quote),
      hardStopTriggered: true,
      evidence: ['当前价已确认跌破硬止损'],
    }
  }

  const mainNow = finite(input.fund?.mainNetYi)
  const retailNow = finite(input.fund?.retailNetYi)
  const distribution = mainNow < 0 && retailNow > 0
  const belowTrend = current != null && ma10 != null && current < ma10
  if (distribution && belowTrend) {
    return {
      ...base,
      action: 'REDUCE',
      primaryPrice: current,
      priceType: 'DISTRIBUTION_REDUCE',
      priceContractValid: withinLegalBand(current, input.quote),
      hardStopTriggered: false,
      evidence: ['主力流出、小单流入且价格跌破MA10'],
    }
  }
  if (current != null && resistance != null && current >= resistance) {
    return {
      ...base,
      action: 'REDUCE',
      primaryPrice: resistance,
      priceType: 'TARGET_REDUCE',
      priceContractValid: withinLegalBand(resistance, input.quote),
      hardStopTriggered: false,
      evidence: ['价格已达到近期压力位'],
    }
  }

  const trailing = highestClose != null && atr > 0
    ? price(highestClose - atr * 2)
    : null
  const boundary = [ma10, support, trailing, stop]
    .filter((value) => value != null && (current == null || value < current))
    .sort((left, right) => right - left)[0] ?? null
  return {
    ...base,
    action: 'HOLD',
    primaryPrice: boundary,
    priceType: boundary == null ? null : 'RISK_BOUNDARY',
    priceContractValid: boundary != null
      && withinLegalBand(boundary, input.quote),
    hardStopTriggered: false,
    evidence: boundary != null
      ? ['风险边界取近期最高有效支撑']
      : [],
    blockers: boundary == null ? ['缺少合法持仓风险边界'] : [],
  }
}

export function buildFormulaPriceDecision(input = {}) {
  return String(input.positionMode || 'UNOWNED') === 'HELD'
    ? holdingDecision(input)
    : buildUnownedDecision(input)
}
