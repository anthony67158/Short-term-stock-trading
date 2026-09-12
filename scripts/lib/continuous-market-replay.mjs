import fs from 'node:fs'
import zlib from 'node:zlib'

import {
  assessAshareExecution,
} from '../../shared/ashareStrategyExecution.js'
import {
  buildCausalSnapshot,
  buildCausalTrends,
  buildHistoricalMarketContext,
} from './stockdb-replay.mjs'
import {
  buildHistoricalFund,
} from './stockdb-backfill-runtime.mjs'

function readGzipJson(path) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path)))
}

function rowsByCode(rows, wantedCodes) {
  const result = new Map()
  for (const row of rows) {
    if (wantedCodes && !wantedCodes.has(String(row?.code || ''))) continue
    const code = String(row?.code || '')
    if (!/^\d{6}$/.test(code)) continue
    if (!result.has(code)) result.set(code, [])
    result.get(code).push(row)
  }
  for (const values of result.values()) {
    values.sort((left, right) =>
      String(left.date).localeCompare(String(right.date)))
  }
  return result
}

function displayDate(value) {
  const date = String(value || '').replaceAll('-', '')
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
}

export function minuteTimestamp(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (!/^\d{14}$/.test(digits)) {
    throw new Error(`历史分钟时间无效:${value}`)
  }
  return Date.parse(
    `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    + `T${digits.slice(8, 10)}:${digits.slice(10, 12)}:`
    + `${digits.slice(12, 14)}+08:00`,
  )
}

export function minuteSlot(value) {
  const digits = String(value || '').replace(/\D/g, '')
  return digits.slice(8, 12)
}

export function loadContinuousMarketData({
  root,
  dates,
  codes,
} = {}) {
  const selectedDates = [...new Set(dates || [])].sort()
  const selectedCodes = new Set(codes || [])
  if (!selectedDates.length || !selectedCodes.size) {
    throw new Error('连续市场缺少交易日或股票')
  }
  const dailyByCode = rowsByCode(
    readGzipJson(`${root}/daily.json.gz`),
    selectedCodes,
  )
  const fundByCode = rowsByCode(
    readGzipJson(`${root}/funds.json.gz`),
    selectedCodes,
  )
  const minutesByDate = new Map()
  const breadthByDate = new Map()
  for (const date of selectedDates) {
    const source = readGzipJson(`${root}/minutes/${date}.json.gz`)
    const selected = new Map()
    for (const code of selectedCodes) {
      const rows = source.codes?.[code] || []
      if (rows.length) selected.set(code, rows)
    }
    minutesByDate.set(date, selected)
    breadthByDate.set(date, source.codes || {})
  }
  return {
    dates: selectedDates,
    codes: [...selectedCodes],
    dailyByCode,
    fundByCode,
    minutesByDate,
    breadthByDate,
  }
}

function currentBreadthQuotes(codes, index) {
  const quotes = []
  for (const [code, rows] of Object.entries(codes || {})) {
    const bar = rows?.[Math.min(index, rows.length - 1)]
    const price = Number(bar?.close)
    const preClose = Number(bar?.pre_close ?? bar?.preClose)
    if (!(price > 0 && preClose > 0)) continue
    quotes.push({
      code,
      price,
      pct: (price / preClose - 1) * 100,
      limitUpPrice: preClose * 1.1,
      limitDownPrice: preClose * 0.9,
    })
  }
  return quotes
}

export function buildContinuousFrame(dataset, date, index) {
  const selected = dataset.minutesByDate.get(date)
  if (!selected?.size) throw new Error(`历史分钟行情缺失:${date}`)
  const firstRows = selected.values().next().value
  const anchor = firstRows?.[index]
  if (!anchor) throw new Error(`历史分钟序号无效:${date}/${index}`)
  const now = minuteTimestamp(anchor.date)
  const slot = minuteSlot(anchor.date)
  const quotes = []
  const details = new Map()
  const trends = new Map()
  const funds = new Map()
  const bars = new Map()
  for (const code of dataset.codes) {
    const minuteRows = selected.get(code) || []
    const bar = minuteRows[index]
    if (!bar) continue
    const dailyRows = dataset.dailyByCode.get(code) || []
    const quote = buildCausalSnapshot({
      code,
      name: dailyRows.findLast((row) => row.date <= date)?.name || code,
      tradeDate: date,
      minuteRows,
      dailyHistory: dailyRows,
      slot,
    })
    if (!quote) continue
    const liveQuote = {
      ...quote,
      asOf: new Date(now).toISOString(),
      live: true,
      isLivePrice: true,
      priceStatus: 'LIVE',
      volumeRatio: quote.volumeRatio,
      volRatio: quote.volumeRatio,
    }
    quotes.push(liveQuote)
    bars.set(code, bar)
    details.set(code, {
      candles: dailyRows
        .filter((row) => row.date < date)
        .slice(-60),
    })
    trends.set(code, buildCausalTrends(minuteRows, slot))
    funds.set(
      code,
      buildHistoricalFund(
        dataset.fundByCode.get(code) || [],
        date,
        'intraday',
      ),
    )
  }
  const breadthQuotes = currentBreadthQuotes(
    dataset.breadthByDate.get(date),
    index,
  )
  const marketContext = buildHistoricalMarketContext(breadthQuotes)
  return {
    date,
    displayDate: displayDate(date),
    index,
    now,
    slot,
    quotes,
    quoteMap: Object.fromEntries(
      quotes.map((quote) => [quote.code, quote]),
    ),
    details,
    trends,
    funds,
    bars,
    market: {
      breadth: marketContext.marketGate.regime.breadth,
    },
  }
}

export function executionFromBar({
  side,
  security,
  tradeDate,
  acquiredDate,
  bar,
  lots,
  slippageBps = 5,
} = {}) {
  return assessAshareExecution({
    side,
    security,
    tradeDate,
    acquiredDate,
    previousClose: bar?.pre_close ?? bar?.preClose,
    openPrice: bar?.open,
    volume: bar?.volume,
    quantity: Number(lots) * 100,
    slippageBps,
  })
}

export function pricePathOf(bar = {}) {
  const open = Number(bar.open)
  const close = Number(bar.close)
  const high = Number(bar.high)
  const low = Number(bar.low)
  return close >= open
    ? [open, low, high, close]
    : [open, high, low, close]
}
