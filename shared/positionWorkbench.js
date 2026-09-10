import { buildAccountRiskContext } from './accountRiskBudget.js'
import { v3DecisionPresentation } from './v3DecisionPresentation.js'
import { t1StatusOf } from './portfolioAccounting.js'
import { isContinuousTrading } from './tradingCalendar.js'
import {
  autoConfigFromSettings,
  selectAutoRefreshCodes,
} from './adviceAutoRefreshPolicy.js'
import {
  rankWatchlistCandidates,
  watchlistActionValue,
} from './watchlistRanking.js'

export const POSITION_WORKBENCH_VERSION = 'position-workbench.v1'

const ACTIVE_EXECUTION_STATES = new Set([
  'ARMED',
  'ALERTED',
  'USER_CONFIRMED',
  'PARTIALLY_RECORDED',
])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function commandPriority(command) {
  return {
    CONFLICT: 0,
    RISK_EXIT: 0,
    READY_EXIT: 1,
    RECORD: 2,
    READY: 2,
    RISK_BLOCKED: 3,
    CONFIRMING: 3,
    WAITING: 4,
    HOLDING: 5,
    EMPTY: 6,
    ENDED: 7,
  }[command.state] ?? 8
}

function executionPlanForCode(plans = [], code = '', decisionId = '') {
  return plans
    .filter((plan) =>
      plan?.code === code
      && !plan.dismissedAt
      && ACTIVE_EXECUTION_STATES.has(plan.status)
      && (['USER_CONFIRMED', 'PARTIALLY_RECORDED'].includes(plan.status)
        || (decisionId && plan.decisionId === decisionId))
    )
    .sort((left, right) =>
      Number(right.updatedAt || right.createdAt || 0)
      - Number(left.updatedAt || left.createdAt || 0)
    )[0] || null
}

function conflictsWithPlan(plan, kind) {
  if (!plan || !kind) return false
  if (plan.side === 'BUY') return ['reduce', 'sell'].includes(kind)
  if (plan.side === 'SELL') return ['buy', 'add'].includes(kind)
  return false
}

export function buildTodayCommandList({
  book = {},
  quoteMap = {},
  adviceFor = () => null,
  now = Date.now(),
  currentRisk = null,
  marketRegime = null,
} = {}) {
  const items = []
  const holding = Array.isArray(book.holding) ? book.holding : []
  const watchlist = Array.isArray(book.plan) ? book.plan : []
  const managedWatchCodes = new Set(selectAutoRefreshCodes({
    config: autoConfigFromSettings(book.settings || {}),
    holdings: holding,
    watchlist,
    scopes: ['watch'],
  }).watchCodes)
  const all = [...holding, ...watchlist]
  const seen = new Set()
  for (const item of all) {
    if (!item?.code || seen.has(item.code)) continue
    seen.add(item.code)
    const isHolding = holding.some((holdingItem) =>
      holdingItem.code === item.code
    )
    const mode = isHolding ? 'hold_advice' : 'buy_advice'
    const entry = !isHolding && !managedWatchCodes.has(String(item.code))
      ? null
      : adviceFor(item.code, mode)
    const advice = entry?.advice?.decisionSource?.engine === 'V3' ? entry.advice : null
    const quote = quoteMap[item.code] || {}
    const currentPrice = Number(quote.price) || null
    const alerts = (book.alerts || []).filter((alert) =>
      String(alert.candCode || alert.code || '') === String(item.code)
    )
    const alertPhase = alerts.find((alert) =>
      alert.phase === 'confirming'
    )
      ? 'confirming'
      : alerts.find((alert) => alert.phase === 'reviewing')
        ? 'reviewing'
        : alerts.find((alert) => alert.phase === 'watching')
          ? 'watching'
          : null
    let kind = 'hold'
    let distancePct = null
    let actionLabel = '持有'
    let keyPrice = null
    let view = null
    if (advice) {
      view = v3DecisionPresentation({
        advice, currentPrice, now,
        holdingLots: isHolding ? t1StatusOf(holding, book.closed || [], item.code, now).liveQty : 0,
        sellableLots: isHolding ? t1StatusOf(holding, book.closed || [], item.code, now).sellableToday : 0,
        stopPrice: item.sl, executionPlans: book.executionPlans || [],
      })
      kind = view?.kind || 'hold'
      actionLabel = view?.headline || '持有'
      const level = view?.levels?.[0]
      if (level?.price != null && currentPrice > 0) {
        distancePct = Math.abs(level.price / currentPrice - 1) * 100
        keyPrice = level.price
      }
    } else if (!isHolding) {
      kind = 'none'
      actionLabel = '等待V3评估'
    }
    const executionPlan = executionPlanForCode(
      book.executionPlans || [],
      item.code,
      advice?.decisionPlan?.decisionId,
    )
    const planConflict = conflictsWithPlan(executionPlan, kind)
    const executionReady = executionPlan
      && ['ALERTED', 'USER_CONFIRMED', 'PARTIALLY_RECORDED']
        .includes(executionPlan.status)
    const exitSide = ['reduce', 'sell'].includes(kind)
      || executionPlan?.side === 'SELL'
    const expired = (
      executionPlan?.validUntil
      || advice?.decisionPlan?.validUntil
      || advice?.expireAt
    )
      ? new Date(
          executionPlan?.validUntil
          || advice?.decisionPlan?.validUntil
          || advice?.expireAt,
        ).getTime() <= now
      : false
    const sameDecisionFinished = (book.executionPlans || []).some((plan) =>
      ['COMPLETED', 'CANCELED', 'EXPIRED'].includes(plan.status)
      && plan.decisionId
      && plan.decisionId === advice?.decisionPlan?.decisionId,
    )
    const stop = Number(item.sl ?? advice?.decisionPlan?.prices?.stop)
    const stopReached = isHolding
      && stop > 0
      && currentPrice > 0
      && currentPrice <= stop
      && isContinuousTrading(now)
      && quote.isLivePrice !== false
    const sellable = stopReached
      ? t1StatusOf(
          holding,
          book.closed || [],
          item.code,
          now,
        ).sellableToday
      : null
    const commandState = stopReached
      ? 'RISK_EXIT'
      : planConflict
        ? 'CONFLICT'
        : expired || sameDecisionFinished
          ? 'ENDED'
          : ['USER_CONFIRMED', 'PARTIALLY_RECORDED']
              .includes(executionPlan?.status)
            ? 'RECORD'
            : executionReady && isContinuousTrading(now)
              ? exitSide ? 'READY_EXIT' : 'READY'
              : ['confirming', 'reviewing'].includes(alertPhase)
                ? 'CONFIRMING'
                : view?.actionable === true
                    && ['buy', 'add', 'reduce', 'sell'].includes(kind)
                  ? exitSide ? 'READY_EXIT' : 'READY'
                  : executionPlan
                      || alertPhase === 'watching'
                      || view?.deferred === true
                      || kind === 'wait'
                    ? 'WAITING'
                    : advice?.reviewDecision?.terminal === true
                      ? 'ENDED'
                      : kind === 'hold' ? 'HOLDING' : 'EMPTY'
    const command = {
      code: item.code,
      name: item.name || item.code,
      isHolding,
      kind,
      state: commandState,
      actionLabel: stopReached
        ? sellable > 0
          ? '触及止损，核对退出'
          : '触及止损，今日仓位锁定'
        : planConflict
          ? '计划冲突，暂停操作'
          : executionPlan?.actionLabel || actionLabel,
      alertPhase,
      distancePct: distancePct != null
        ? +distancePct.toFixed(2)
        : null,
      keyPrice: executionPlan?.triggerPrice
        ?? executionPlan?.referencePrice
        ?? keyPrice,
      quantity: executionPlan
        ? `${executionPlan.remainingLots}/${executionPlan.targetLots}手`
        : view?.quantity || '',
      instruction: stopReached
        ? `现价${currentPrice}元已到止损${stop}元；今日可卖${sellable || 0}手，不加仓摊平`
        : planConflict
          ? '执行队列与最新决策方向相反，请先核对已有计划'
          : executionPlan?.trigger || (view ? `${view.headline}；${view.reason}` : '请更新V3决策'),
      stopPrice: executionPlan?.stopPrice
        ?? advice?.decisionPlan?.prices?.stop
        ?? null,
      riskAmount: executionPlan?.riskAmount
        ?? advice?.decisionPlan?.entryBudget?.stopLossAmount
        ?? advice?.decisionPlan?.risk?.tradeExpectancy?.plan?.lossAmount
        ?? null,
      validUntil: executionPlan?.validUntil
        ?? advice?.decisionPlan?.validUntil
        ?? advice?.expireAt
        ?? null,
      decisionId: advice?.decisionPlan?.decisionId || null,
      executionPlanId: executionPlan?.planId || null,
      actionValue: advice?.decisionSource?.state !== 'READY' ? null : isHolding
        ? finite(
            advice?.selectedV3Plan?.opportunityScore?.expectedNetR,
          )
        : watchlistActionValue(entry)?.utility ?? null,
      priority: 0,
    }
    if (command.state === 'READY') {
      const riskBlockers = currentRisk?.breaker?.blockers || []
      const accountBlocked = currentRisk
        && (
          !currentRisk.complete
          || currentRisk.breaker?.allowRiskIncrease !== true
        )
      const hardMarketBlocked = marketRegime?.hardRiskOff === true
      if (accountBlocked || hardMarketBlocked) {
        command.state = 'RISK_BLOCKED'
        command.actionLabel = '暂停新增仓位'
        command.quantity = ''
        command.keyPrice = null
        command.instruction = [
          ...riskBlockers.map((blocker) => `${blocker.message}${
            blocker.value != null && blocker.limit > 0
              ? `（当前${blocker.value}，上限${blocker.limit}）`
              : ''
          }`),
          currentRisk && !currentRisk.complete
            ? '账户或报价未完整'
            : '',
          hardMarketBlocked
            ? '市场出现确定性尾部风险，本轮不新增仓位'
            : '',
        ].filter(Boolean).join('；') || '账户风险条件变化，本轮不买入'
      }
    }
    command.priority = commandPriority(command)
    items.push(command)
  }
  return items.sort((left, right) =>
    left.priority - right.priority
    || Number(right.actionValue ?? -Infinity)
      - Number(left.actionValue ?? -Infinity)
    || Number(left.distancePct ?? Infinity)
      - Number(right.distancePct ?? Infinity)
    || String(left.code).localeCompare(String(right.code))
  )
}

function adviceForAccount(book = {}, code = '', mode = '') {
  const entry = book.advice?.[code]
  if (!entry) return null
  if (entry.advice?.decisionSource?.engine !== 'V3') return null
  if (mode && entry.mode && entry.mode !== mode) return null
  return entry
}

function projectedStock(item, command, entry, quote, managed = true) {
  const advice = entry?.advice || null
  return {
    code: item.code,
    name: item.name || quote?.name || item.code,
    managed,
    quote: quote || null,
    command: command || null,
    decisionPlan: advice?.decisionPlan || null,
    monitoringPlan: advice?.monitoringPlan || null,
    executionPlan: command?.executionPlanId || null,
    updatedAt: Number(entry?.at || entry?.updatedAt || 0),
  }
}

export function buildPositionWorkbench({
  book = {},
  quoteMap = {},
  opportunityRadar = null,
  now = Date.now(),
} = {}) {
  const accountRisk = buildAccountRiskContext(book, quoteMap, now)
  const marketContext = opportunityRadar?.opportunityContext || null
  const trackingSelection = selectAutoRefreshCodes({
    config: autoConfigFromSettings(book.settings || {}),
    holdings: book.holding || [],
    watchlist: book.plan || [],
  })
  const managedWatchCodes = new Set(trackingSelection.watchCodes)
  const adviceFor = (code, mode) => {
    if (
      mode === 'buy_advice'
      && !managedWatchCodes.has(String(code))
    ) return null
    return adviceForAccount(book, code, mode)
  }
  const actions = buildTodayCommandList({
    book,
    quoteMap,
    adviceFor,
    now,
    currentRisk: accountRisk,
    marketRegime: marketContext
      ? {
          regime: 'ADAPTIVE',
          allowRiskIncrease: true,
          hardRiskOff: marketContext.hardRisk === true,
        }
      : null,
  })
  const actionByCode = new Map(
    actions.map((action) => [action.code, action]),
  )
  const holdings = (book.holding || []).map((item) =>
    projectedStock(
      item,
      actionByCode.get(item.code),
      adviceFor(item.code, 'hold_advice'),
      quoteMap[item.code],
    )
  ).sort((left, right) => {
    const leftIndex = actions.findIndex((item) =>
      item.code === left.code
    )
    const rightIndex = actions.findIndex((item) =>
      item.code === right.code
    )
    return (
      (leftIndex < 0 ? Infinity : leftIndex)
      - (rightIndex < 0 ? Infinity : rightIndex)
    )
  })
  const rankedCandidates = (book.plan || []).map((item) => ({
    ...item,
    managed: managedWatchCodes.has(String(item.code)),
  }))
  const adviceByCode = Object.fromEntries(rankedCandidates.map((item) => [
    item.code,
    adviceFor(item.code, 'buy_advice'),
  ]))
  const rankedWatchlist = rankWatchlistCandidates(
    rankedCandidates,
    quoteMap,
    adviceByCode,
  )
  const watchlist = rankedWatchlist.map((item) =>
    projectedStock(
      item,
      actionByCode.get(item.code),
      adviceByCode[item.code],
      quoteMap[item.code],
      item.managed,
    )
  )
  const primaryAction = actions.find((action) =>
    ['CONFLICT', 'RISK_EXIT', 'READY_EXIT', 'RECORD', 'READY']
      .includes(action.state)
  ) || null
  return {
    schemaVersion: POSITION_WORKBENCH_VERSION,
    generatedAt: now,
    marketContext,
    accountRisk,
    primaryAction,
    actions,
    holdings,
    watchlist,
    opportunitySummary: opportunityRadar?.summary || null,
    runtime: {
      activeTrackingCount: trackingSelection.allCodes.length,
      observingCount: new Set((book.alerts || [])
        .filter((alert) => alert.phase === 'watching')
        .map((alert) => String(alert.candCode || alert.code || ''))
        .filter(Boolean)).size,
      reviewingCount: new Set((book.alerts || [])
        .filter((alert) =>
          ['reviewing', 'confirming'].includes(alert.phase)
        )
        .map((alert) => String(alert.candCode || alert.code || ''))
        .filter(Boolean)).size,
    },
  }
}
