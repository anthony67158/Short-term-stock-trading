import {
  buildAdviceReviewMemory,
  compareAdviceReviewMemory,
  resolveAdviceReviewMemory,
  sanitizeAdviceReviewMemory,
} from './adviceReviewMemory.js'

export const REVIEW_DECISION_PACKET_VERSION =
  'review-decision-packet.v1'
export const INTRADAY_OPEN_SUMMARY_VERSION =
  'intraday-open-summary.v1'

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

const positive = (value) => {
  const number = finite(value)
  return number != null && number > 0 ? number : null
}

const round = (value, digits = 3) => {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function compact(value, depth = 0) {
  if (value == null || depth > 4) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') return text(value, 500)
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 10)
      .map((item) => compact(item, depth + 1))
      .filter((item) => item != null)
  }
  if (typeof value !== 'object') return null
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, compact(item, depth + 1)])
      .filter(([, item]) => item != null),
  )
}

function isoTime(value) {
  if (value == null || value === '') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : null
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
}

function sampledPath(rows, limit = 8) {
  if (rows.length <= limit) return rows
  const indexes = new Set([0, rows.length - 1])
  for (let index = 1; index < limit - 1; index++) {
    indexes.add(Math.round(
      index * (rows.length - 1) / (limit - 1),
    ))
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => rows[index])
}

function priceVsVwap(price, vwap) {
  if (!(price > 0) || !(vwap > 0)) return 'UNKNOWN'
  const distancePct = (price - vwap) / vwap * 100
  if (distancePct >= 0.1) return 'ABOVE'
  if (distancePct <= -0.1) return 'BELOW'
  return 'AROUND'
}

function volumeState(ratio) {
  if (!Number.isFinite(ratio)) return 'UNKNOWN'
  if (ratio >= 1.25) return 'EXPANDING'
  if (ratio <= 0.8) return 'CONTRACTING'
  return 'NORMAL'
}

function directionFromOpen(open, current) {
  if (!(open > 0) || !(current > 0)) return 'UNKNOWN'
  const changePct = (current - open) / open * 100
  if (changePct >= 0.3) return 'UP'
  if (changePct <= -0.3) return 'DOWN'
  return 'FLAT'
}

function highLowStructure(rows) {
  if (rows.length < 6) return 'UNKNOWN'
  const half = Math.floor(rows.length / 2)
  const first = rows.slice(0, half).map((item) => item.price)
  const second = rows.slice(half).map((item) => item.price)
  const firstHigh = Math.max(...first)
  const firstLow = Math.min(...first)
  const secondHigh = Math.max(...second)
  const secondLow = Math.min(...second)
  if (secondHigh > firstHigh && secondLow >= firstLow) return 'RISING'
  if (secondHigh <= firstHigh && secondLow < firstLow) return 'FALLING'
  return 'MIXED'
}

export function buildIntradayOpenSummary(
  trends,
  {
    preClose = null,
    observedAt = Date.now(),
  } = {},
) {
  const rows = (Array.isArray(trends) ? trends : [])
    .map((item) => ({
      time: text(item?.time, 24),
      price: positive(item?.price),
      volume: Math.max(
        0,
        finite(item?.volume ?? item?.vol) || 0,
      ),
      vwap: positive(item?.avg ?? item?.vwap),
    }))
    .filter((item) => item.time && item.price != null)
  if (!rows.length) return null

  const first = rows[0]
  const last = rows.at(-1)
  const prices = rows.map((item) => item.price)
  const volumes = rows.map((item) => item.volume)
  const windowSize = Math.min(10, Math.floor(rows.length / 2))
  const recentVolumes = windowSize > 0
    ? volumes.slice(-windowSize)
    : []
  const priorVolumes = windowSize > 0
    ? volumes.slice(-windowSize * 2, -windowSize)
    : []
  const recentAverage = average(recentVolumes)
  const priorAverage = average(priorVolumes)
  const recentToPriorRatio = (
    priorAverage != null
    && priorAverage > 0
    && recentAverage != null
  ) ? recentAverage / priorAverage : null
  const vwap = last.vwap
  const dayHigh = Math.max(...prices)
  const dayLow = Math.min(...prices)
  const currentPrice = last.price
  const normalizedPreClose = positive(preClose)
  const sampled = sampledPath(rows).map((item) => ({
    time: item.time,
    price: round(item.price),
    volume: round(item.volume, 0),
    vwap: round(item.vwap),
  }))
  return {
    schemaVersion: INTRADAY_OPEN_SUMMARY_VERSION,
    observedAt: isoTime(observedAt),
    firstTime: first.time,
    lastTime: last.time,
    bars: rows.length,
    openPrice: round(first.price),
    currentPrice: round(currentPrice),
    dayHigh: round(dayHigh),
    dayLow: round(dayLow),
    vwap: round(vwap),
    priceVsVwap: priceVsVwap(currentPrice, vwap),
    vwapDistancePct: vwap > 0
      ? round((currentPrice - vwap) / vwap * 100, 2)
      : null,
    directionFromOpen: directionFromOpen(
      first.price,
      currentPrice,
    ),
    changeFromOpenPct: first.price > 0
      ? round((currentPrice - first.price) / first.price * 100, 2)
      : null,
    changeFromPreClosePct: normalizedPreClose > 0
      ? round(
          (currentPrice - normalizedPreClose)
            / normalizedPreClose * 100,
          2,
        )
      : null,
    rangePct: dayLow > 0
      ? round((dayHigh - dayLow) / dayLow * 100, 2)
      : null,
    positionInRangePct: dayHigh > dayLow
      ? round((currentPrice - dayLow) / (dayHigh - dayLow) * 100, 1)
      : 50,
    highLowStructure: highLowStructure(rows),
    volume: {
      state: volumeState(recentToPriorRatio),
      recentToPriorRatio: round(recentToPriorRatio, 2),
      recentAverage: round(recentAverage, 0),
      priorAverage: round(priorAverage, 0),
      cumulative: round(
        volumes.reduce((sum, value) => sum + value, 0),
        0,
      ),
      comparisonBars: windowSize,
    },
    path: sampled,
  }
}

function actionIntent(event = {}, priorAdvice = {}) {
  const explicit = String(
    event.actionIntent
    || event.plannedAction
    || event.side
    || '',
  ).toUpperCase()
  if (['BUY', 'PROBE'].includes(explicit)) return 'BUY'
  if (['ADD', 'PROBE_ADD'].includes(explicit)) return 'ADD'
  if (['REDUCE', 'SELL', 'T_SELL_FIRST'].includes(explicit)) {
    return 'REDUCE'
  }
  if (['STOP', 'EXIT'].includes(explicit)) return 'EXIT'
  const label = [
    event.actionLabel,
    priorAdvice.action,
    priorAdvice.stance,
    priorAdvice.actionPlan,
  ].filter(Boolean).join(' ')
  if (/止损|清仓|退出/.test(label)) return 'EXIT'
  if (/减仓|止盈|锁利|卖出/.test(label)) return 'REDUCE'
  if (/加仓|补仓|接回/.test(label)) return 'ADD'
  if (/买入|试仓|建仓/.test(label)) return 'BUY'
  return 'WATCH'
}

function allowedOutcomes(channel, intent, hasPosition) {
  if (channel === 'JUDGE') {
    if (intent === 'BUY') return ['立即买入', '维持观望', '放弃买入']
    if (intent === 'ADD') return ['立即加仓', '维持持有', '放弃加仓']
    if (intent === 'EXIT') return ['立即止损', '维持持有', '放弃本次操作']
    return ['立即减仓', '锁定利润', '维持持有']
  }
  return hasPosition
    ? ['立即加仓', '立即减仓', '锁定利润', '维持持有', '立即清仓']
    : ['立即买入', '维持观望', '放弃买入']
}

function decisionScope(channel, intent, hasPosition) {
  const judge = channel === 'JUDGE'
  return {
    stage: judge ? 'EXECUTION_GATE' : 'PLAN_REASSESSMENT',
    responsibility: judge
      ? '只确认原计划此刻是否执行，不改变方向，不重写交易计划'
      : '观察价触发后做一次终局重评，并给出本轮执行细节和后续管理计划',
    intendedAction: intent,
    allowedOutcomes: allowedOutcomes(
      channel,
      intent,
      hasPosition,
    ),
    requiredFields: judge
      ? ['decision', 'priceLow', 'priceHigh', 'quantity', 'basis', 'confidence']
      : ['outcome', 'operation', 'priceLow', 'priceHigh', 'quantity', 'basis', 'nextOpenPlan', 'futurePlan'],
    mayChangeDirection: !judge,
    mayCreateObservationPrice: false,
    mayReviseExecutionDetails: !judge,
    followUpPlanSource: judge ? 'PRIOR_PLAN' : 'CURRENT_REVIEW',
    terminalForTrigger: true,
    maxDecisionMs: judge ? 10000 : 45000,
    manualConfirmationRequired: true,
  }
}

function priorPlanOf(advice = {}, event = {}) {
  const continuity = advice.continuity || {}
  return {
    planId: text(
      event.planId
      || advice.planId
      || continuity.planId,
      120,
    ),
    revision: finite(
      event.planRevision
      ?? advice.planRevision
      ?? continuity.revision,
    ) || 0,
    action: text(advice.action || advice.stance, 50),
    executionCondition: text(
      advice.exitTiming
      || advice.actionPlan
      || advice.nextAction,
      600,
    ),
    invalidation: text(advice.invalidation, 400),
    quantity: text(advice.opQty || advice.planQty, 50),
    maxPositionPct: finite(
      event.maxPositionPct
      ?? advice.reviewMemory?.conclusion?.maxPositionPct
      ?? advice.shortHorizonTactical?.actionPolicy?.maxPositionPct,
    ),
    prices: {
      buy: positive(advice.buyPrice),
      add: positive(advice.addPrice),
      reduce: positive(advice.reducePrice),
      stop: positive(advice.stopPrice),
      target: positive(advice.targetPrice),
      trigger: positive(event.threshold),
    },
    nextSessionPlan: text(advice.nextOpenPlan, 600),
    futurePlan: text(advice.futurePlan, 600),
    priceContract: compact(advice.priceContract),
  }
}

export function buildReviewDecisionPacket({
  channel = 'FAST_REVIEW',
  code = '',
  name = '',
  priorAdvice = {},
  event = {},
  current = {},
  requestedDecision = null,
  now = Date.now(),
} = {}) {
  const normalizedChannel = channel === 'JUDGE'
    ? 'JUDGE'
    : 'FAST_REVIEW'
  const priorMemory = resolveAdviceReviewMemory(priorAdvice)
  const currentMemory = sanitizeAdviceReviewMemory(
    current.reviewMemory,
  ) || buildAdviceReviewMemory({
    advice: {},
    payload: {
      todayQuote: current.quote,
      stockFund: current.funds,
      intradayOpenSummary: current.intradayFromOpen,
      shortHorizonTactical: current.tactical,
      reviewEvent: event,
    },
    source: normalizedChannel,
    now,
  })
  const hasPosition = (
    positive(current.position?.liveQty)
    ?? positive(current.position?.holdQty)
    ?? positive(current.account?.holdQty)
  ) != null
  const intent = actionIntent(event, priorAdvice)
  const memoryDelta = compareAdviceReviewMemory(
    priorMemory,
    currentMemory,
  )
  return {
    schemaVersion: REVIEW_DECISION_PACKET_VERSION,
    channel: normalizedChannel,
    createdAt: isoTime(now),
    security: {
      code: text(code || event.code, 12),
      name: text(name, 50),
    },
    trigger: compact({
      kind: event.kind,
      alertId: event.alertId,
      direction: event.direction,
      threshold: event.threshold,
      price: event.price,
      at: event.at,
      reason: event.reason,
      plannedAction: event.plannedAction,
      actionLabel: event.actionLabel,
      maxPositionPct: event.maxPositionPct,
      manualConfirmationOnly: event.manualConfirmationOnly,
    }),
    priorPlan: priorPlanOf(priorAdvice, event),
    baseline: priorMemory,
    current: {
      quote: compact(current.quote),
      funds: compact(current.funds),
      intradayFromOpen: compact(current.intradayFromOpen),
      postTrigger: compact(current.postTrigger),
      technical: compact(current.technical),
      position: compact(current.position),
      account: compact(current.account),
    },
    delta: {
      ...memoryDelta,
      planConflict: current.planConflict === true,
    },
    requestedDecision: requestedDecision
      ? compact(requestedDecision)
      : decisionScope(
          normalizedChannel,
          intent,
          hasPosition,
        ),
  }
}
