import { timeBoundReviewText } from './userFacingLanguage.js'

export const TRIGGERED_REVIEW_TIME_LIMIT_MINUTES = 2
export const TRIGGERED_REVIEW_TOTAL_BUDGET_MS =
  TRIGGERED_REVIEW_TIME_LIMIT_MINUTES * 60 * 1000
export const TRIGGERED_REVIEW_MODEL_BUDGET_MS = 45 * 1000

const TRIGGERED_REVIEW_SOURCE_KEYS = new Set([
  'market',
  'sectorFlow',
  'dailyCandles',
  'intraday',
  'stockFunds',
  'quote',
])

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

const lotsOf = (value) => {
  const match = String(value ?? '').match(/\d+(?:\.\d+)?/)
  const number = match ? Number(match[0]) : Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.trunc(number)
    : 0
}

function priorPositionLimitPct(payload = {}) {
  const previous = payload.previousAdvice || {}
  const direct = finite(
    payload.reviewEvent?.maxPositionPct
    ?? previous.reviewMemory?.conclusion?.maxPositionPct
    ?? previous.shortHorizonTactical?.actionPolicy?.maxPositionPct,
  )
  if (direct != null && direct > 0) {
    return Math.min(100, direct)
  }
  const match = [
    previous.positionNote,
    previous.actionPlan,
  ].filter(Boolean).join(' ')
    .match(/(?:仓位|单票).{0,12}(?:不超过|上限)\s*(\d+(?:\.\d+)?)%/)
  return match ? Math.min(100, Number(match[1])) : null
}

function capRiskIncreasingLots(
  requested,
  executionPrice,
  payload = {},
) {
  const quantity = Math.max(0, Math.trunc(Number(requested) || 0))
  const price = positive(executionPrice)
  const limitPct = priorPositionLimitPct(payload)
  const totalAssets = positive(payload.account?.totalAssets)
  if (quantity <= 0 || limitPct == null) {
    return { quantity, limitPct, capped: false }
  }
  if (price == null || totalAssets == null) {
    return {
      quantity: 0,
      limitPct,
      capped: true,
      reason: '缺少总资产或执行价，无法核验原计划仓位上限',
    }
  }
  const currentLots = Math.max(
    0,
    Math.trunc(finite(payload.holdQty) || 0),
  )
  const currentValue = currentLots * price * 100
  const available = Math.max(
    0,
    totalAssets * limitPct / 100 - currentValue,
  )
  const allowed = Math.max(
    0,
    Math.floor(available / (price * 100)),
  )
  return {
    quantity: Math.min(quantity, allowed),
    limitPct,
    capped: quantity > allowed,
  }
}

export function isTriggeredReviewEvent(event = {}) {
  return ['price-review', 'judge'].includes(String(event?.kind || ''))
}

export function shouldCollectTriggeredReviewSource(event = {}, key = '') {
  return !isTriggeredReviewEvent(event)
    || TRIGGERED_REVIEW_SOURCE_KEYS.has(String(key || ''))
}

export function triggeredReviewDeadlineAt(
  event = {},
  now = Date.now(),
) {
  if (!isTriggeredReviewEvent(event)) return null
  const explicit = finite(event.decisionDeadlineAt)
  if (explicit != null) return explicit
  const startedAt = finite(event.at) || Number(now)
  return startedAt + TRIGGERED_REVIEW_TOTAL_BUDGET_MS
}

export function triggeredReviewRuntime(
  event = {},
  now = Date.now(),
) {
  const deadlineAt = triggeredReviewDeadlineAt(event, now)
  if (deadlineAt == null) return null
  const remainingMs = Math.max(0, deadlineAt - Number(now))
  const runtimeBudgetMs = Math.min(
    TRIGGERED_REVIEW_MODEL_BUDGET_MS,
    Math.max(0, remainingMs - 8000),
  )
  return {
    deadlineAt,
    remainingMs,
    runtimeBudgetMs,
    timeoutMs: runtimeBudgetMs > 0
      ? runtimeBudgetMs + 5000
      : 0,
    expired: runtimeBudgetMs < 30000,
    maxAttempts: 1,
  }
}

function usefulEvidence(value) {
  const normalized = text(value, 360)
  if (!normalized) return ''
  if (/^(?:无|暂无|未知|未取得|数据缺失|不适用)/.test(normalized)) {
    return ''
  }
  return normalized
}

function evidenceBasis(result = {}, payload = {}) {
  const previous = payload.previousAdvice || {}
  const bases = (Array.isArray(result.reviewDecision?.basis)
    ? result.reviewDecision.basis
    : [])
    .map((item) => ({
      type: text(item?.type, 40),
      summary: usefulEvidence(item?.summary),
    }))
    .filter((item) => item.type && item.summary)
    .slice(0, 3)
  const theory = usefulEvidence(
    result.theoryNote
    || result.theory
    || result.knowledgeActionPlan?.principle
    || previous.theoryNote
    || previous.theory
    || previous.knowledgeActionPlan?.principle,
  )
  if (theory) {
    bases.push({
      type: '已验证理论',
      summary: theory,
    })
  }

  const current = positive(
    payload.todayQuote?.price
    ?? payload.currentPrice
    ?? payload.reviewEvent?.price,
  )
  const main = finite(payload.stockFund?.mainNetYi)
  const retail = finite(
    payload.stockFund?.retailNetYi
    ?? payload.stockFund?.smallNetYi,
  )
  const priceNote = usefulEvidence(
    result.techNote || result.quantNote || result.intradayNote,
  )
  const fundNote = usefulEvidence(result.fundNote)
  if (
    current != null
    && (
      main != null
      || retail != null
      || (fundNote && priceNote)
    )
  ) {
    const facts = [
      `现价${round(current)}元`,
      main != null ? `主力净额${round(main, 2)}亿` : '',
      retail != null ? `小单净额${round(retail, 2)}亿` : '',
      fundNote,
      priceNote,
    ].filter(Boolean)
    bases.push({
      type: '实时资金与价格',
      summary: text(facts.join('；'), 360),
    })
  }

  const catalyst = usefulEvidence(result.newsNote || result.catalyst)
  if (catalyst) {
    bases.push({
      type: '重大催化',
      summary: catalyst,
    })
  }

  if (!bases.length && current != null) {
    const threshold = positive(payload.reviewEvent?.threshold)
    bases.push({
      type: '实时资金与价格',
      summary: threshold != null
        ? `现价${round(current)}元已触及原计划${round(threshold)}元，结合本轮分时结构作出终局判断`
        : `基于现价${round(current)}元与本轮分时结构作出终局判断`,
    })
  }
  return bases.slice(0, 3)
}

function terminalDecisionReason(result = {}, bases = [], fallback = '') {
  const candidates = [
    result.reviewDecision?.reason,
    result.reason,
    result.newsNote,
    result.fundNote,
    result.techNote,
    ...(Array.isArray(bases) ? bases.map((item) => item?.summary) : []),
  ]
  return candidates
    .map((item) => timeBoundReviewText(
      usefulEvidence(item),
      { terminal: true },
    ))
    .find(Boolean)
    || fallback
    || '本轮实时证据未能继续支持原操作'
}

function executionRange(result = {}, payload = {}, operation = '') {
  const review = result.reviewDecision || {}
  let low = positive(review.priceLow)
  let high = positive(review.priceHigh)
  const fallback = positive(
    operation === '买入'
      ? result.buyPrice
      : operation === '加仓'
        ? result.addPrice
        : operation === '减仓' || operation === '锁利润'
          ? result.reducePrice ?? result.targetPrice
          : operation === '清仓'
            ? result.stopPrice ?? result.reducePrice
            : null,
  ) || positive(payload.todayQuote?.price)
    || positive(payload.reviewEvent?.price)
  if (low == null) low = fallback
  if (high == null) high = fallback
  if (low != null && high != null && low > high) {
    [low, high] = [high, low]
  }
  return {
    low: round(low),
    high: round(high),
  }
}

function rangeText(range = {}) {
  if (!(range.low > 0) || !(range.high > 0)) return ''
  return range.low === range.high
    ? `${range.low}元`
    : `${range.low}–${range.high}元`
}

function clearReviewPrices(result) {
  result.watchPrice = null
  result.pullbackWatchPrice = null
  result.breakoutWatchPrice = null
  delete result.priceContract
  delete result.decisionPlan
  delete result.executionPlan
  delete result.presentation
  result.reviewTrigger =
    '本次触发已经结束；仅在新的独立事件或用户主动生成时重新判断'
  result.reviewTerminal = true
  return result
}

function reviewDecisionRecord({
  outcome,
  operation,
  range,
  quantity,
  bases,
  reason,
  event,
  result,
  now,
}) {
  const executed = operation !== '不操作'
  return {
    schemaVersion: 'triggered-review-decision.v1',
    terminal: true,
    outcome,
    operation,
    priceLow: range.low,
    priceHigh: range.high,
    quantity,
    basis: bases,
    basisType: bases[0]?.type || '实时资金与价格',
    basisSummary:
      bases[0]?.summary || '依据本轮触价后的实时走势作出终局判断',
    reason: text(
      reason || bases[0]?.summary || '依据本轮实时证据作出终局判断',
      500,
    ),
    triggerPrice: positive(event?.price),
    triggerThreshold: positive(event?.threshold),
    decidedAt: Number(now),
    timeLimitMinutes: Number(event?.timeLimitMinutes)
      || TRIGGERED_REVIEW_TIME_LIMIT_MINUTES,
    followUpPlan: {
      source: 'CURRENT_REVIEW',
      manualConfirmationRequired: true,
      nextSessionPlan: text(result?.nextOpenPlan, 500),
      futurePlan: text(result?.futurePlan, 500),
      invalidation: text(result?.invalidation, 300),
      stopPrice: positive(result?.stopPrice),
      targetPrice: positive(result?.targetPrice),
      reassessment: executed
        ? '人工确认并记录真实成交后，按本轮计划继续管理'
        : '本次触发结束，仅在新实质事件或用户主动生成时重新评估',
    },
  }
}

function normalizeBuyReview(result, payload, bases, now) {
  const event = payload.reviewEvent || {}
  const raw = text(
    result.reviewDecision?.outcome
    || result.action
    || result.stance,
    60,
  )
  let outcome = /放弃|取消|失效|不再买/.test(raw)
    ? '放弃买入'
    : /立即买入|现在买入|小仓试错|买入/.test(raw)
      ? '立即买入'
      : '维持观望'
  let quantity = lotsOf(
    result.reviewDecision?.quantity
    ?? result.planQtyNum
    ?? result.planQty,
  )
  let range = executionRange(result, payload, '买入')
  const positionCap = capRiskIncreasingLots(
    quantity,
    range.high,
    payload,
  )
  quantity = positionCap.quantity
  if (positionCap.reason && !result.reason) {
    result.reason = positionCap.reason
  }
  const stop = positive(result.stopPrice)
  const target = positive(result.targetPrice)
  const reason = terminalDecisionReason(
    result,
    bases,
    '触价后未满足原计划的价格、量能或资金确认条件',
  )
  if (
    outcome === '立即买入'
    && (
      quantity <= 0
      || !(range.low > 0)
      || !(range.high > 0)
      || !(stop > 0)
      || !(target > range.high)
      || !(stop < range.low)
    )
  ) {
    outcome = '维持观望'
    quantity = 0
    range = { low: null, high: null }
  }

  clearReviewPrices(result)
  result.action = outcome === '立即买入' ? '立即买入' : '观望'
  result.stance = result.action
  result.tier = outcome === '立即买入' ? 'now' : 'wait'
  result.title = outcome
  result.headline = outcome
  result.planQty = outcome === '立即买入' ? quantity : 0
  result.planQtyNum = result.planQty
  if (outcome === '立即买入') {
    result.buyPrice = range.low
    result.buyZone = range.low === range.high
      ? `${range.low}`
      : `${range.low}-${range.high}`
    result.actionPlan = `立即买入${quantity}手，执行区间${rangeText(range)}；跌破${stop}元止损，目标${target}元`
    result.invalidation = result.invalidation
      || `跌破${stop}元或本轮依据失效`
    result.nextOpenPlan = result.nextOpenPlan
      || `下一交易日跌破${stop}元立即退出；站稳则按${target}元目标管理`
    result.futurePlan = result.futurePlan
      || `最迟第5个交易日未达到${target}元则退出，不转为长线持有`
    if (positionCap.capped) {
      result.positionNote =
        `按原计划总仓位不超过${positionCap.limitPct}%，本次最多买入${quantity}手`
    }
  } else {
    result.buyPrice = null
    result.buyZone = null
    result.stopPrice = null
    result.targetPrice = null
    result.planAmount = 0
    result.actionPlan = outcome === '放弃买入'
      ? `放弃本次买入：${reason}；本轮结束，不再设置新的复核价格`
      : `维持观望：${reason}；原触发价已经消费，不再设置新的复核价格`
    result.invalidation = '本次价格触发已经完成，不再沿用原触发价'
  }
  result.nextAction = result.actionPlan
  result.nextOpenPlan = result.nextOpenPlan
    || '下一交易时段沿用本次终局结论，不围绕原触发价再次复核'
  result.futurePlan = result.futurePlan
    || '最迟第5个交易日按现有止损、目标和仓位纪律退出或减仓'
  result.reason = reason
  if (!usefulEvidence(result.techNote) && bases[0]) {
    result.techNote = bases[0].summary
  }
  result.reviewDecision = reviewDecisionRecord({
    outcome,
    operation: outcome === '立即买入' ? '买入' : '不操作',
    range,
    quantity,
    bases,
    reason,
    event,
    result,
    now,
  })
  return result
}

function holdingOperation(result = {}) {
  const raw = text(
    result.reviewDecision?.outcome
    || result.action
    || result.stance,
    80,
  )
  if (/锁定利润|锁利润|止盈/.test(raw)) return '锁利润'
  if (/清仓|止损|离场|退出/.test(raw)) return '清仓'
  if (/减仓/.test(raw)) return '减仓'
  if (/加仓|补仓|接回|买回/.test(raw)) return '加仓'
  return '不操作'
}

function normalizeHoldingReview(result, payload, bases, now) {
  const event = payload.reviewEvent || {}
  const raw = text(
    result.reviewDecision?.outcome
    || result.action
    || result.stance,
    80,
  )
  const abandonedAdd = (
    /放弃|取消|失效/.test(raw)
    && /加仓|补仓|接回|买回/.test(raw)
  )
  let operation = abandonedAdd ? '不操作' : holdingOperation(result)
  let quantity = lotsOf(
    result.reviewDecision?.quantity ?? result.opQty,
  )
  const sellable = Math.max(
    0,
    Math.trunc(finite(payload.sellableTodayQty) || 0),
  )
  if (['减仓', '锁利润', '清仓'].includes(operation)) {
    quantity = Math.min(quantity || sellable, sellable)
  }
  let range = executionRange(result, payload, operation)
  const positionCap = operation === '加仓'
    ? capRiskIncreasingLots(quantity, range.high, payload)
    : null
  if (positionCap) quantity = positionCap.quantity
  if (positionCap?.reason && !result.reason) {
    result.reason = positionCap.reason
  }
  if (
    operation !== '不操作'
    && (
      quantity <= 0
      || !(range.low > 0)
      || !(range.high > 0)
    )
  ) {
    operation = '不操作'
    quantity = 0
    range = { low: null, high: null }
  }
  const outcome = abandonedAdd ? '放弃加仓' : {
    加仓: '立即加仓',
    减仓: '立即减仓',
    锁利润: '锁定利润',
    清仓: '立即清仓',
    不操作: '维持持有',
  }[operation]
  const reason = terminalDecisionReason(
    result,
    bases,
    operation === '不操作'
      ? '触价后未满足原计划的加减仓确认条件'
      : '本轮实时证据支持立即执行',
  )

  clearReviewPrices(result)
  const action = {
    加仓: '加仓',
    减仓: '减仓',
    锁利润: '减仓',
    清仓: '清仓',
    不操作: '持有',
  }[operation]
  result.action = action
  result.stance = action
  result.title = outcome
  result.headline = outcome
  result.opQty = operation === '不操作'
    ? '无需操作'
    : `${operation}${quantity}手`
  if (operation === '加仓') {
    result.stopPrice = positive(result.stopPrice)
      || positive(payload.previousAdvice?.stopPrice)
    result.targetPrice = positive(result.targetPrice)
      || positive(payload.previousAdvice?.targetPrice)
    result.addPrice = range.low
    result.actionPlan = `立即加仓${quantity}手，执行区间${rangeText(range)}；超出区间不追`
    if (positionCap?.capped) {
      result.positionNote =
        `按原计划总仓位不超过${positionCap.limitPct}%，本次最多加仓${quantity}手`
    }
  } else if (['减仓', '锁利润', '清仓'].includes(operation)) {
    result.reducePrice = range.low
    result.actionPlan = `${outcome}${quantity}手，执行区间${rangeText(range)}；到价按计划落袋`
  } else {
    result.addPrice = null
    result.reducePrice = null
    result.actionPlan = `${outcome}：${reason}；原触发价已经消费，不再设置新的复核价格`
  }
  result.nextAction = result.actionPlan
  result.nextOpenPlan = result.nextOpenPlan
    || '下一交易时段沿用本次终局结论，不围绕原触发价再次复核'
  result.futurePlan = result.futurePlan
    || '最迟第5个交易日按现有止损、目标和仓位纪律退出或减仓'
  result.reason = reason
  if (!usefulEvidence(result.techNote) && bases[0]) {
    result.techNote = bases[0].summary
  }
  result.invalidation = result.invalidation
    || '本次价格触发已经完成，不再沿用原触发价'
  result.reviewDecision = reviewDecisionRecord({
    outcome,
    operation,
    range,
    quantity,
    bases,
    reason,
    event,
    result,
    now,
  })
  return result
}

export function normalizeTriggeredReviewDecision({
  mode = '',
  result: input = {},
  payload = {},
  now = Date.now(),
} = {}) {
  if (!isTriggeredReviewEvent(payload.reviewEvent)) return input
  const result = { ...(input || {}) }
  const bases = evidenceBasis(result, payload)
  return mode === 'buy_advice'
    ? normalizeBuyReview(result, payload, bases, now)
    : normalizeHoldingReview(result, payload, bases, now)
}

export function enforceTriggeredReviewDecisionPlan({
  mode = '',
  result: input = {},
} = {}) {
  const decision = input?.reviewDecision
  const plan = input?.decisionPlan
  if (
    decision?.terminal !== true
    || !plan
    || decision.operation === '不操作'
  ) return { result: input, changed: false }
  const expectedActions = {
    买入: ['BUY'],
    加仓: ['ADD', 'T_BUY_FIRST'],
    减仓: ['REDUCE', 'EXIT', 'T_SELL_FIRST'],
    锁利润: ['REDUCE', 'EXIT', 'T_SELL_FIRST'],
    清仓: ['EXIT'],
  }[decision.operation] || []
  const executable = expectedActions.includes(plan.action)
    && ['READY', 'MANUAL_PROBE'].includes(plan.actionability)
  if (executable) return { result: input, changed: false }

  const result = { ...input }
  const reasons = (Array.isArray(plan.blockedReasons)
    ? plan.blockedReasons
    : []).map((item) => text(item, 100)).filter(Boolean)
  const outcome = mode === 'buy_advice'
    ? '维持观望'
    : '维持持有'
  result.action = mode === 'buy_advice' ? '观望' : '持有'
  result.stance = result.action
  result.title = outcome
  result.headline = outcome
  result.planQty = 0
  result.planQtyNum = 0
  result.opQty = '无需操作'
  result.buyPrice = null
  result.buyZone = null
  result.addPrice = null
  result.reducePrice = null
  result.actionPlan = `${outcome}：${reasons.join('；') || '账户或成交约束未通过'}；本次触发结束，不新增复核价`
  result.nextAction = result.actionPlan
  result.reviewDecision = {
    ...decision,
    outcome,
    operation: '不操作',
    priceLow: null,
    priceHigh: null,
    quantity: 0,
    followUpPlan: {
      ...(decision.followUpPlan || {}),
      manualConfirmationRequired: true,
      reassessment:
        '本次触发结束，仅在新实质事件或用户主动生成时重新评估',
    },
  }
  delete result.decisionPlan
  delete result.executionPlan
  delete result.presentation
  delete result.priceContract
  return { result, changed: true }
}

export function buildTriggeredReviewFallback({
  mode = '',
  previousAdvice = {},
  payload = {},
  reason = '',
  now = Date.now(),
} = {}) {
  const result = {
    ...(previousAdvice || {}),
    action: mode === 'buy_advice' ? '维持观望' : '持有',
    stance: mode === 'buy_advice' ? '维持观望' : '持有',
    title: mode === 'buy_advice' ? '维持观望' : '维持持有',
    headline: mode === 'buy_advice' ? '维持观望' : '维持持有',
    reason: text(
      reason || '限时复核未取得完整模型结论，按原计划保持不操作',
      300,
    ),
    invalidation: '本次价格触发已经完成，不再沿用原触发价',
    nextOpenPlan: previousAdvice?.nextOpenPlan
      || '下一交易时段按最新行情重新判断，不沿用本次触发价',
    futurePlan: previousAdvice?.futurePlan
      || '等待新的独立事件或用户主动生成后再调整计划',
  }
  delete result.presentation
  delete result.decisionPlan
  delete result.executionPlan
  delete result.priceContract
  result.reviewDecision = {
    outcome: mode === 'buy_advice' ? '维持观望' : '维持持有',
  }
  return normalizeTriggeredReviewDecision({
    mode,
    result,
    payload,
    now,
  })
}
