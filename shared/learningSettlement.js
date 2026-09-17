function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function day(value) {
  return String(value || '').slice(0, 10)
}

function price(row, key) {
  return finite(row?.[key])
}

export function settleStockPickCandidate({
  prediction,
  candidate,
  bars = [],
  evaluatedAt = Date.now(),
} = {}) {
  const tradeDate = day(prediction?.tradeDate)
  const referencePrice = finite(candidate?.price)
  const future = (Array.isArray(bars) ? bars : [])
    .filter((bar) => day(bar?.date ?? bar?.tradeDate) > tradeDate)
    .sort((left, right) =>
      day(left?.date ?? left?.tradeDate)
        .localeCompare(day(right?.date ?? right?.tradeDate))
    )
    .slice(0, 5)
  if (!(referencePrice > 0) || future.length < 5) {
    return {
      maturity: 'PENDING',
      reasonCode: !(referencePrice > 0)
        ? 'REFERENCE_PRICE_MISSING'
        : 'T5_NOT_MATURED',
      observedTradingDays: future.length,
      evaluatedAt,
    }
  }
  const closes = future
    .map((bar) => price(bar, 'close'))
    .filter((value) => value > 0)
  const highs = future
    .map((bar) => price(bar, 'high') ?? price(bar, 'close'))
    .filter((value) => value > 0)
  const lows = future
    .map((bar) => price(bar, 'low') ?? price(bar, 'close'))
    .filter((value) => value > 0)
  if (closes.length < 5 || !highs.length || !lows.length) {
    return {
      maturity: 'PENDING',
      reasonCode: 'MARKET_PATH_INCOMPLETE',
      observedTradingDays: closes.length,
      evaluatedAt,
    }
  }
  const close = closes.at(-1)
  const returnPct = (close / referencePrice - 1) * 100
  const mfePct = (Math.max(...highs) / referencePrice - 1) * 100
  const maePct = (Math.min(...lows) / referencePrice - 1) * 100
  return {
    maturity: 'MATURED',
    horizonTradingDays: 5,
    targetDate: day(
      future.at(-1)?.date ?? future.at(-1)?.tradeDate,
    ),
    referencePrice,
    closePrice: close,
    returnPct: +returnPct.toFixed(4),
    mfePct: +mfePct.toFixed(4),
    maePct: +maePct.toFixed(4),
    directionHit: returnPct > 0,
    positive2PctHit: mfePct >= 2,
    evaluatedAt,
  }
}

export function positionOutcomeFromAttribution(attribution = {}) {
  if (
    attribution.validationComplete !== true
    || attribution.learningEligible !== true
    || !attribution.planId
  ) return null
  return {
    planId: String(attribution.planId),
    decisionId: String(attribution.decisionId || ''),
    code: String(attribution.code || ''),
    action: String(attribution.action || ''),
    side: String(attribution.side || ''),
    status: String(attribution.status || ''),
    filledLots: finite(attribution.filledLots),
    fillRatePct: finite(attribution.fillRatePct),
    totalFees: finite(attribution.totalFees),
    netPnl: finite(attribution.netPnl),
    plannedExpectedNetR: finite(attribution.plannedExpectedNetR),
    realizedNetR: finite(attribution.realizedNetR),
    expectancyErrorR: finite(attribution.expectancyErrorR),
    holdingDurationMinutes: finite(attribution.holdingDurationMinutes),
    mfePct: finite(attribution.mfePct),
    maePct: finite(attribution.maePct),
    profitCapturePct: finite(attribution.profitCapturePct),
  }
}
