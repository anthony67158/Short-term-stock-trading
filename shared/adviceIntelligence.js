import { reviewPriceMateriality } from './adviceReviewRisk.js'

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, step) {
  const number = finite(value)
  return number == null ? null : Math.round(number / step) * step
}

function sign(value) {
  const number = finite(value)
  return number == null ? null : number > 0 ? 1 : number < 0 ? -1 : 0
}

function atrValue(value) {
  return finite(value?.atr ?? value)
}

function text(value, max = 80) {
  return String(value || '').trim().slice(0, max)
}

function newsTitles(headlines) {
  return (Array.isArray(headlines) ? headlines : [])
    .map((item) => text(
      typeof item === 'string' ? item : item?.title,
      80,
    ))
    .filter(Boolean)
    .sort()
    .slice(0, 6)
}

export function adviceEvidenceDigest(snapshot = {}) {
  const evidence = snapshot?.evidence || {}
  const quote = evidence.quote || {}
  const market = evidence.market?.environment || {}
  const technical = evidence.technical || {}
  const indicators = technical.indicators || {}
  const intraday = technical.intraday || {}
  const funds = evidence.funds || {}
  const quant = evidence.quant || {}
  const forecast = quant.forecast || {}
  const resonance = evidence.decisionSignals?.resonance || {}
  const account = snapshot?.account || {}
  return {
    account: {
      holdQty: finite(account.holdQty),
      sellableTodayQty: finite(account.sellableTodayQty),
      stockWeight: rounded(account.stockWeight, 2),
      cashReservePct: rounded(account.cashReservePct, 5),
    },
    quote: {
      price: finite(quote.price),
      pct: rounded(quote.pct, 0.2),
    },
    market: {
      score: rounded(market.score, 5),
      level: text(market.level, 30),
      upDownRatio: rounded(evidence.market?.breadth?.upDownRatio, 0.1),
      limitUp: rounded(evidence.market?.breadth?.limitUp, 5),
      limitDown: rounded(evidence.market?.breadth?.limitDown, 5),
      volLevel: text(evidence.market?.breadth?.volLevel, 30),
    },
    technical: {
      maTrend: text(indicators.maTrend, 30),
      maCross: text(indicators.maCross, 30),
      atr: rounded(atrValue(indicators.atr), 0.01),
      rsi: rounded(indicators.rsi, 5),
      macdHistSign: sign(indicators.macd?.hist),
      bollPctB: rounded(indicators.boll?.pctB, 10),
      vsVwap: text(intraday.vsVwap, 40),
      posInDay: rounded(intraday.posInDay, 10),
    },
    funds: {
      mainNetSign: sign(funds.mainNetYi),
      mainNetYi: rounded(funds.mainNetYi, 0.2),
      main5dSign: sign(funds.main5dYi),
      main5dYi: rounded(funds.main5dYi, 0.5),
      mainStreak: finite(funds.mainStreak),
    },
    quant: {
      score: rounded(quant.score, 3),
      bias: text(quant.bias, 30),
      direction: text(forecast.direction, 30),
      upProb: rounded(forecast.upProb, 5),
      highConfFired: quant.highConfSignal?.fired === true,
    },
    news: {
      headlines: newsTitles(evidence.news?.headlines),
      macro: newsTitles(evidence.news?.macro),
      industry: newsTitles(evidence.news?.industry),
      flashes: newsTitles(evidence.news?.flashes),
    },
    resonance: {
      score: finite(resonance.score),
      hasNegNews: resonance.hasNegNews === true,
    },
  }
}

function materialChange(previous, current, previousAdvice) {
  const priceChange = reviewPriceMateriality({
    previous,
    current,
    previousAdvice,
  })
  if (priceChange.changed) return priceChange
  const withoutPrice = (value) => JSON.stringify({
    ...value,
    quote: {
      ...value?.quote,
      price: null,
      pct: null,
    },
  })
  if (withoutPrice(previous) !== withoutPrice(current)) {
    return {
      changed: true,
      reason: '资金、技术、量化或消息证据发生实质变化',
    }
  }
  return { changed: false, reason: '' }
}

export function evaluateScheduledReview({
  origin,
  previousDigest,
  snapshot,
  hasPreviousAdvice,
  previousAdvice,
} = {}) {
  if (origin !== 'auto') {
    return {
      shouldRunLLM: true,
      disposition: 'full-review',
      reason: '手动复核',
    }
  }
  if (snapshot?.freshness?.status === 'PARTIAL') {
    const missing = (snapshot.freshness.missingSources || []).join('、') || 'unknown'
    return {
      shouldRunLLM: false,
      disposition: 'insufficient',
      reason: `关键证据缺失：${missing}`,
    }
  }
  if (!hasPreviousAdvice) {
    return {
      shouldRunLLM: true,
      disposition: 'full-review',
      reason: '首次自动复核',
    }
  }
  const currentDigest = adviceEvidenceDigest(snapshot)
  const change = previousDigest
    ? materialChange(previousDigest, currentDigest, previousAdvice)
    : { changed: true, reason: '缺少上一版证据摘要' }
  if (previousDigest && !change.changed) {
    return {
      shouldRunLLM: false,
      disposition: 'unchanged',
      reason: '关键证据无实质变化',
    }
  }
  return {
    shouldRunLLM: true,
    disposition: previousDigest ? 'material-change' : 'full-review',
    reason: change.reason,
  }
}

export function adviceTrustBands(stats = {}) {
  return (Array.isArray(stats?.byTrust) ? stats.byTrust : [])
    .map((item) => ({
      band: text(item?.band, 20),
      total: Number(item?.total) || 0,
      winRate: finite(item?.winRate),
      avgPct: finite(item?.avgPct),
    }))
    .filter((item) => item.band)
}

function trustBand(score) {
  return score >= 68 ? 'high' : score >= 48 ? 'mid' : 'low'
}

export function calibrateAdviceTrust(rawScore, history = []) {
  const raw = Math.max(15, Math.min(95, Math.round(finite(rawScore) ?? 50)))
  const band = trustBand(raw)
  const sample = (Array.isArray(history) ? history : [])
    .find((item) => item?.band === band && Number(item.total) >= 8)
  if (!sample || !Number.isFinite(Number(sample.winRate))) {
    return {
      score: raw,
      calibrated: false,
      sampleSize: Number(sample?.total) || 0,
      historicalWinRate: null,
    }
  }
  const total = Number(sample.total)
  const winRate = Math.max(0, Math.min(100, Number(sample.winRate)))
  const weight = Math.min(0.4, 0.15 + total / 100)
  let score = Math.round(raw * (1 - weight) + winRate * weight)
  if (Number(sample.avgPct) < 0) score -= 4
  if (band === 'high' && winRate < 50) score = Math.min(score, 60)
  score = Math.max(15, Math.min(95, score))
  return {
    score,
    calibrated: true,
    sampleSize: total,
    historicalWinRate: winRate,
  }
}

export function prioritizeAdviceReviewCodes({
  codes = [],
  holdingCodes = [],
  starredCodes = [],
  alerts = [],
  advice = {},
  now = Date.now(),
} = {}) {
  const holding = new Set(holdingCodes.map(String))
  const starred = new Set(starredCodes.map(String))
  const watching = new Set(
    alerts
      .filter((alert) => alert?.enabled && alert.phase === 'watching')
      .map((alert) => String(alert.code || '')),
  )
  const priority = (code) => {
    const nextReviewAt = Number(
      advice?.[code]?.reviewCycle?.nextReviewAt
        ?? advice?.[code]?.advice?.reviewCycle?.nextReviewAt,
    )
    const overdue = Number.isFinite(nextReviewAt)
      ? Math.max(0, Number(now) - nextReviewAt)
      : 0
    return (watching.has(code) ? 1000000 : 0)
      + (holding.has(code) ? 100000 : 0)
      + (starred.has(code) ? 10000 : 0)
      + Math.min(9999, Math.floor(overdue / 1000))
  }
  return [...new Set(codes.map(String).filter(Boolean))]
    .map((code, index) => ({ code, index, priority: priority(code) }))
    .sort((left, right) =>
      (right.priority - left.priority) || (left.index - right.index)
    )
    .map((item) => item.code)
}
