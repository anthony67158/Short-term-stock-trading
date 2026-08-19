import { tradeAnalyticsRecords } from './portfolioAccounting.js'
import { beijingDayKey } from './tradingCalendar.js'
import { tradeRecordType } from './tradeIntent.js'

const DAY_MS = 86400000

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function round2(value) {
  return +finite(value).toFixed(2)
}

function parseDayKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null
  return date
}

function dayKey(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function dottedDay(date, includeYear = true) {
  const prefix = includeYear ? `${date.getUTCFullYear()}.` : ''
  return `${prefix}${String(date.getUTCMonth() + 1).padStart(2, '0')}.${String(date.getUTCDate()).padStart(2, '0')}`
}

function periodForDay(value, mode) {
  const date = parseDayKey(value)
  if (!date) return null
  if (mode === 'week') {
    const offset = (date.getUTCDay() + 6) % 7
    const start = new Date(date.getTime() - offset * DAY_MS)
    const end = new Date(start.getTime() + 6 * DAY_MS)
    return {
      key: dayKey(start),
      startKey: dayKey(start),
      endKey: dayKey(end),
      label: `${dottedDay(start)}–${dottedDay(end, start.getUTCFullYear() !== end.getUTCFullYear())}`,
    }
  }
  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    1,
  ))
  const end = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    0,
  ))
  return {
    key: dayKey(start),
    startKey: dayKey(start),
    endKey: dayKey(end),
    label: `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`,
  }
}

function recordTimestamp(record) {
  return finite(record?.sellAt ?? record?.at ?? record?.buyAt, null)
}

function recordDay(record) {
  const timestamp = recordTimestamp(record)
  return timestamp == null ? '' : beijingDayKey(timestamp)
}

function feeOf(record) {
  const type = tradeRecordType(record)
  if (type === 'BUY' || type === 'SELL') {
    return finite(record?.fee ?? (
      type === 'BUY' ? record?.buyFee : record?.sellFee
    ))
  }
  return finite(record?.buyFee) + finite(record?.sellFee)
}

function realizedPnlOf(record) {
  const value = Number(record?.realizedPnl ?? record?.netPnl)
  return Number.isFinite(value) ? value : null
}

function realizedCostBasis(record) {
  const type = tradeRecordType(record)
  if (type !== 'SELL' && type !== 'CLOSE' && type !== 'T') return null
  const qty = finite(record?.qty)
  const buyPrice = finite(
    type === 'SELL'
      ? record?.costPrice ?? record?.buyPrice
      : record?.buyPrice,
  )
  if (!(qty > 0) || !(buyPrice > 0)) return null
  return buyPrice * qty * 100 + finite(record?.buyFee)
}

export function listTradePeriods(records = [], mode = 'month') {
  const periods = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    const period = periodForDay(recordDay(record), mode)
    if (period && !periods.has(period.key)) periods.set(period.key, period)
  }
  return [...periods.values()].sort(
    (left, right) => right.startKey.localeCompare(left.startKey),
  )
}

export function summarizeTradePeriod(records = [], period = {}, options = {}) {
  const startKey = String(period.startKey || '')
  const endKey = String(period.endKey || '')
  const rawTotalAssets = Number(options.totalAssets)
  const totalAssets = Number.isFinite(rawTotalAssets) && rawTotalAssets > 0
    ? round2(rawTotalAssets)
    : null
  const periodRecords = (Array.isArray(records) ? records : []).filter(
    (record) => {
      const date = recordDay(record)
      return date && date >= startKey && date <= endKey
    },
  )
  const realized = tradeAnalyticsRecords(periodRecords)
    .map((record) => ({
      record,
      pnl: realizedPnlOf(record),
      basis: realizedCostBasis(record),
    }))
    .filter((item) => item.pnl != null)
  const rated = realized.filter((item) => item.basis > 0)
  const realizedPnl = round2(realized.reduce(
    (sum, item) => sum + item.pnl,
    0,
  ))
  const ratedPnl = round2(rated.reduce(
    (sum, item) => sum + item.pnl,
    0,
  ))
  const costBasis = round2(rated.reduce(
    (sum, item) => sum + item.basis,
    0,
  ))

  return {
    startKey,
    endKey,
    label: String(period.label || ''),
    transactionCount: periodRecords.length,
    realizedCount: realized.length,
    ratedCount: rated.length,
    realizedPnl,
    ratedPnl,
    costBasis,
    totalAssets,
    accountReturnPct: totalAssets > 0
      ? +((realizedPnl / totalAssets) * 100).toFixed(2)
      : null,
    tradeReturnPct: costBasis > 0
      ? +((ratedPnl / costBasis) * 100).toFixed(2)
      : null,
    fee: round2(periodRecords.reduce(
      (sum, record) => sum + feeOf(record),
      0,
    )),
  }
}
