import { reviewPriceMateriality } from './adviceReviewRisk.js'
import { sanitizedAdvicePriceContract } from './advicePriceContract.js'

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

function companyAnnouncements(headlines) {
  return newsTitles(headlines)
    .filter((title) => /^\[公司公告\]/.test(title))
    .slice(0, 4)
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
  const strategyGate = snapshot?.policy?.strategyGate || null
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
      main5dSign: sign(funds.main5dYi),
      mainStreakBand: finite(funds.mainStreak) == null
        ? null
        : Math.max(-2, Math.min(2, Math.sign(finite(funds.mainStreak)))),
      retailNetSign: sign(funds.retailNetYi ?? funds.smallNetYi),
      retailRelation: text(funds.retailFlow?.relation, 40),
    },
    quant: {
      scoreBand: finite(quant.score) == null
        ? null
        : Math.round(finite(quant.score) / 10),
      bias: text(quant.bias, 30),
      direction: text(forecast.direction, 30),
      upProbBand: finite(forecast.upProb) == null
        ? null
        : Math.round(finite(forecast.upProb) / 10),
      highConfFired: quant.highConfSignal?.fired === true,
    },
    news: {
      companyAnnouncements: companyAnnouncements(
        evidence.news?.headlines,
      ),
    },
    resonance: {
      score: finite(resonance.score),
      hasNegNews: resonance.hasNegNews === true,
    },
    sector: {
      matched:
        evidence.decisionSignals?.sectorOpportunity?.matched === true,
      probeEligible:
        evidence.decisionSignals?.sectorOpportunity?.probeEligible === true,
      actionability: text(
        evidence.decisionSignals?.sectorOpportunity?.sector
          ?.actionability,
        30,
      ),
      role: text(
        evidence.decisionSignals?.sectorOpportunity?.stock?.role,
        30,
      ),
      score: rounded(
        evidence.decisionSignals?.sectorOpportunity?.stock?.score,
        5,
      ),
      mainInflowSign: sign(
        evidence.decisionSignals?.sectorOpportunity?.stock?.mainInflow,
      ),
    },
    ...(strategyGate ? {
      policy: {
        strategyGate: {
          specVersion: text(strategyGate.specVersion, 120),
          productionEligible:
            strategyGate.productionEligible === true,
          decision: text(strategyGate.decision, 30),
          blockerCodes: (Array.isArray(strategyGate.blockerCodes)
            ? strategyGate.blockerCodes
            : [])
            .map((item) => text(item, 80))
            .filter(Boolean)
            .sort(),
        },
      },
    } : {}),
  }
}

function materialChange(previous, current, previousAdvice) {
  const priceChange = reviewPriceMateriality({
    previous,
    current,
    previousAdvice,
  })
  if (priceChange.changed) return { ...priceChange, kind: 'price' }
  if (
    previous?.policy?.strategyGate
    && current?.policy?.strategyGate
    && JSON.stringify(previous.policy.strategyGate)
      !== JSON.stringify(current.policy.strategyGate)
  ) {
    return {
      changed: true,
      kind: 'policy',
      reason: '策略审核状态发生变化',
    }
  }
  if (JSON.stringify(previous?.sector) !== JSON.stringify(current?.sector)) {
    return {
      changed: true,
      kind: 'sector',
      reason: '板块方向或个股前排资格发生变化',
    }
  }
  if (JSON.stringify(previous?.funds) !== JSON.stringify(current?.funds)) {
    return {
      changed: true,
      kind: 'funds',
      reason: '主力与小单资金结构发生变化',
    }
  }
  if (JSON.stringify(previous?.quant) !== JSON.stringify(current?.quant)) {
    return {
      changed: true,
      kind: 'quant',
      reason: '量化方向或把握度发生变化',
    }
  }
  const withoutPrice = (value) => JSON.stringify({
    ...value,
    quote: {
      ...value?.quote,
      price: null,
      pct: null,
    },
    sector: null,
    funds: null,
    quant: null,
  })
  if (withoutPrice(previous) !== withoutPrice(current)) {
    return {
      changed: true,
      kind: 'context',
      reason: '资金、技术、量化或消息证据发生实质变化',
    }
  }
  return { changed: false, kind: '', reason: '' }
}

function nearExecutionPrice(snapshot, advice) {
  const price = finite(snapshot?.evidence?.quote?.price)
  if (!(price > 0)) return false
  const atr = finite(
    snapshot?.evidence?.technical?.indicators?.atr?.atr
    ?? snapshot?.evidence?.technical?.indicators?.atr,
  )
  const threshold = Math.max(price * 0.008, (atr || 0) * 0.75)
  const contractPrices = (advice?.priceContract?.levels || [])
    .map((item) => finite(item?.price))
    .filter((item) => item != null)
  const fallbackPrices = [
    advice?.addPrice,
    advice?.buyPrice,
    advice?.watchPrice,
    advice?.reducePrice,
    advice?.stopPrice,
    advice?.targetPrice,
  ].map(finite).filter((item) => item != null)
  return [...new Set([...contractPrices, ...fallbackPrices])]
    .some((level) => Math.abs(price - level) <= threshold)
}

function hardNegativeShift(previous, current) {
  return previous?.resonance?.hasNegNews !== true
    && current?.resonance?.hasNegNews === true
    && Number(current?.resonance?.score) <= 1
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
  if (
    previousAdvice
    && !sanitizedAdvicePriceContract(previousAdvice)
  ) {
    return {
      shouldRunLLM: true,
      disposition: 'material-change',
      reason: '旧建议缺少已验证价格契约',
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
  if (
    previousDigest
    && !['price', 'policy'].includes(change.kind)
    && !nearExecutionPrice(snapshot, previousAdvice)
    && !hardNegativeShift(previousDigest, currentDigest)
  ) {
    return {
      shouldRunLLM: false,
      disposition: 'unchanged',
      reason: `${change.reason}，未触发执行价或风险事件`,
    }
  }
  return {
    shouldRunLLM: true,
    disposition: previousDigest ? 'material-change' : 'full-review',
    reason: change.reason,
  }
}

export function buildReviewReceipt({
  previousDigest = null,
  snapshot = null,
  previousAdvice = null,
  evaluation = null,
} = {}) {
  const current = adviceEvidenceDigest(snapshot || {})
  const checked = [
    '价格与执行价',
    '主力与小单资金',
    '板块与前排资格',
    '量化方向',
    '技术结构',
    '账户约束',
  ]
  const changes = []
  if (previousDigest) {
    const price = reviewPriceMateriality({
      previous: previousDigest,
      current,
      previousAdvice,
    })
    if (price.changed) changes.push('价格或执行价触发')
    if (JSON.stringify(previousDigest.funds) !== JSON.stringify(current.funds)) {
      changes.push('主力与小单资金结构变化')
    }
    if (JSON.stringify(previousDigest.sector) !== JSON.stringify(current.sector)) {
      changes.push('板块方向或前排资格变化')
    }
    if (JSON.stringify(previousDigest.quant) !== JSON.stringify(current.quant)) {
      changes.push('量化方向或把握度变化')
    }
    if (JSON.stringify(previousDigest.technical) !== JSON.stringify(current.technical)) {
      changes.push('技术结构变化')
    }
    if (JSON.stringify(previousDigest.account) !== JSON.stringify(current.account)) {
      changes.push('账户约束变化')
    }
    if (
      JSON.stringify(previousDigest.news?.companyAnnouncements)
      !== JSON.stringify(current.news?.companyAnnouncements)
    ) {
      changes.push('公司公告更新')
    }
  }
  const reason = text(evaluation?.reason, 160)
  return {
    checked,
    changes: changes.slice(0, 4),
    summary: reason
      || (changes.length
        ? changes.slice(0, 2).join('、')
        : '关键交易条件未发生实质变化'),
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
