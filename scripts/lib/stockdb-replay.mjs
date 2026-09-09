import {
  resolveAshareTradingRule,
} from '../../shared/priceLimitPolicy.js'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 4) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function compactDate(value) {
  const match = String(value || '').match(/^(\d{4})-?(\d{2})-?(\d{2})/)
  return match ? `${match[1]}${match[2]}${match[3]}` : null
}

function displayDate(value) {
  const date = compactDate(value)
  return date
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
    : null
}

function rowObject(row, fields = []) {
  if (row && !Array.isArray(row) && typeof row === 'object') return row
  if (!Array.isArray(row) || row.length !== fields.length) return null
  return Object.fromEntries(fields.map((field, index) => [field, row[index]]))
}

export function normalizeStockDbRows(rows, fields = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => rowObject(row, fields))
    .filter(Boolean)
}

export function normalizeDailyRow(value = {}) {
  const code = String(value.code ?? value.sec_code ?? '')
  const date = compactDate(value.date ?? value.trade_date)
  if (!/^\d{6}$/.test(code) || !date) return null
  const isSt = value.is_st === true
    || Number(value.is_st) === 1
    || /(?:\*?ST)/i.test(String(value.name || ''))
  const name = String(value.name || code)
  return {
    date,
    code,
    name: isSt && !/(?:\*?ST)/i.test(name) ? `ST${name}` : name,
    open: finite(value.open),
    high: finite(value.high),
    low: finite(value.low),
    close: finite(value.close),
    preClose: finite(value.pre_close ?? value.preClose),
    volume: finite(value.volume ?? value.vol),
    amount: finite(value.amount ?? value.money),
    turnover: finite(value.turnover_rate ?? value.turnover),
    volumeRatio: finite(value.vol_ratio ?? value.volume_ratio),
    floatShare: finite(value.float_share ?? value.circulating_share),
    isSt,
  }
}

function yiValue(value, unit) {
  const number = finite(value)
  if (number == null) return null
  if (unit === 'wan') return number / 10_000
  if (unit === 'yuan') return number / 100_000_000
  return number
}

export function normalizeFundRow(value = {}) {
  const code = String(value.code ?? value.sec_code ?? '')
  const date = compactDate(value.date ?? value.trade_date)
  if (!/^\d{6}$/.test(code) || !date) return null
  const mainNetYi =
    yiValue(value.mainNetYi, 'yi')
    ?? yiValue(value.net_amount_main, 'wan')
    ?? yiValue(value.main_net_amount_wan, 'wan')
    ?? yiValue(value.main_net_inflow, 'yuan')
  const retailNetYi =
    yiValue(value.retailNetYi ?? value.smallNetYi, 'yi')
    ?? yiValue(value.net_amount_s, 'wan')
    ?? yiValue(value.small_net_amount_wan, 'wan')
    ?? yiValue(value.small_net_inflow, 'yuan')
  return {
    date,
    code,
    mainNetYi: rounded(mainNetYi, 6),
    retailNetYi: rounded(retailNetYi, 6),
    mainRatio: rounded(
      value.mainRatio ?? value.net_pct_main ?? value.main_net_pct,
      6,
    ),
  }
}

export function normalizeMinuteRow(value = {}) {
  const code = String(value.code ?? value.sec_code ?? '')
  const timestamp = String(
    value.timestamp ?? value.date ?? value.trade_time ?? '',
  )
    .replace(/\D/g, '')
  if (!/^\d{6}$/.test(code) || !/^\d{14}$/.test(timestamp)) return null
  return {
    timestamp,
    date: timestamp.slice(0, 8),
    code,
    name: String(value.name || code),
    open: finite(value.open),
    high: finite(value.high),
    low: finite(value.low),
    close: finite(value.close ?? value.price),
    preClose: finite(value.pre_close ?? value.preClose),
    volume: finite(value.volume ?? value.vol) ?? 0,
    amount: finite(value.amount ?? value.money) ?? 0,
  }
}

function tradingMinute(timestamp) {
  const hour = Number(timestamp.slice(8, 10))
  const minute = Number(timestamp.slice(10, 12))
  const minuteOfDay = hour * 60 + minute
  if (minuteOfDay >= 570 && minuteOfDay <= 690) {
    return minuteOfDay - 570
  }
  if (minuteOfDay >= 780 && minuteOfDay <= 900) {
    return minuteOfDay === 780 ? 121 : 120 + minuteOfDay - 780
  }
  return null
}

function alignedTimestamp(timestamp, interval = 5) {
  const elapsed = tradingMinute(timestamp)
  if (elapsed == null) return null
  const groupEnd = elapsed <= 0
    ? interval
    : (Math.floor((elapsed - 1) / interval) + 1) * interval
  const bounded = Math.min(groupEnd, 240)
  const minuteOfDay = bounded <= 120
    ? 570 + bounded
    : 780 + bounded - 120
  const hour = Math.floor(minuteOfDay / 60)
  const minute = minuteOfDay % 60
  return timestamp.slice(0, 8)
    + String(hour).padStart(2, '0')
    + String(minute).padStart(2, '0')
    + '00'
}

export function aggregateFiveMinuteBars(values = []) {
  const rows = values
    .map(normalizeMinuteRow)
    .filter(Boolean)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  const groups = new Map()
  for (const row of rows) {
    const key = alignedTimestamp(row.timestamp)
    if (!key) continue
    const group = groups.get(key) || []
    group.push(row)
    groups.set(key, group)
  }
  let previousClose = null
  return [...groups.entries()].map(([timestamp, items]) => {
    const first = items[0]
    const last = items.at(-1)
    const result = {
      date: displayDate(timestamp),
      tradeTime:
        `${displayDate(timestamp)} `
        + `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:00`,
      code: last.code,
      open: first.open,
      high: Math.max(...items.map((item) => item.high)),
      low: Math.min(...items.map((item) => item.low)),
      close: last.close,
      volume: items.reduce((sum, item) => sum + item.volume, 0),
      amount: items.reduce((sum, item) => sum + item.amount, 0),
      preClose: first.preClose ?? previousClose,
    }
    previousClose = result.close
    return result
  })
}

function average(values) {
  const rows = values.filter((value) => finite(value) != null)
  return rows.length
    ? rows.reduce((sum, value) => sum + Number(value), 0) / rows.length
    : null
}

function priceBand(code, name, tradeDate, previousClose) {
  if (!(previousClose > 0)) return { up: null, down: null }
  const rule = resolveAshareTradingRule(
    { code, name },
    displayDate(tradeDate),
  )
  return {
    up: rounded(previousClose * (1 + rule.priceLimitRatio), 2),
    down: rounded(previousClose * (1 - rule.priceLimitRatio), 2),
  }
}

export function buildCausalSnapshot({
  code,
  name,
  tradeDate,
  minuteRows = [],
  dailyHistory = [],
  slot = '1500',
} = {}) {
  const date = compactDate(tradeDate)
  const cutoff = `${date}${String(slot).padStart(4, '0')}59`
  const minutes = minuteRows
    .map(normalizeMinuteRow)
    .filter((row) =>
      row
      && row.code === String(code)
      && row.date === date
      && row.timestamp <= cutoff
    )
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  if (!minutes.length) return null
  const completedDaily = dailyHistory
    .map(normalizeDailyRow)
    .filter((row) => row && row.code === String(code) && row.date < date)
    .sort((left, right) => left.date.localeCompare(right.date))
  const previous = completedDaily.at(-1)
  const previousClose = previous?.close ?? minutes[0].preClose
  if (!(previousClose > 0)) return null
  const currentVolume = minutes.reduce((sum, row) => sum + row.volume, 0)
  const currentAmount = minutes.reduce((sum, row) => sum + row.amount, 0)
  const previousVolume = finite(previous?.volume)
  const previousTurnover = finite(previous?.turnover)
  const turnover = previousVolume > 0 && previousTurnover != null
    ? currentVolume / previousVolume * previousTurnover
    : null
  const averageDailyVolume = average(
    completedDaily.slice(-5).map((row) => row.volume),
  )
  const observedMinutes = Math.max(1, minutes.length)
  const volumeRatio = averageDailyVolume > 0
    ? (currentVolume / observedMinutes) / (averageDailyVolume / 240)
    : null
  const last = minutes.at(-1)
  const band = priceBand(code, name || last.name, date, previousClose)
  return {
    code: String(code),
    name: String(name || last.name || code),
    tradeDate: displayDate(date),
    price: last.close,
    preClose: previousClose,
    open: minutes[0].open,
    high: Math.max(...minutes.map((row) => row.high)),
    low: Math.min(...minutes.map((row) => row.low)),
    volume: currentVolume,
    amount: currentAmount,
    turnover: rounded(turnover),
    volumeRatio: rounded(volumeRatio),
    pct: rounded((last.close / previousClose - 1) * 100),
    mainRatio: null,
    limitUpPrice: band.up,
    limitDownPrice: band.down,
  }
}

export function buildCausalTrends(minuteRows = [], slot = '1500') {
  const cutoff = String(slot).padStart(4, '0')
  const rows = minuteRows
    .map(normalizeMinuteRow)
    .filter((row) => row && row.timestamp.slice(8, 12) <= cutoff)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  let amount = 0
  let volume = 0
  return rows.map((row) => {
    amount += row.amount
    volume += row.volume
    return {
      time: `${row.timestamp.slice(8, 10)}:${row.timestamp.slice(10, 12)}`,
      price: row.close,
      avg: volume > 0 ? amount / volume : null,
    }
  })
}

export function buildHistoricalMarketContext(quotes = []) {
  const valid = quotes.filter((quote) => finite(quote?.pct) != null)
  const up = valid.filter((quote) => quote.pct > 0.1).length
  const down = valid.filter((quote) => quote.pct < -0.1).length
  const flat = valid.length - up - down
  const limitUp = valid.filter(
    (quote) => quote.limitUpPrice > 0 && quote.price >= quote.limitUpPrice,
  ).length
  const limitDown = valid.filter(
    (quote) => quote.limitDownPrice > 0 && quote.price <= quote.limitDownPrice,
  ).length
  const balance = valid.length ? (up - down) / valid.length : 0
  const score = Math.max(0, Math.min(100, 50 + balance * 50))
  return {
    marketGate: {
      allowed: true,
      riskTier: score >= 52 ? 'STANDARD' : 'CAUTIOUS',
      regime: {
        score: rounded(score, 1),
        breadth: { up, down, flat, limitUp, limitDown },
        sentiment: { breakRatePct: 25 },
        hardRiskOff: false,
      },
      blockers: [],
    },
    latest: null,
    intraday: null,
  }
}
