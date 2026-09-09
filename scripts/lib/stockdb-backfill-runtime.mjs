import {
  scanFormulaSelectionCandidates,
} from '../../api/_formula_selection_data.js'
import {
  buildMarketOpportunityContext,
} from '../../shared/marketOpportunityContext.js'
import {
  buildHistoricalLedgerBatch,
  expandHistoricalLedgerBatch,
  settleHistoricalEvent,
} from './opportunity-history-backfill.mjs'
import {
  aggregateFiveMinuteBars,
  buildCausalSnapshot,
  buildCausalTrends,
  buildHistoricalMarketContext,
  normalizeDailyRow,
  normalizeMinuteRow,
} from './stockdb-replay.mjs'

function displayDate(value) {
  const date = String(value || '').replaceAll('-', '')
  return /^\d{8}$/.test(date)
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
    : null
}

export function beijingSlotTimestamp(tradeDate, slot) {
  const date = displayDate(tradeDate)
  const time = String(slot).padStart(4, '0')
  const timestamp = Date.parse(
    `${date}T${time.slice(0, 2)}:${time.slice(2)}:00+08:00`,
  )
  if (!date || !Number.isFinite(timestamp)) {
    throw new Error('StockDB历史回放时点无效')
  }
  return timestamp
}

function recentDaily(rows, tradeDate, mode, quote) {
  const date = String(tradeDate).replaceAll('-', '')
  const completed = rows
    .map(normalizeDailyRow)
    .filter((row) => row && (
      row.date < date || (mode === 'close' && row.date === date)
    ))
    .slice(-60)
    .map((row) => ({
      date: displayDate(row.date),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      amount: row.amount,
    }))
  if (mode === 'intraday') {
    completed.push({
      date: displayDate(date),
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.price,
      volume: quote.volume,
      amount: quote.amount,
    })
  }
  return completed
}

function hasSplitLikeDiscontinuity(candles) {
  const recent = candles.slice(-35)
  for (let index = 1; index < recent.length; index += 1) {
    const previous = Number(recent[index - 1]?.close)
    const current = Number(recent[index]?.open)
    if (
      previous > 0
      && current > 0
      && (current / previous > 1.45 || current / previous < 0.55)
    ) return true
  }
  return false
}

export function buildHistoricalFund(rows, tradeDate, mode) {
  const date = String(tradeDate).replaceAll('-', '')
  const visible = (Array.isArray(rows) ? rows : [])
    .filter((row) => (
      row.date < date || (mode === 'close' && row.date === date)
    ))
    .sort((left, right) => left.date.localeCompare(right.date))
  const current = mode === 'close'
    ? visible.findLast((row) => row.date === date)
    : null
  const recent = visible.slice(-5)
  const sum = (field) => {
    const values = recent
      .map((row) => Number(row?.[field]))
      .filter(Number.isFinite)
    return values.length
      ? values.reduce((total, value) => total + value, 0)
      : null
  }
  return {
    mainNetYi: current?.mainNetYi ?? null,
    retailNetYi: current?.retailNetYi ?? null,
    mainRatio: current?.mainRatio ?? null,
    main5dYi: sum('mainNetYi'),
    retail5dYi: sum('retailNetYi'),
    historyDayCount: recent.length,
  }
}

function currentDaily(rows, tradeDate) {
  const date = String(tradeDate).replaceAll('-', '')
  return rows.findLast((row) => row.date <= date) || null
}

export function groupMinuteRows(values = []) {
  const result = new Map()
  for (const value of values) {
    const row = normalizeMinuteRow(value)
    if (!row) continue
    if (!result.has(row.code)) result.set(row.code, [])
    result.get(row.code).push(row)
  }
  for (const rows of result.values()) {
    rows.sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp)
    )
  }
  return result
}

export async function scanHistoricalSlot({
  tradeDate,
  mode,
  slot,
  universeCodes,
  minutesByCode,
  dailyByCode,
  fundByCode,
} = {}) {
  const quotes = []
  const funds = new Map()
  const candles = new Map()
  const trends = new Map()
  for (const code of universeCodes) {
    const dailyRows = dailyByCode.get(code) || []
    const minuteRows = minutesByCode.get(code) || []
    const daily = currentDaily(dailyRows, tradeDate)
    const quote = buildCausalSnapshot({
      code,
      name: daily?.name || code,
      tradeDate,
      minuteRows,
      dailyHistory: dailyRows,
      slot: mode === 'close' ? '1500' : slot,
    })
    if (!quote) continue
    const fund = buildHistoricalFund(
      fundByCode.get(code) || [],
      tradeDate,
      mode,
    )
    quote.mainRatio = fund.mainRatio
    const history = recentDaily(dailyRows, tradeDate, mode, quote)
    if (history.length < 30 || hasSplitLikeDiscontinuity(history)) continue
    quotes.push(quote)
    funds.set(code, fund)
    candles.set(code, history)
    trends.set(code, buildCausalTrends(minuteRows, slot))
  }
  const marketContext = buildHistoricalMarketContext(quotes)
  const adaptiveContext = buildMarketOpportunityContext({
    marketGate: marketContext.marketGate,
  })
  marketContext.marketGate.regime.label = adaptiveContext.phase
  const now = beijingSlotTimestamp(tradeDate, slot)
  const scan = await scanFormulaSelectionCandidates({
    mode,
    marketContext,
    now,
    fetchUniverse: async () => ({
      total: quotes.length,
      inspectedCount: quotes.length,
      allList: quotes,
    }),
    fetchKline: async (code) => ({
      candles: candles.get(code) || [],
      stale: false,
    }),
    fetchTrends: async (code) => ({
      trends: trends.get(code) || [],
    }),
    fetchFund: async (code) => funds.get(code) || {},
    fetchTags: async (code) => ({
      name: currentDaily(dailyByCode.get(code) || [], tradeDate)?.name || code,
      industry: '',
      concepts: [],
    }),
    matchSector: () => ({ matched: false, sector: null }),
  })
  return buildHistoricalLedgerBatch({
    mode,
    tradeDate: displayDate(tradeDate),
    slot,
    generatedAt: now,
    scan,
    marketContext,
  })
}

export function appendBarsForCodes(
  barsByCode,
  minutesByCode,
  codes,
) {
  for (const code of codes) {
    const dailyBars = aggregateFiveMinuteBars(
      minutesByCode.get(code) || [],
    )
    if (!dailyBars.length) continue
    const existing = barsByCode.get(code) || []
    barsByCode.set(code, [...existing, ...dailyBars])
  }
}

export function settlePendingHistoricalEvents({
  pending,
  barsByCode,
  evaluatedAt,
} = {}) {
  const matured = []
  const remaining = []
  for (const item of pending) {
    const outcome = settleHistoricalEvent({
      ...item,
      bars: barsByCode.get(item.event.code) || [],
      evaluatedAt,
    })
    if (outcome.maturity === 'MATURED') matured.push(outcome)
    else remaining.push(item)
  }
  return { matured, pending: remaining }
}

export function pendingFromBatch(batch) {
  return expandHistoricalLedgerBatch(batch).map((event) => ({
    batch,
    event,
  }))
}
