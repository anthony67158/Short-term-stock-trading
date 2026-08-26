import {
  adviceObservationLevels,
  buildAdvicePriceContract,
} from './advicePriceContract.js'
import {
  V21_EXPERIMENTAL_RELIABILITY,
} from './modelVersion.js'

export const SHORT_HORIZON_TACTICAL_VERSION =
  'short-horizon-tactical.v1'
export const SHORT_HORIZON_ACTION_POLICY_VERSION =
  'short-horizon-action-policy.v1'

const clamp = (value, low = 0, high = 100) =>
  Math.max(low, Math.min(high, value))

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 1) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function text(value, maximum = 80) {
  return String(value || '').trim().slice(0, maximum)
}

function phaseOf(payload = {}) {
  const value = text(
    payload.todayQuote?.phase
    || payload.marketPhase,
    40,
  )
  if (/盘前|集合竞价/.test(value)) return 'PREOPEN'
  if (/开盘|早盘/.test(value)) return 'OPENING'
  if (/上午|午前/.test(value)) return 'MORNING'
  if (/午间|午休/.test(value)) return 'NOON'
  if (/下午|午后/.test(value)) return 'AFTERNOON'
  if (/收盘|盘后/.test(value)) return 'CLOSE'
  if (/休市/.test(value)) return 'OFF_HOURS'
  return payload.todayQuote?.live === true ? 'MORNING' : 'OFF_HOURS'
}

function riskToneOf(market = {}) {
  const score = finite(market.score)
  if (
    market.weak === true
    || market.allowRiskIncrease === false
    || score != null && score < 35
  ) return 'RISK_OFF'
  if (
    market.allowRiskIncrease === true
    && score != null
    && score >= 65
  ) return 'RISK_ON'
  if (score != null || market.level) return 'BALANCED'
  return 'UNKNOWN'
}

function stockRoleOf(opportunity = {}) {
  const value = text(
    opportunity.stock?.role
    || opportunity.stock?.roleLabel,
    40,
  )
  if (/龙头|领涨|核心/.test(value)) return 'LEADER'
  if (/前排|强势/.test(value)) return 'FRONT_ROW'
  if (/跟随|补涨/.test(value)) return 'FOLLOWER'
  if (/后排|掉队|弱势/.test(value)) return 'LAGGARD'
  return 'UNKNOWN'
}

function sectorStateOf(opportunity = {}, role) {
  if (opportunity.matched !== true) return 'UNKNOWN'
  const value = text(opportunity.sector?.actionability, 50)
  if (/转弱|回避|卖|退出|不可/.test(value) || role === 'LAGGARD') {
    return 'WEAKENING'
  }
  if (/背离|分化/.test(value)) return 'DIVERGING'
  if (/可买|进攻|领涨|强/.test(value) && role === 'LEADER') {
    return 'LEADING'
  }
  if (/可买|关注|确认|持有|LAYOUT|BUYABLE|WATCH|HOLD/i.test(value)) {
    return 'CONFIRMING'
  }
  return 'UNKNOWN'
}

function locationOf(payload = {}) {
  const quote = payload.todayQuote || {}
  const intraday = payload.intraday || {}
  const tech = payload.tech || {}
  const pct = finite(quote.pct)
  const position = finite(intraday.posInDay)
  const rsi = finite(tech.rsi)
  if (
    quote.isLimitUp === true
    || pct != null && pct >= 8.5
    || position != null && position >= 90
    || rsi != null && rsi >= 78
  ) return 'EXTENDED'
  if (position != null && position >= 70) return 'HIGH'
  if (position != null && position <= 30) return 'LOW'
  return position != null ? 'MID' : 'UNKNOWN'
}

function liquidityOf(payload = {}) {
  const amount = finite(
    payload.todayQuote?.amount
    ?? payload.liquidity?.amount,
  )
  const adv20 = finite(payload.liquidity?.adv20)
  if (amount != null && amount >= 1e8) return 'GOOD'
  if (adv20 != null && adv20 >= 1e8) return 'GOOD'
  if (amount != null || adv20 != null) return 'LIMITED'
  return 'UNKNOWN'
}

function crowdingRiskOf(payload = {}, location) {
  const quote = payload.todayQuote || {}
  const pct = finite(quote.pct)
  const turnover = finite(quote.turnover)
  const volRatio = finite(quote.volRatio)
  if (
    location === 'EXTENDED'
    || quote.isLimitUp === true
    || turnover != null && turnover >= 18
    || volRatio != null && volRatio >= 5
  ) return 'HIGH'
  if (
    location === 'HIGH'
    || pct != null && pct >= 5
    || turnover != null && turnover >= 10
    || volRatio != null && volRatio >= 3
  ) return 'MEDIUM'
  return pct != null || turnover != null || volRatio != null
    ? 'LOW'
    : 'UNKNOWN'
}

function flowDirection(value) {
  const number = finite(value)
  if (number == null) return 'UNKNOWN'
  if (number > 0.01) return 'INFLOW'
  if (number < -0.01) return 'OUTFLOW'
  return 'FLAT'
}

function flowRelation(mainDirection, retailDirection) {
  if (
    mainDirection === 'INFLOW'
    && retailDirection === 'OUTFLOW'
  ) return 'ACCUMULATION'
  if (
    mainDirection === 'OUTFLOW'
    && retailDirection === 'INFLOW'
  ) return 'DISTRIBUTION'
  if (
    mainDirection === retailDirection
    && ['INFLOW', 'OUTFLOW'].includes(mainDirection)
  ) return 'CONSENSUS'
  if (
    mainDirection !== 'UNKNOWN'
    && retailDirection !== 'UNKNOWN'
  ) return 'DIVERGENCE'
  return 'UNKNOWN'
}

function relativeStrengthOf(payload = {}, role, relation) {
  const quote = payload.todayQuote || {}
  const quantScore = finite(payload.quant?.score)
  const opportunityScore = finite(
    payload.sectorOpportunity?.stock?.score,
  )
  let score = opportunityScore ?? quantScore ?? 50
  const pct = finite(quote.pct)
  const volRatio = finite(quote.volRatio)
  if (pct != null) score += clamp(pct, -8, 8) * 2
  if (volRatio != null) score += clamp(volRatio - 1, -1, 3) * 3
  if (role === 'LEADER') score += 10
  else if (role === 'FRONT_ROW') score += 6
  else if (role === 'LAGGARD') score -= 10
  if (relation === 'ACCUMULATION') score += 6
  else if (relation === 'DISTRIBUTION') score -= 10
  if (payload.counterTrend?.isStrong === true) score += 8
  return +clamp(score).toFixed(1)
}

function newsTimestamp(item) {
  if (!item || typeof item !== 'object') return null
  const value = item.publishedAt
    || item.publishTime
    || item.time
    || item.at
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function catalystOf(payload = {}, now = Date.now()) {
  const items = [
    ...(Array.isArray(payload.newsHeadlines)
      ? payload.newsHeadlines
      : []),
    ...(Array.isArray(payload.aiSearchEvidence)
      ? payload.aiSearchEvidence
      : []),
  ]
  const latest = items
    .map(newsTimestamp)
    .filter((value) => value != null)
    .sort((left, right) => right - left)[0] ?? null
  const ageHours = latest == null ? null : (now - latest) / 36e5
  const freshness = !items.length
    ? 'NONE'
    : ageHours == null
      ? 'AGING'
      : ageHours <= 8
        ? 'FRESH'
        : ageHours <= 48 ? 'AGING' : 'STALE'
  const joined = items.map((item) =>
    text(typeof item === 'string' ? item : item?.title, 100)
  ).join(' ')
  const negative = (
    payload.resonance?.hasNegNews === true
    || /减持|问询|立案|处罚|终止|下修|风险提示|亏损/.test(joined)
  )
  const positive = /中标|增持|回购|突破|涨价|订单|获批|业绩预增/.test(joined)
  return {
    freshness,
    risk: negative
      ? 'NEGATIVE'
      : positive ? 'POSITIVE' : items.length ? 'NEUTRAL' : 'UNKNOWN',
    latestAt: latest == null ? null : new Date(latest).toISOString(),
  }
}

function observationTiming(payload = {}) {
  const contract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: {
      action: '观望',
      pullbackWatchPrice:
        payload.tech?.sr?.support
        ?? payload.tech?.support,
      breakoutWatchPrice:
        payload.tech?.sr?.resistance
        ?? payload.tech?.resistance,
    },
    payload,
    action: 'WATCH',
  })
  const levels = adviceObservationLevels({ priceContract: contract })
  return {
    pullbackPrice: rounded(
      levels.find((item) => item.direction === 'LTE')?.price,
      3,
    ),
    breakoutPrice: rounded(
      levels.find((item) => item.direction === 'GTE')?.price,
      3,
    ),
  }
}

function conflictsOf({
  marketTone,
  sectorState,
  relativeStrength,
  flowRelation: relation,
  quantDirection,
  location,
}) {
  const conflicts = []
  if (
    marketTone === 'RISK_OFF'
    && relativeStrength >= 65
  ) conflicts.push('个股逆势强，但市场风险偏高')
  if (
    ['LEADING', 'CONFIRMING'].includes(sectorState)
    && relativeStrength < 45
  ) conflicts.push('板块偏强，但个股明显掉队')
  if (
    relation === 'DISTRIBUTION'
    && relativeStrength >= 55
  ) conflicts.push('价格偏强，但主力流出、小单承接')
  if (
    /看涨|UP|BULL/i.test(quantDirection)
    && location === 'EXTENDED'
  ) conflicts.push('量化偏多，但当前价格过热')
  return conflicts
}

function quantConfirmation(tactical = {}) {
  if (tactical.quant?.highConfidence === true) {
    return { supportive: true, strong: true }
  }
  const candidates = [
    tactical.quant,
    tactical.quant?.nextTradeDay,
    tactical.quant?.currentTradingDay,
    tactical.quant?.v21?.heads?.next30m,
    tactical.quant?.v21?.heads?.sessionClose,
  ].filter(Boolean)
  let supportive = false
  let strong = false
  for (const candidate of candidates) {
    const direction = text(candidate.direction, 30)
    const upProb = finite(candidate.upProb)
    const expRet = finite(candidate.expRet)
    const positiveForecast = (
      upProb != null
      && upProb >= 55
      && expRet != null
      && expRet > 0
      && !/看跌|DOWN|BEAR/i.test(direction)
    )
    if (positiveForecast) supportive = true
    if (
      /看涨|UP|BULL/i.test(direction)
      && positiveForecast
    ) strong = true
  }
  return { supportive, strong }
}

function riskIncreaseAssessment(tactical = {}) {
  const hardBlockers = []
  const fullRiskGaps = []
  const timingState = tactical.timing?.state
  if (timingState === 'INVALID') {
    hardBlockers.push('短线时机尚未形成')
  } else if (timingState === 'TOO_EXTENDED') {
    hardBlockers.push('价格位置过热，禁止追涨')
  } else if (timingState === 'WAIT_PULLBACK') {
    fullRiskGaps.push('等待回踩承接确认')
  } else if (timingState === 'WAIT_BREAKOUT') {
    fullRiskGaps.push('等待放量突破确认')
  }
  if (
    ['RISK_OFF', 'UNKNOWN'].includes(
      tactical.market?.riskTone,
    )
  ) hardBlockers.push('市场风险不支持新增仓位')
  if (
    tactical.sector?.state === 'WEAKENING'
    || tactical.sector?.stockRole === 'LAGGARD'
  ) hardBlockers.push('板块或个股地位已经转弱')
  if (tactical.flow?.relation === 'DISTRIBUTION') {
    hardBlockers.push('主力流出且小单承接，存在派发风险')
  }
  if (
    tactical.stock?.location === 'EXTENDED'
    || tactical.stock?.crowdingRisk === 'HIGH'
  ) hardBlockers.push('价格拥挤度过高')
  if (tactical.stock?.liquidity === 'LIMITED') {
    hardBlockers.push('流动性不足，不适合短线进出')
  }
  if (tactical.catalyst?.risk === 'NEGATIVE') {
    hardBlockers.push('负面事件风险尚未消化')
  }
  const quant = quantConfirmation(tactical)
  const flowConfirmed = (
    tactical.flow?.mainDirection === 'INFLOW'
    || (
      finite(tactical.flow?.main5dYi) > 0
      && finite(tactical.flow?.mainStreak) > 0
    )
  )
  const leadershipConfirmed = (
    ['LEADING', 'CONFIRMING'].includes(
      tactical.sector?.state,
    )
    && ['LEADER', 'FRONT_ROW'].includes(
      tactical.sector?.stockRole,
    )
  )
  const strengthConfirmed = (
    finite(tactical.stock?.relativeStrength) >= 60
  )
  const confirmations = [
    quant.strong
      ? '量化强确认'
      : quant.supportive && '量化轻度偏多',
    flowConfirmed && '主力资金确认',
    leadershipConfirmed && '板块前排',
    strengthConfirmed && '相对强势',
  ].filter(Boolean)
  if (!quant.strong) fullRiskGaps.push('量化尚未形成强偏多确认')
  if (!flowConfirmed) fullRiskGaps.push('主力资金尚未确认流入')
  if (tactical.stock?.liquidity !== 'GOOD') {
    fullRiskGaps.push('成交额证据不足，仅允许受控试仓')
  }
  const canProbe = (
    hardBlockers.length === 0
    && confirmations.length >= 2
    && (quant.supportive || flowConfirmed)
  )
  const canFull = (
    canProbe
    && timingState === 'READY'
    && quant.strong
    && flowConfirmed
    && tactical.stock?.liquidity === 'GOOD'
  )
  return {
    riskTier: canFull ? 'FULL' : canProbe ? 'PROBE' : 'NONE',
    hardBlockers: [...new Set(hardBlockers)],
    fullRiskGaps: [...new Set(fullRiskGaps)],
    confirmations,
  }
}

function reviewTriggerForPolicy(tactical = {}) {
  const pullback = finite(tactical.timing?.pullbackPrice)
  const breakout = finite(tactical.timing?.breakoutPrice)
  const triggers = [
    pullback != null ? `回踩${pullback}元确认承接` : '',
    breakout != null ? `放量站上${breakout}元` : '',
  ].filter(Boolean)
  if (triggers.length) return `${triggers.join('或')}后重新评估`
  if (tactical.timing?.reviewAfter === 'FIVE_MINUTE_BAR') {
    return '下一根完整5分钟K线收盘后重新评估'
  }
  if (tactical.timing?.reviewAfter === 'SESSION_BOUNDARY') {
    return '下一交易时段开始时重新评估'
  }
  return '板块、资金或价格结构发生实质变化后重新评估'
}

export function deriveShortHorizonActionPolicy({
  mode = '',
  tactical = null,
  requestedAction = '',
} = {}) {
  const source = tactical && typeof tactical === 'object'
    ? tactical
    : {}
  const assessment = riskIncreaseAssessment(source)
  const canIncreaseRisk = assessment.riskTier !== 'NONE'
  let allowedActions = ['WATCH']
  let fallbackAction = 'WATCH'

  if (mode === 'hold_advice' || mode === 'review') {
    allowedActions = ['HOLD', 'REDUCE', 'EXIT', 'WATCH']
    if (canIncreaseRisk) allowedActions.unshift('ADD')
    fallbackAction = 'HOLD'
  } else if (mode === 't_advice') {
    const stage = source.tAction?.stage
    if (stage === 'buy_wait_sell') {
      allowedActions = ['T_SELL_FIRST', 'WATCH']
    } else if (stage === 'sell_wait_buy') {
      allowedActions = ['T_BUY_FIRST', 'WATCH']
    } else if (
      stage === 'completed'
      || stage === 'completed_locked'
    ) {
      allowedActions = ['WATCH']
    } else if (canIncreaseRisk) {
      allowedActions = [
        'T_BUY_FIRST',
        'T_SELL_FIRST',
        'WATCH',
      ]
    }
  } else if (mode === 'buy_advice' && canIncreaseRisk) {
    allowedActions = ['BUY', 'WATCH']
  }

  const requested = text(requestedAction, 30)
  const overridden = Boolean(
    requested
    && !allowedActions.includes(requested)
  )
  return {
    schemaVersion: SHORT_HORIZON_ACTION_POLICY_VERSION,
    mode: text(mode, 30),
    allowedActions,
    canIncreaseRisk,
    riskTier: assessment.riskTier,
    maxPositionPct: assessment.riskTier === 'PROBE' ? 5 : null,
    manualConfirmationOnly: assessment.riskTier === 'PROBE',
    confirmations: assessment.confirmations,
    requestedAction: requested || null,
    effectiveAction: overridden ? fallbackAction : requested || null,
    fallbackAction,
    overridden,
    reasons: assessment.riskTier === 'FULL'
      ? []
      : [
          ...assessment.hardBlockers,
          ...assessment.fullRiskGaps,
        ],
    nextReviewTrigger: reviewTriggerForPolicy(source),
  }
}

export function buildShortHorizonTactical(
  payload = {},
  { now = Date.now() } = {},
) {
  const quote = payload.todayQuote || {}
  const market = payload.marketEnv || {}
  const role = stockRoleOf(payload.sectorOpportunity)
  const sectorState = sectorStateOf(payload.sectorOpportunity, role)
  const marketTone = riskToneOf(market)
  const location = locationOf(payload)
  const crowdingRisk = crowdingRiskOf(payload, location)
  const mainDirection = flowDirection(payload.stockFund?.mainNetYi)
  const retailDirection = flowDirection(
    payload.stockFund?.retailNetYi
    ?? payload.stockFund?.smallNetYi,
  )
  const relation = flowRelation(mainDirection, retailDirection)
  const relativeStrength = relativeStrengthOf(payload, role, relation)
  const prices = observationTiming(payload)
  const quantDirection = text(payload.quant?.forecast?.direction, 30)
  const conflicts = conflictsOf({
    marketTone,
    sectorState,
    relativeStrength,
    flowRelation: relation,
    quantDirection,
    location,
  })
  const quoteAvailable = finite(
    quote.price ?? payload.currentPrice,
  ) != null
  const state = !quoteAvailable || quote.stale === true
    ? 'INVALID'
    : location === 'EXTENDED' || crowdingRisk === 'HIGH'
      ? 'TOO_EXTENDED'
      : relativeStrength >= 60
        && marketTone !== 'RISK_OFF'
        && !conflicts.length
        ? 'READY'
        : prices.pullbackPrice != null
          ? 'WAIT_PULLBACK'
          : prices.breakoutPrice != null
            ? 'WAIT_BREAKOUT'
            : 'INVALID'
  const phase = phaseOf(payload)
  const horizon = quote.live === true
    ? (
        ['READY', 'TOO_EXTENDED'].includes(state)
          ? 'INTRADAY'
          : 'NEXT_SESSION'
      )
    : 'ONE_TO_FIVE_DAYS'
  const reviewAfter = state === 'READY'
    ? 'FIVE_MINUTE_BAR'
    : prices.pullbackPrice != null || prices.breakoutPrice != null
      ? 'PRICE'
      : phase === 'OFF_HOURS' || phase === 'CLOSE'
        ? 'SESSION_BOUNDARY'
        : 'MATERIAL_EVENT'

  return {
    schemaVersion: SHORT_HORIZON_TACTICAL_VERSION,
    asOf: text(
      quote.asOf
      || quote.time
      || payload.quant?.inputAsOf
      || payload.quant?.asOf
      || payload.evidenceSnapshot?.asOf,
      60,
    ) || new Date(now).toISOString(),
    horizon,
    market: {
      phase,
      riskTone: marketTone,
      breadthScore: rounded(market.score),
    },
    sector: {
      name: text(payload.sectorOpportunity?.sector?.name, 50),
      state: sectorState,
      stockRole: role,
    },
    stock: {
      price: rounded(quote.price ?? payload.currentPrice, 3),
      pct: rounded(quote.pct),
      turnover: rounded(quote.turnover),
      volRatio: rounded(quote.volRatio),
      posInDay: rounded(payload.intraday?.posInDay),
      rsi: rounded(payload.tech?.rsi),
      vsVwap: text(payload.intraday?.vsVwap, 30) || 'UNKNOWN',
      smartMoney: payload.lhb?.smartMoney === true,
      relativeStrength,
      location,
      liquidity: liquidityOf(payload),
      crowdingRisk,
    },
    flow: {
      mainNetYi: rounded(payload.stockFund?.mainNetYi, 2),
      retailNetYi: rounded(
        payload.stockFund?.retailNetYi
        ?? payload.stockFund?.smallNetYi,
        2,
      ),
      main5dYi: rounded(payload.stockFund?.main5dYi, 2),
      mainStreak: rounded(payload.stockFund?.mainStreak, 0),
      mainDirection,
      retailDirection,
      relation,
    },
    timing: {
      state,
      ...prices,
      reviewAfter,
    },
    catalyst: catalystOf(payload, now),
    quant: {
      selectedModelVersion: text(
        payload.quant?.selectedModelVersion
        || payload.quantModelVersion,
        40,
      ),
      modelVersion: text(payload.quant?.modelVersion, 40),
      runtimeModelVersion: text(
        payload.quant?.runtimeModelVersion,
        60,
      ),
      modelLabel: text(payload.quant?.modelLabel, 80),
      asOf: text(payload.quant?.asOf, 60),
      inputAsOf: text(payload.quant?.inputAsOf, 60),
      inputSource: text(payload.quant?.inputSource, 60),
      score: rounded(payload.quant?.score),
      direction: quantDirection || 'UNKNOWN',
      upProb: rounded(payload.quant?.forecast?.upProb),
      expRet: rounded(payload.quant?.forecast?.expRet, 2),
      horizon: text(payload.quant?.forecast?.horizon, 40),
      highConfidence:
        payload.quant?.highConfSignal?.fired === true,
      nextTradeDay: payload.quant?.nextTradeDayForecast
        ? {
            targetDate: text(
              payload.quant.nextTradeDayForecast.targetDate,
              20,
            ),
            direction: text(
              payload.quant.nextTradeDayForecast.direction,
              30,
            ),
            upProb: rounded(
              payload.quant.nextTradeDayForecast.upProb,
            ),
            expRet: rounded(
              payload.quant.nextTradeDayForecast.expRet,
              2,
            ),
            targetLow: rounded(
              payload.quant.nextTradeDayForecast.targetLow,
              3,
            ),
            targetMid: rounded(
              payload.quant.nextTradeDayForecast.targetMid,
              3,
            ),
            targetHigh: rounded(
              payload.quant.nextTradeDayForecast.targetHigh,
              3,
            ),
          }
        : null,
      currentTradingDay: payload.quant?.currentTradingDayForecast
        ? {
            targetDate: text(
              payload.quant.currentTradingDayForecast.targetDate,
              20,
            ),
            direction: text(
              payload.quant.currentTradingDayForecast.direction,
              30,
            ),
            upProb: rounded(
              payload.quant.currentTradingDayForecast.upProb,
            ),
            expRet: rounded(
              payload.quant.currentTradingDayForecast.expRet,
              2,
            ),
            targetLow: rounded(
              payload.quant.currentTradingDayForecast.targetLow,
              3,
            ),
            targetMid: rounded(
              payload.quant.currentTradingDayForecast.targetMid,
              3,
            ),
            targetHigh: rounded(
              payload.quant.currentTradingDayForecast.targetHigh,
              3,
            ),
          }
        : null,
      v21: payload.quant?.v21
        ? {
            activeHead: text(payload.quant.v21.activeHead, 30),
            session: text(payload.quant.v21.session, 30),
            heads: payload.quant.v21.heads || null,
            reliability: payload.quant.reliability
              || V21_EXPERIMENTAL_RELIABILITY,
          }
        : null,
      fallback: payload.quant?.fallback
        ? {
            from: text(payload.quant.fallback.from, 30),
            to: text(payload.quant.fallback.to, 30),
            reason: text(payload.quant.fallback.reason, 120),
          }
        : null,
    },
    tAction: payload.tContext
      ? {
          stage: text(payload.tContext.stage, 40),
          pendingQty: rounded(payload.tContext.pendingQty, 0),
          firstLegPrice: rounded(
            payload.tContext.firstLegPrice,
            3,
          ),
          completedTodayCount: rounded(
            payload.tContext.completedTodayCount,
            0,
          ),
          lockedTodayQty: rounded(
            payload.tContext.lockedTodayQty,
            0,
          ),
          sellableTodayQty: rounded(
            payload.tContext.sellableTodayQty,
            0,
          ),
        }
      : null,
    opportunityCost: payload.opportunityCost?.targetCode
      ? {
          status: text(payload.opportunityCost.status, 30),
          actionable:
            payload.opportunityCost.actionable === true,
          targetCode: text(
            payload.opportunityCost.targetCode,
            12,
          ),
          targetName: text(
            payload.opportunityCost.targetName,
            40,
          ),
          edgeScore: rounded(
            payload.opportunityCost.edgeScore,
            1,
          ),
          tradingCost: rounded(
            payload.opportunityCost.tradingCost,
            2,
          ),
          generatedAt: finite(
            payload.opportunityCost.generatedAt,
          ),
        }
      : null,
    prices: {
      current: rounded(quote.price ?? payload.currentPrice, 3),
      dayLow: rounded(quote.low ?? quote.dayLow, 3),
      dayHigh: rounded(quote.high ?? quote.dayHigh, 3),
      limitDown: rounded(quote.limitDownPrice, 3),
      limitUp: rounded(quote.limitUpPrice, 3),
      vwap: rounded(payload.intraday?.vwap, 3),
      support: rounded(
        payload.tech?.sr?.support
        ?? payload.tech?.support,
        3,
      ),
      resistance: rounded(
        payload.tech?.sr?.resistance
        ?? payload.tech?.resistance,
        3,
      ),
      buyZone: payload.tech?.priceHints?.buyZone
        ?? payload.tech?.buyZone
        ?? null,
      sellZone: payload.tech?.priceHints?.sellZone
        ?? payload.tech?.sellZone
        ?? null,
      stopReference: rounded(
        payload.tech?.priceHints?.stopLoss,
        3,
      ),
      targetReference: rounded(
        payload.tech?.priceHints?.takeProfit,
        3,
      ),
      quantTargetLow: rounded(
        payload.quant?.forecast?.targetLow,
        3,
      ),
      quantTargetHigh: rounded(
        payload.quant?.forecast?.targetHigh,
        3,
      ),
    },
    conflicts,
    alignmentScore: +clamp(
      relativeStrength
      + (marketTone === 'RISK_ON' ? 8 : marketTone === 'RISK_OFF' ? -12 : 0)
      + (sectorState === 'LEADING' ? 8 : sectorState === 'WEAKENING' ? -10 : 0)
      + (relation === 'ACCUMULATION' ? 6 : relation === 'DISTRIBUTION' ? -8 : 0)
      - conflicts.length * 8,
    ).toFixed(1),
  }
}

const HORIZON_LABELS = Object.freeze({
  INTRADAY: '盘中',
  NEXT_SESSION: '下一交易时段',
  ONE_TO_FIVE_DAYS: '1-5个交易日',
})

function boundedText(value, maximum) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function defaultEdge(tactical = {}) {
  if (
    tactical.sector?.stockRole === 'LEADER'
    && tactical.flow?.relation === 'ACCUMULATION'
  ) return '板块前排且主力承接，短线资金结构占优'
  if (
    tactical.stock?.relativeStrength >= 65
    && tactical.quant?.highConfidence === true
  ) return '个股相对强势并获得量化高把握信号确认'
  if (tactical.flow?.relation === 'ACCUMULATION') {
    return '主力流入、小单流出，存在筹码集中迹象'
  }
  if (tactical.sector?.state === 'LEADING') {
    return '板块领涨且个股处于核心位置'
  }
  return '当前没有形成足够明确的短线优势'
}

function defaultCrowdingRisk(tactical = {}) {
  if (tactical.conflicts?.length) return tactical.conflicts[0]
  if (tactical.flow?.relation === 'DISTRIBUTION') {
    return '主力流出、小单承接，需防冲高派发'
  }
  if (tactical.stock?.crowdingRisk === 'HIGH') {
    return '价格位置或成交过热，需防追高后快速回撤'
  }
  if (tactical.stock?.crowdingRisk === 'MEDIUM') {
    return '短线已有一定拥挤，需等待量价继续确认'
  }
  return '暂未发现明显拥挤，但仍需服从失效条件'
}

function defaultCatalystWindow(tactical = {}) {
  if (tactical.catalyst?.risk === 'NEGATIVE') {
    return '负面事件影响尚未消化'
  }
  if (tactical.catalyst?.freshness === 'FRESH') {
    return '近期催化仍新鲜，需由量价确认'
  }
  if (tactical.catalyst?.freshness === 'AGING') {
    return '催化正在衰减，不宜继续追价'
  }
  if (tactical.catalyst?.freshness === 'STALE') {
    return '旧催化已失去短线时效'
  }
  return '暂无可确认的新催化'
}

function defaultReviewTrigger(tactical = {}) {
  const pullback = finite(tactical.timing?.pullbackPrice)
  const breakout = finite(tactical.timing?.breakoutPrice)
  if (pullback != null || breakout != null) {
    const paths = [
      pullback != null ? `回踩${pullback}元` : '',
      breakout != null ? `突破${breakout}元` : '',
    ].filter(Boolean)
    return `${paths.join('或')}时重新评估`
  }
  if (tactical.timing?.reviewAfter === 'FIVE_MINUTE_BAR') {
    return '下一根完整5分钟K线收盘后重新评估'
  }
  if (tactical.timing?.reviewAfter === 'SESSION_BOUNDARY') {
    return '下一交易时段开始时重新评估'
  }
  return '资金、板块或重大消息变化时重新评估'
}

export function attachShortHorizonSummary(
  advice = {},
  tactical = null,
) {
  if (!tactical || typeof tactical !== 'object') return advice
  return {
    ...(advice || {}),
    shortHorizon: boundedText(
      advice?.shortHorizon
      || HORIZON_LABELS[tactical.horizon]
      || '1-5个交易日',
      40,
    ),
    edge: boundedText(advice?.edge || defaultEdge(tactical), 60),
    crowdingRisk: boundedText(
      advice?.crowdingRisk || defaultCrowdingRisk(tactical),
      60,
    ),
    catalystWindow: boundedText(
      advice?.catalystWindow || defaultCatalystWindow(tactical),
      40,
    ),
    reviewTrigger: boundedText(
      advice?.reviewTrigger || defaultReviewTrigger(tactical),
      60,
    ),
    shortHorizonTactical: tactical,
  }
}
