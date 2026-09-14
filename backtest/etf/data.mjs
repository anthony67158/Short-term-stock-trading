import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const digest = raw => createHash('sha256').update(raw).digest('hex')
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length

export function prepareHistory(history, spec, corporateActions = {}) {
  const calendar = history.calendar
  if (!Array.isArray(calendar) || !calendar.length
      || calendar.some((date, i) => !/^\d{8}$/.test(date)
        || (i > 0 && date <= calendar[i - 1]))) throw new Error('INVALID_CALENDAR')
  if (!calendar.includes(spec.start) || !calendar.includes(spec.end)) {
    throw new Error('INCOMPLETE_CALENDAR')
  }
  const calendarSet = new Set(calendar)
  const assets = spec.assets.map(definition => {
    const matches = history.assets.filter(asset => asset.code === definition.code)
    if (matches.length !== 1) throw new Error('ASSET_MISSING_OR_DUPLICATE')
    const source = matches[0]
    const actions = corporateActions[definition.code] || {}
    const splits = actions.splits || []
    const allowedSuspensions = new Set(actions.preEvaluationSuspensions || [])
    if ([...allowedSuspensions].some(date => date >= spec.start)) {
      throw new Error('EVALUATION_SUSPENSION_REQUIRES_MARK_AND_SETTLEMENT')
    }
    for (const split of splits) {
      if (!(Number.isFinite(split.ratio) && split.ratio > 0)
          || !['floor', 'ceil'].includes(split.rounding)
          || !/^\d{8}$/.test(split.priceDate) || !split.source) {
        throw new Error('INVALID_SPLIT')
      }
    }
    if (!/^\d{8}$/.test(source.basic?.list_date)) throw new Error('LIST_DATE_REQUIRED')
    if (source.basic.delist_date && source.basic.delist_date <= spec.end) {
      throw new Error('DELISTED_ASSET_REQUIRES_SETTLEMENT')
    }
    const dividends = source.dividends.filter(row =>
      row.div_proc === '实施' && row.ex_date >= calendar[0] && row.ex_date <= spec.end)
    const ids = new Set()
    for (const div of dividends) {
      if (![div.ann_date, div.record_date, div.ex_date, div.pay_date]
        .every(date => /^\d{8}$/.test(date || ''))
        || div.ann_date > div.record_date || div.record_date >= div.ex_date
        || div.ex_date > div.pay_date || !(Number.isFinite(div.div_cash) && div.div_cash > 0)
        || ids.has(div.ex_date)) throw new Error(`INVALID_DIVIDEND:${definition.code}`)
      ids.add(div.ex_date)
    }
    const adj = new Map(source.adj.map(row => [row.trade_date, row.adj_factor]))
    if (adj.size !== source.adj.length) throw new Error('DUPLICATE_FACTOR')
    const daily = [...source.daily].sort((a, b) => a.trade_date.localeCompare(b.trade_date))
    const byDate = new Map()
    const bars = daily.map((row, i) => {
      const date = row.trade_date
      if (!calendarSet.has(date) || byDate.has(date)) throw new Error('INVALID_BAR_DATE')
      if (!['open', 'high', 'low', 'close', 'pre_close']
        .every(key => Number.isFinite(row[key]) && row[key] > 0)
        || row.low > Math.min(row.open, row.close)
        || row.high < Math.max(row.open, row.close)
        || !Number.isFinite(row.vol) || row.vol < 0
        || !Number.isFinite(row.amount) || row.amount < 0
        || !(Number.isFinite(adj.get(date)) && adj.get(date) > 0)) {
        throw new Error(`INVALID_BAR:${definition.code}:${date}`)
      }
      const div = dividends.find(item => item.ex_date === date)
      const split = splits.find(item => item.priceDate === date)
      if (i && split && Math.abs(adj.get(date) / adj.get(daily[i - 1].trade_date) / split.ratio - 1) > 0.001) {
        throw new Error('SPLIT_FACTOR_MISMATCH')
      }
      if (i && Math.abs(adj.get(date) / adj.get(daily[i - 1].trade_date) - 1) > 0.0002 && !div && !split) {
        throw new Error(`UNEXPLAINED_ADJUSTMENT:${definition.code}:${date}`)
      }
      if (i && div && Math.abs(row.pre_close - (daily[i - 1].close - div.div_cash)) > 0.005) {
        throw new Error(`DIVIDEND_PRICE_MISMATCH:${definition.code}:${date}`)
      }
      const bar = { ...row, date, index: i, factor: adj.get(date), signalClose: row.close * adj.get(date) }
      byDate.set(date, bar)
      return bar
    })
    for (const date of calendar.filter(date => date >= source.basic.list_date)) {
      if (!byDate.has(date) && !allowedSuspensions.has(date)) {
        throw new Error(`MISSING_SESSION:${definition.code}:${date}`)
      }
    }
    return { ...definition, bars, byDate, dividends, splits, basic: source.basic }
  })
  return { calendar, assets }
}

export function featuresAt(asset, date, spec) {
  const bar = asset.byDate.get(date)
  if (!bar || bar.index + 1 < spec.warmupSessions) return null
  const rows = asset.bars.slice(0, bar.index + 1)
  const recent = rows.slice(-20)
  const averageAmount = mean(recent.map(item => item.amount * 1000))
  if (averageAmount < spec.minimumAverageAmount) return null
  const atr = mean(rows.slice(-14).map(item =>
    Math.max(item.high - item.low,
      Math.abs(item.high - item.pre_close), Math.abs(item.low - item.pre_close))
        * item.factor / bar.factor))
  const monthly = []
  for (const row of rows) {
    const month = row.date.slice(0, 6)
    if (monthly.at(-1)?.month === month) monthly[monthly.length - 1] = { month, value: row.signalClose }
    else monthly.push({ month, value: row.signalClose })
  }
  if (monthly.length < 10 || !(atr > 0)) return null
  return {
    price: bar.close, atr, averageAmount,
    averageShares: mean(recent.map(item => item.vol * 100)),
    monthlyPositive: bar.signalClose > mean(monthly.slice(-10).map(item => item.value)),
    momentum: (bar.signalClose / rows.at(-61).signalClose
      + bar.signalClose / rows.at(-121).signalClose - 2) / 2,
  }
}

export function loadHistory(directory, configFile) {
  const rawConfig = fs.readFileSync(configFile)
  const spec = JSON.parse(rawConfig)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')))
  if (!/^history-[a-f0-9]{64}\.json$/.test(manifest.file)) throw new Error('INVALID_MANIFEST')
  const raw = fs.readFileSync(path.join(directory, manifest.file))
  if (digest(rawConfig) !== manifest.configHash || digest(raw) !== manifest.sha256) {
    throw new Error('CHECKSUM_MISMATCH')
  }
  const history = JSON.parse(raw)
  if (history.configHash !== manifest.configHash) throw new Error('CONFIG_MISMATCH')
  const actionsRaw = fs.readFileSync(new URL('./corporate-actions.json', import.meta.url))
  return { spec, manifest, corporateActionsHash: digest(actionsRaw),
    ...prepareHistory(history, spec, JSON.parse(actionsRaw)) }
}
