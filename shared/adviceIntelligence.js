import { reviewPriceMateriality } from './adviceReviewRisk.js'
import { sanitizedAdvicePriceContract } from './advicePriceContract.js'

export const ADVICE_REVIEW_EVENT_VERSION =
  'advice-review-event.v1'

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
  const tactical = evidence.decisionSignals?.tactical || {}
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
    },
    technical: {
      maTrend: text(indicators.maTrend, 30),
      maCross: text(indicators.maCross, 30),
      atr: rounded(atrValue(indicators.atr), 0.01),
      rsi: rounded(indicators.rsi, 5),
      macdHistSign: sign(
        indicators.macdDetail?.hist
        ?? indicators.macd?.hist
        ?? indicators.macd?.macd,
      ),
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
    tactical: {
      horizon: text(tactical.horizon, 30),
      marketPhase: text(tactical.market?.phase, 30),
      marketRiskTone: text(tactical.market?.riskTone, 30),
      sectorState: text(tactical.sector?.state, 30),
      stockRole: text(tactical.sector?.stockRole, 30),
      location: text(tactical.stock?.location, 30),
      crowdingRisk: text(tactical.stock?.crowdingRisk, 30),
      flowRelation: text(tactical.flow?.relation, 30),
      timingState: text(tactical.timing?.state, 30),
      catalystFreshness: text(tactical.catalyst?.freshness, 30),
      catalystRisk: text(tactical.catalyst?.risk, 30),
      highConfidence: tactical.quant?.highConfidence === true,
      conflicts: (Array.isArray(tactical.conflicts)
        ? tactical.conflicts
        : []).map((item) => text(item, 80)).slice(0, 4),
    },
  }
}

function positionBand(value) {
  const number = finite(value)
  if (number == null) return 'UNKNOWN'
  if (number <= 30) return 'LOW'
  if (number >= 70) return 'HIGH'
  return 'MID'
}

function addReviewEvent(events, {
  kind,
  priority,
  reason,
  requiresLlm = false,
  deterministicAction = '',
}) {
  if (events.some((item) => item.kind === kind)) return
  events.push({
    schemaVersion: ADVICE_REVIEW_EVENT_VERSION,
    kind,
    priority,
    reason: text(reason, 180),
    requiresLlm,
    deterministicAction: text(deterministicAction, 50),
  })
}

export function buildAdviceReviewEventQueue({
  previousDigest,
  currentDigest,
  snapshot,
  previousAdvice,
} = {}) {
  if (!previousDigest || !currentDigest) return []
  const events = []
  const nearPrice = nearExecutionPrice(snapshot, previousAdvice)
  const priceChange = reviewPriceMateriality({
    previous: previousDigest,
    current: currentDigest,
    previousAdvice,
  })
  if (priceChange.changed) {
    addReviewEvent(events, {
      kind: 'PRICE_LEVEL',
      priority: 1,
      reason: priceChange.reason,
      requiresLlm: true,
      deterministicAction: /止损/.test(priceChange.reason)
        ? 'HARD_STOP_CHECK'
        : /目标|减仓/.test(priceChange.reason)
          ? 'PROFIT_PROTECTION'
          : 'PRICE_REVIEW',
    })
  }

  const previousStructure = {
    vsVwap: previousDigest.technical?.vsVwap,
    posBand: positionBand(previousDigest.technical?.posInDay),
    macdHistSign: previousDigest.technical?.macdHistSign,
    maCross: previousDigest.technical?.maCross,
  }
  const currentStructure = {
    vsVwap: currentDigest.technical?.vsVwap,
    posBand: positionBand(currentDigest.technical?.posInDay),
    macdHistSign: currentDigest.technical?.macdHistSign,
    maCross: currentDigest.technical?.maCross,
  }
  if (
    JSON.stringify(previousStructure)
    !== JSON.stringify(currentStructure)
  ) {
    addReviewEvent(events, {
      kind: 'FIVE_MINUTE_STRUCTURE',
      priority: 3,
      reason: '完整5分钟结构或均价线位置发生变化',
      requiresLlm: nearPrice,
      deterministicAction: 'STRUCTURE_RECHECK',
    })
  }

  const previousSector = {
    state: previousDigest.tactical?.sectorState
      || previousDigest.sector?.actionability,
    role: previousDigest.tactical?.stockRole
      || previousDigest.sector?.role,
  }
  const currentSector = {
    state: currentDigest.tactical?.sectorState
      || currentDigest.sector?.actionability,
    role: currentDigest.tactical?.stockRole
      || currentDigest.sector?.role,
  }
  if (JSON.stringify(previousSector) !== JSON.stringify(currentSector)) {
    addReviewEvent(events, {
      kind: 'SECTOR_ROLE',
      priority: 2,
      reason: '板块状态或个股前排资格发生变化',
      requiresLlm: nearPrice,
      deterministicAction:
        currentSector.state === 'WEAKENING'
        || currentSector.role === 'LAGGARD'
          ? 'STRUCTURAL_EXIT_CHECK'
          : 'SECTOR_RECHECK',
    })
  }

  const previousFlow = previousDigest.tactical?.flowRelation
    || previousDigest.funds?.retailRelation
  const currentFlow = currentDigest.tactical?.flowRelation
    || currentDigest.funds?.retailRelation
  if (previousFlow !== currentFlow) {
    addReviewEvent(events, {
      kind: 'FUND_FLOW_RELATION',
      priority: 2,
      reason: '主力与小单资金关系发生反转',
      requiresLlm: nearPrice,
      deterministicAction:
        currentFlow === 'DISTRIBUTION'
        || currentFlow === 'main_out_retail_in'
          ? 'STRUCTURAL_EXIT_CHECK'
          : 'FLOW_RECHECK',
    })
  }

  const previousQuant = {
    direction: previousDigest.quant?.direction,
    highConfidence: previousDigest.tactical?.highConfidence
      ?? previousDigest.quant?.highConfFired,
  }
  const currentQuant = {
    direction: currentDigest.quant?.direction,
    highConfidence: currentDigest.tactical?.highConfidence
      ?? currentDigest.quant?.highConfFired,
  }
  if (JSON.stringify(previousQuant) !== JSON.stringify(currentQuant)) {
    addReviewEvent(events, {
      kind: 'QUANT_CONFIDENCE',
      priority: 3,
      reason: '量化方向或高把握状态发生变化',
      requiresLlm: true,
      deterministicAction: 'QUANT_RECHECK',
    })
  }

  const previousTactical = {
    timingState: previousDigest.tactical?.timingState,
    location: previousDigest.tactical?.location,
    crowdingRisk: previousDigest.tactical?.crowdingRisk,
    conflicts: previousDigest.tactical?.conflicts,
  }
  const currentTactical = {
    timingState: currentDigest.tactical?.timingState,
    location: currentDigest.tactical?.location,
    crowdingRisk: currentDigest.tactical?.crowdingRisk,
    conflicts: currentDigest.tactical?.conflicts,
  }
  if (
    JSON.stringify(previousTactical)
    !== JSON.stringify(currentTactical)
  ) {
    addReviewEvent(events, {
      kind: 'TACTICAL_STATE',
      priority: 2,
      reason: '短线战术状态发生变化',
      requiresLlm: true,
      deterministicAction: 'TACTICAL_RECHECK',
    })
  }

  if (
    previousDigest.tactical?.marketPhase
    !== currentDigest.tactical?.marketPhase
  ) {
    addReviewEvent(events, {
      kind: 'SESSION_BOUNDARY',
      priority: 4,
      reason: '交易时段边界发生变化',
      requiresLlm: true,
      deterministicAction: 'SESSION_RECHECK',
    })
  }

  if (
    JSON.stringify(previousDigest.account)
    !== JSON.stringify(currentDigest.account)
  ) {
    addReviewEvent(events, {
      kind: 'ACCOUNT_CHANGED',
      priority: 1,
      reason: '持仓、可卖数量或账户风险预算发生变化',
      requiresLlm: true,
      deterministicAction: 'ACCOUNT_RECOMPILE',
    })
  }

  if (
    JSON.stringify(previousDigest.news?.companyAnnouncements)
    !== JSON.stringify(currentDigest.news?.companyAnnouncements)
    || previousDigest.resonance?.hasNegNews !== true
      && currentDigest.resonance?.hasNegNews === true
  ) {
    addReviewEvent(events, {
      kind: 'MATERIAL_NEWS',
      priority: 1,
      reason: '公司公告或重大风险消息发生变化',
      requiresLlm: true,
      deterministicAction: 'NEWS_RECHECK',
    })
  }

  return events.sort((left, right) =>
    left.priority - right.priority
    || left.kind.localeCompare(right.kind),
  )
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
    advice?.pullbackWatchPrice,
    advice?.breakoutWatchPrice,
    advice?.watchPrice,
    advice?.reducePrice,
    advice?.stopPrice,
    advice?.targetPrice,
  ].map(finite).filter((item) => item != null)
  return [...new Set([...contractPrices, ...fallbackPrices])]
    .some((level) => Math.abs(price - level) <= threshold)
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
  const events = previousDigest
    ? buildAdviceReviewEventQueue({
        previousDigest,
        currentDigest,
        snapshot,
        previousAdvice,
      })
    : []
  if (previousDigest && !events.length) {
    return {
      shouldRunLLM: false,
      disposition: 'unchanged',
      reason: '关键证据无实质变化',
    }
  }
  const firstEvent = events[0]
  const llmEvent = events.find((event) => event.requiresLlm)
  if (previousDigest && !llmEvent) {
    return {
      shouldRunLLM: false,
      disposition: 'unchanged',
      reason: `${firstEvent?.reason || '证据有变化'}，未触发执行价或风险事件`,
    }
  }
  return {
    shouldRunLLM: true,
    disposition: previousDigest ? 'material-change' : 'full-review',
    reason: previousDigest
      ? llmEvent?.reason || firstEvent?.reason
      : '缺少上一版证据摘要',
  }
}

export function buildReviewReceipt({
  previousDigest = null,
  snapshot = null,
  previousAdvice = null,
  evaluation = null,
} = {}) {
  const current = adviceEvidenceDigest(snapshot || {})
  const eventQueue = buildAdviceReviewEventQueue({
    previousDigest,
    currentDigest: current,
    snapshot,
    previousAdvice,
  })
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
    eventQueue,
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
