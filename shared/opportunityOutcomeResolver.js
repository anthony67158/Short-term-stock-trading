import {
  A_SHARE_STANDARD_FEE_POLICY,
  assessAshareExecution,
} from './ashareStrategyExecution.js'

export const OPPORTUNITY_OUTCOME_SCHEMA_VERSION =
  'opportunity-outcome.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 4) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function dateKey(value) {
  const match = String(value || '').match(
    /(\d{4})-?(\d{2})-?(\d{2})/,
  )
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function barTimestamp(bar, date) {
  const direct = finite(bar?.at ?? bar?.timestamp)
  if (direct != null && direct > 0) return direct
  const source = String(
    bar?.tradeTime || bar?.dateTime || bar?.datetime || '',
  ).trim()
  if (source && /\d{1,2}:\d{2}/.test(source)) {
    const normalized = source.includes('T')
      ? source
      : source.replace(' ', 'T')
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
      ? normalized
      : `${normalized}+08:00`
    const parsed = Date.parse(zoned)
    return Number.isFinite(parsed) ? parsed : null
  }
  const time = String(bar?.time || '').trim()
  if (date && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(time)) {
    const parsed = Date.parse(
      `${date}T${time.length === 5 ? `${time}:00` : time}+08:00`,
    )
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeBars(values, event) {
  const rows = (Array.isArray(values) ? values : [])
    .map((bar, index) => {
      const date = dateKey(
        bar?.date || bar?.tradeDate || bar?.tradeTime,
      )
      return {
        index,
        date,
        at: barTimestamp(bar, date),
        open: finite(bar?.open ?? bar?.price),
        high: finite(bar?.high ?? bar?.price ?? bar?.close),
        low: finite(bar?.low ?? bar?.price ?? bar?.close),
        close: finite(bar?.close ?? bar?.price),
        volume: finite(bar?.volume),
        preClose: finite(bar?.preClose),
      }
    })
    .filter((bar) => (
      bar.date
      && bar.open > 0
      && bar.high > 0
      && bar.low > 0
      && bar.close > 0
      && bar.high >= bar.low
    ))
    .sort((left, right) => (
      left.date.localeCompare(right.date)
      || (
        left.at != null && right.at != null
          ? left.at - right.at
          : left.index - right.index
      )
    ))

  let previousSessionClose = null
  let sessionDate = null
  let sessionPreClose = null
  let lastClose = null
  for (const row of rows) {
    if (row.date !== sessionDate) {
      previousSessionClose = lastClose ?? previousSessionClose
      sessionDate = row.date
      sessionPreClose = row.preClose
        ?? (
          row.date === dateKey(event?.tradeDate)
            ? finite(event?.quote?.preClose)
            : previousSessionClose
        )
    }
    row.preClose = row.preClose ?? sessionPreClose
    lastClose = row.close
  }
  return rows
}

function baseResult(event, evaluatedAt) {
  return {
    schemaVersion: OPPORTUNITY_OUTCOME_SCHEMA_VERSION,
    decisionId: String(event?.decisionId || ''),
    code: String(event?.code || ''),
    formulaId: String(event?.decision?.formulaId || ''),
    signalAt: finite(event?.asOf),
    signalTradeDate: dateKey(event?.tradeDate),
    evaluatedAt,
    maturity: 'PENDING',
    outcome: 'DATA_INCOMPLETE',
    fillStatus: 'UNKNOWN',
    exitStatus: 'NOT_APPLICABLE',
    trigger: null,
    entry: null,
    exit: null,
    metrics: null,
    observations: {
      bars: 0,
      sessions: 0,
      entryWindowBars: 0,
      t1LockedStopHit: false,
      t1LockedTargetHit: false,
      pathAmbiguous: false,
      blockedExitAttempts: 0,
    },
  }
}

function sessionBoundaryAt(date, hour, minute) {
  const parsed = Date.parse(
    `${date}T${String(hour).padStart(2, '0')}:`
      + `${String(minute).padStart(2, '0')}:00+08:00`,
  )
  return Number.isFinite(parsed) ? parsed : null
}

function intradayWindowEnd(event) {
  const date = dateKey(event?.tradeDate)
  const signalAt = finite(event?.asOf)
  const validUntil = finite(event?.decision?.validUntil)
  if (!date || signalAt == null) return validUntil
  const morningClose = sessionBoundaryAt(date, 11, 30)
  const dayClose = sessionBoundaryAt(date, 15, 0)
  const sessionEnd = signalAt <= morningClose
    ? morningClose
    : dayClose
  return validUntil == null
    ? sessionEnd
    : Math.min(validUntil, sessionEnd)
}

function isSessionCloseBar(bar) {
  if (bar?.at == null) return true
  const local = new Date(bar.at + 8 * 60 * 60 * 1000)
  return local.getUTCHours() === 15
    && local.getUTCMinutes() === 0
}

function terminalWithoutFill(base, {
  outcome,
  fillStatus,
  trigger = null,
  entry = null,
  entryWindowBars = 0,
}) {
  return {
    ...base,
    maturity: 'MATURED',
    outcome,
    fillStatus,
    trigger,
    entry,
    observations: {
      ...base.observations,
      entryWindowBars,
    },
  }
}

function entryWindow(event, rows, evaluatedAt) {
  const mode = String(event?.mode || '').toUpperCase()
  const signalDate = dateKey(event?.tradeDate)
  const signalAt = finite(event?.asOf)
  if (mode === 'INTRADAY') {
    const windowEnd = intradayWindowEnd(event)
    const exact = rows.filter((bar) => (
      bar.date === signalDate
      && bar.at != null
      && (signalAt == null || bar.at > signalAt)
      && (windowEnd == null || bar.at <= windowEnd)
    ))
    return {
      rows: exact,
      complete: exact.length > 0
        && windowEnd != null
        && evaluatedAt > windowEnd
        && exact.at(-1).at >= windowEnd - 5 * 60 * 1000,
      requiresTimestamp: true,
    }
  }
  const future = rows.filter((bar) => bar.date > signalDate)
  const firstDate = future[0]?.date
  return {
    rows: firstDate
      ? future.filter((bar) => bar.date === firstDate)
      : [],
    complete: !!firstDate && (
      future[0]?.at == null
      || isSessionCloseBar(
        future.filter((bar) => bar.date === firstDate).at(-1),
      )
    ),
    requiresTimestamp: false,
  }
}

function triggered(bar, decision) {
  const primary = finite(decision?.primaryPrice)
  if (!(primary > 0)) return false
  return decision?.priceType === 'PULLBACK_WATCH'
    ? bar.low <= primary && bar.close >= primary
    : bar.high >= primary && bar.close >= primary
}

function executionView(outcome, bar, referencePrice) {
  if (!outcome?.fillable) {
    return {
      at: bar.at,
      date: bar.date,
      referencePrice: rounded(referencePrice),
      rejectionReason: outcome?.reason || 'UNKNOWN',
    }
  }
  return {
    at: bar.at,
    date: bar.date,
    tradeDate: outcome.tradeDate,
    referencePrice: rounded(referencePrice),
    fillPrice: outcome.fillPrice,
    quantity: outcome.quantity,
    grossAmount: outcome.grossAmount,
    fees: outcome.fees,
    cashFlow: outcome.cashFlow,
    ruleVersion: outcome.ruleVersion,
  }
}

function rejectionOutcome(reason) {
  if (reason === 'LIMIT_UP_UNFILLED') return 'LIMIT_UP_UNFILLED'
  if (reason === 'SUSPENDED_OR_NO_LIQUIDITY') {
    return 'TRIGGERED_UNFILLED'
  }
  return 'ENTRY_REJECTED'
}

function exitReference(reason, bar, stopPrice, targetPrice) {
  if (reason === 'STOP' || reason === 'AMBIGUOUS_STOP') {
    return Math.min(bar.open, stopPrice)
  }
  if (reason === 'TARGET') return targetPrice
  return bar.close
}

function exitOutcome(reason) {
  if (reason === 'TARGET') {
    return { outcome: 'TAKE_PROFIT', exitStatus: 'TARGET_FILLED' }
  }
  if (reason === 'AMBIGUOUS_STOP') {
    return {
      outcome: 'AMBIGUOUS_STOP_LOSS',
      exitStatus: 'AMBIGUOUS_STOP_FILLED',
    }
  }
  if (reason === 'TIME') {
    return { outcome: 'TIME_EXIT', exitStatus: 'TIME_FILLED' }
  }
  return { outcome: 'STOP_LOSS', exitStatus: 'STOP_FILLED' }
}

function completedMetrics(entry, exit, extremes, {
  stopPrice,
  sessionCount,
}) {
  const netPnl = rounded(entry.cashFlow + exit.cashFlow, 2)
  const costCash = Math.abs(entry.cashFlow)
  const initialRiskCash = (
    entry.fillPrice > stopPrice
      ? (entry.fillPrice - stopPrice) * entry.quantity
      : null
  )
  return {
    netPnl,
    netReturnPct: costCash > 0
      ? rounded(netPnl / costCash * 100, 3)
      : null,
    netR: initialRiskCash > 0
      ? rounded(netPnl / initialRiskCash, 3)
      : null,
    initialRiskCash: rounded(initialRiskCash, 2),
    totalFees: rounded(entry.fees.total + exit.fees.total, 2),
    mfePct: extremes.high > 0
      ? rounded((extremes.high / entry.fillPrice - 1) * 100, 3)
      : null,
    maePct: extremes.low > 0
      ? rounded((extremes.low / entry.fillPrice - 1) * 100, 3)
      : null,
    holdingTradingSessions: sessionCount,
  }
}

export function resolveOpportunityOutcome({
  event,
  bars = [],
  evaluatedAt = Date.now(),
  quantity = 100,
  lotSize = 100,
  slippageBps = 5,
  feePolicy = A_SHARE_STANDARD_FEE_POLICY,
} = {}) {
  const timestamp = finite(evaluatedAt)
  if (!(timestamp > 0)) throw new Error('机会结果结算时间无效')
  if (!/^\d{6}$/.test(String(event?.code || ''))) {
    throw new Error('机会结果股票代码无效')
  }
  if (!dateKey(event?.tradeDate)) {
    throw new Error('机会结果交易日期无效')
  }
  const base = baseResult(event, timestamp)
  const decision = event?.decision || {}
  const entryPrice = finite(decision.primaryPrice)
  const stopPrice = finite(decision.stopPrice)
  const targetPrice = finite(decision.targetPrice)
  if (
    decision.priceContractValid !== true
    || !(entryPrice > 0)
    || !(stopPrice > 0 && stopPrice < entryPrice)
    || !(targetPrice > entryPrice)
  ) {
    return terminalWithoutFill(base, {
      outcome: 'NOT_ELIGIBLE',
      fillStatus: 'NOT_APPLICABLE',
    })
  }

  const rows = normalizeBars(bars, event)
  const sessions = [...new Set(rows.map((bar) => bar.date))]
  base.observations.bars = rows.length
  base.observations.sessions = sessions.length
  const window = entryWindow(event, rows, timestamp)
  base.observations.entryWindowBars = window.rows.length
  if (window.requiresTimestamp && !window.rows.length) return base
  if (!window.rows.length) return base

  const triggerBar = window.rows.find((bar) => triggered(bar, decision))
  if (!triggerBar) {
    if (!window.complete) return base
    return terminalWithoutFill(base, {
      outcome: 'NOT_TRIGGERED',
      fillStatus: 'NOT_TRIGGERED',
      entryWindowBars: window.rows.length,
    })
  }
  const trigger = {
    at: triggerBar.at,
    date: triggerBar.date,
    type: String(decision.priceType || ''),
    price: entryPrice,
  }
  const triggerIndex = rows.indexOf(triggerBar)
  const entryBar = rows[triggerIndex + 1]
  const validUntil = finite(decision.validUntil)
  const entryWindowExpired = (
    triggerBar.at != null
    && entryBar
    && (
      entryBar.date !== triggerBar.date
      || entryBar.at == null
      || (
        String(event.mode || '').toUpperCase() === 'INTRADAY'
        && validUntil != null
        && entryBar.at > validUntil
      )
    )
  )
  if (entryWindowExpired) {
    return terminalWithoutFill(base, {
      outcome: 'TRIGGERED_WINDOW_EXPIRED',
      fillStatus: 'TRIGGERED_UNFILLED',
      trigger,
      entryWindowBars: window.rows.length,
    })
  }
  if (!entryBar) {
    if (window.complete) {
      return terminalWithoutFill(base, {
        outcome: 'TRIGGERED_WINDOW_EXPIRED',
        fillStatus: 'TRIGGERED_UNFILLED',
        trigger,
        entryWindowBars: window.rows.length,
      })
    }
    return {
      ...base,
      outcome: 'TRIGGERED_PENDING',
      fillStatus: 'TRIGGERED_PENDING',
      trigger,
    }
  }

  const entryExecution = assessAshareExecution({
    side: 'BUY',
    security: {
      code: event.code,
      name: event.name,
    },
    tradeDate: entryBar.date,
    previousClose: entryBar.preClose,
    openPrice: entryBar.open,
    volume: entryBar.volume,
    quantity,
    lotSize,
    slippageBps,
    feePolicy,
  })
  const entry = executionView(entryExecution, entryBar, entryBar.open)
  if (!entryExecution.fillable) {
    if (entryExecution.reason === 'INVALID_PREVIOUS_CLOSE') {
      return {
        ...base,
        outcome: 'DATA_INCOMPLETE',
        fillStatus: 'UNKNOWN',
        trigger,
        entry,
      }
    }
    return terminalWithoutFill(base, {
      outcome: rejectionOutcome(entryExecution.reason),
      fillStatus: 'TRIGGERED_UNFILLED',
      trigger,
      entry,
      entryWindowBars: window.rows.length,
    })
  }
  if (
    entryExecution.fillPrice <= stopPrice
    || entryExecution.fillPrice >= targetPrice
  ) {
    return terminalWithoutFill(base, {
      outcome: 'ENTRY_PRICE_INVALIDATED',
      fillStatus: 'TRIGGERED_UNFILLED',
      trigger,
      entry: {
        ...entry,
        rejectionReason: 'ENTRY_PRICE_OUTSIDE_CONTRACT',
      },
      entryWindowBars: window.rows.length,
    })
  }

  const entryIndex = rows.indexOf(entryBar)
  const holdingRows = rows.slice(entryIndex)
  const holdingDates = [...new Set(
    holdingRows.map((bar) => bar.date),
  )]
  const sessionOrdinals = new Map(
    holdingDates.map((date, index) => [date, index + 1]),
  )
  const timeStopTradingDays = Math.max(
    1,
    Math.trunc(finite(decision.timeStopTradingDays) || 5),
  )
  const observations = {
    ...base.observations,
  }
  const extremes = {
    high: entryExecution.fillPrice,
    low: entryExecution.fillPrice,
  }
  let forcedExit = null
  let lastExitRejection = null

  for (let index = 0; index < holdingRows.length; index += 1) {
    const bar = holdingRows[index]
    extremes.high = Math.max(extremes.high, bar.high)
    extremes.low = Math.min(extremes.low, bar.low)
    const hitStop = bar.low <= stopPrice
    const hitTarget = bar.high >= targetPrice
    if (bar.date === entryBar.date) {
      observations.t1LockedStopHit ||= hitStop
      observations.t1LockedTargetHit ||= hitTarget
      if (hitStop) forcedExit = 'STOP'
      continue
    }

    let reason = forcedExit
    if (!reason) {
      if (hitStop && hitTarget) {
        reason = 'AMBIGUOUS_STOP'
        observations.pathAmbiguous = true
      } else if (hitStop) {
        reason = 'STOP'
      } else if (hitTarget) {
        reason = 'TARGET'
      } else {
        const session = sessionOrdinals.get(bar.date) || 1
        const next = holdingRows[index + 1]
        const endOfSession = !next || next.date !== bar.date
        if (
          session >= timeStopTradingDays
          && endOfSession
          && isSessionCloseBar(bar)
        ) {
          reason = 'TIME'
        }
      }
    }
    if (!reason) continue

    const referencePrice = forcedExit
      ? bar.open
      : exitReference(reason, bar, stopPrice, targetPrice)
    const exitExecution = assessAshareExecution({
      side: 'SELL',
      security: {
        code: event.code,
        name: event.name,
      },
      tradeDate: bar.date,
      acquiredDate: entryBar.date,
      previousClose: bar.preClose,
      openPrice: referencePrice,
      volume: bar.volume,
      quantity,
      lotSize,
      slippageBps,
      feePolicy,
    })
    if (!exitExecution.fillable) {
      lastExitRejection = exitExecution.reason
      if ([
        'LIMIT_DOWN_UNFILLED',
        'SUSPENDED_OR_NO_LIQUIDITY',
      ].includes(exitExecution.reason)) {
        forcedExit = reason
        observations.blockedExitAttempts += 1
        continue
      }
      return {
        ...base,
        outcome: 'DATA_INCOMPLETE',
        fillStatus: 'FILLED',
        exitStatus: 'UNKNOWN',
        trigger,
        entry,
        observations,
      }
    }

    const exit = executionView(
      exitExecution,
      bar,
      referencePrice,
    )
    const finalState = exitOutcome(reason)
    return {
      ...base,
      ...finalState,
      maturity: 'MATURED',
      fillStatus: 'FILLED',
      trigger,
      entry,
      exit,
      metrics: completedMetrics(entryExecution, exitExecution, extremes, {
        stopPrice,
        sessionCount: sessionOrdinals.get(bar.date) || 1,
      }),
      observations,
    }
  }

  if (forcedExit && lastExitRejection) {
    return {
      ...base,
      outcome: lastExitRejection === 'LIMIT_DOWN_UNFILLED'
        ? 'EXIT_BLOCKED_LIMIT_DOWN'
        : 'EXIT_BLOCKED',
      fillStatus: 'FILLED',
      exitStatus: lastExitRejection === 'LIMIT_DOWN_UNFILLED'
        ? 'LIMIT_DOWN_BLOCKED'
        : 'EXIT_PENDING',
      trigger,
      entry,
      observations,
    }
  }
  if (forcedExit) {
    return {
      ...base,
      outcome: 'OPEN_T1_LOCKED',
      fillStatus: 'FILLED',
      exitStatus: 'T1_LOCKED',
      trigger,
      entry,
      observations,
    }
  }
  const onlyEntrySession = holdingDates.length <= 1
  return {
    ...base,
    outcome: onlyEntrySession
      ? 'OPEN_T1_LOCKED'
      : 'OPEN',
    fillStatus: 'FILLED',
    exitStatus: onlyEntrySession ? 'T1_LOCKED' : 'OPEN',
    trigger,
    entry,
    observations,
  }
}
