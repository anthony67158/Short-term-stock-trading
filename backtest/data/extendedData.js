// 扩展数据集归一化与拉取：资金流 / 龙虎榜+席位 / 涨停板 / 每日指标。
//
// 与 dataStore 同源：网络层薄封装(fetchTushare)、解析为纯函数可离线测试、
// 落地 backtest/cache/ 复用。这些是回踩低吸"资金承接确认"与首板/龙虎榜
// 策略的因子来源。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchTushare, resolveTushareToken } from './tushareClient.js'
import { toTsCode } from './dataStore.js'

const CACHE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'cache',
)

function numeric(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normDate(value) {
  const compact = String(value ?? '').replaceAll('-', '')
  return /^\d{8}$/.test(compact) ? compact : null
}

// —— 资金流（moneyflow）——
// 主力净流入 = 大单(lg) + 特大单(elg) 净额，单位：万元（Tushare amount 单位万元）。
// 散户代理 = 小单(sm) 净额。同现有系统 stockFund 口径的历史版。
export function normalizeMoneyflow(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const lgNet = (numeric(row.buy_lg_amount) ?? 0) - (numeric(row.sell_lg_amount) ?? 0)
      const elgNet = (numeric(row.buy_elg_amount) ?? 0) - (numeric(row.sell_elg_amount) ?? 0)
      const smNet = (numeric(row.buy_sm_amount) ?? 0) - (numeric(row.sell_sm_amount) ?? 0)
      return {
        date: normDate(row.trade_date),
        mainNetWan: +(lgNet + elgNet).toFixed(2), // 主力净流入(万元)
        retailNetWan: +smNet.toFixed(2), // 小单净流入(万元)
        netMfWan: numeric(row.net_mf_amount), // 全单净额(万元)
      }
    })
    .filter((row) => row.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

// —— 涨停板（limit_list_d）——
// limit: U涨停 / D跌停 / Z炸板。首板判定用 limit_times(连板次数)=1。
export function normalizeLimitList(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      date: normDate(row.trade_date),
      code: String(row.ts_code || ''),
      name: String(row.name || ''),
      industry: String(row.industry || ''),
      close: numeric(row.close),
      pctChg: numeric(row.pct_chg),
      amount: numeric(row.amount),
      limitAmount: numeric(row.limit_amount), // 板上封单成交额
      fdAmount: numeric(row.fd_amount), // 封单金额
      floatMv: numeric(row.float_mv), // 流通市值
      turnoverRatio: numeric(row.turnover_ratio),
      firstTime: String(row.first_time || ''), // 首次封板时间
      lastTime: String(row.last_time || ''), // 最后封板时间
      openTimes: numeric(row.open_times), // 当日开板次数
      limitTimes: numeric(row.limit_times), // 连续涨停次数（首板=1）
      upStat: String(row.up_stat || ''), // 形如 "1/2"
      limitType: String(row.limit || 'U'),
    }))
    .filter((row) => row.date && row.code)
}

// —— 龙虎榜机构/游资席位（top_inst）——
export function normalizeTopInst(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      date: normDate(row.trade_date),
      code: String(row.ts_code || ''),
      seat: String(row.exalter || ''), // 营业部/席位名
      buy: numeric(row.buy),
      sell: numeric(row.sell),
      netBuy: numeric(row.net_buy),
    }))
    .filter((row) => row.date && row.code)
}

// —— 每日指标（daily_basic）：换手率、量比、流通市值 ——
export function normalizeDailyBasic(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      date: normDate(row.trade_date),
      turnoverRate: numeric(row.turnover_rate),
      turnoverRateF: numeric(row.turnover_rate_f), // 自由流通换手
      volumeRatio: numeric(row.volume_ratio),
      circMv: numeric(row.circ_mv), // 流通市值(万元)
    }))
    .filter((row) => row.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

async function readCache(name) {
  try {
    const raw = await readFile(path.join(CACHE_ROOT, name), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function writeCache(name, record) {
  await mkdir(CACHE_ROOT, { recursive: true })
  await writeFile(path.join(CACHE_ROOT, name), `${JSON.stringify(record)}\n`)
}

// 单标的资金流（含缓存）。
export async function fetchMoneyflow({
  code, startDate, endDate,
  token = resolveTushareToken(), useCache = true,
} = {}) {
  const tsCode = toTsCode(code)
  if (!tsCode) throw new Error(`非法股票代码: ${code}`)
  const safe = tsCode.replace(/[^0-9A-Za-z.]/g, '_')
  const cacheName = `moneyflow_${safe}.json`
  if (useCache) {
    const cached = await readCache(cacheName)
    if (cached?.rows?.length) return cached
  }
  const raw = await fetchTushare('moneyflow', {
    ts_code: tsCode, start_date: startDate, end_date: endDate,
  }, '', { token })
  const record = { code: String(code), tsCode, rows: normalizeMoneyflow(raw), fetchedAt: new Date().toISOString() }
  await writeCache(cacheName, record)
  return record
}

// 单标的每日指标（含缓存）。
export async function fetchDailyBasic({
  code, startDate, endDate,
  token = resolveTushareToken(), useCache = true,
} = {}) {
  const tsCode = toTsCode(code)
  if (!tsCode) throw new Error(`非法股票代码: ${code}`)
  const safe = tsCode.replace(/[^0-9A-Za-z.]/g, '_')
  const cacheName = `dailybasic_${safe}.json`
  if (useCache) {
    const cached = await readCache(cacheName)
    if (cached?.rows?.length) return cached
  }
  const raw = await fetchTushare('daily_basic', {
    ts_code: tsCode, start_date: startDate, end_date: endDate,
  }, '', { token })
  const record = { code: String(code), tsCode, rows: normalizeDailyBasic(raw), fetchedAt: new Date().toISOString() }
  await writeCache(cacheName, record)
  return record
}

// 全市场某日涨停板（含缓存，按交易日）。
export async function fetchLimitList({
  tradeDate, token = resolveTushareToken(), useCache = true,
} = {}) {
  const date = normDate(tradeDate)
  if (!date) throw new Error(`非法交易日: ${tradeDate}`)
  const cacheName = `limitlist_${date}.json`
  if (useCache) {
    const cached = await readCache(cacheName)
    if (cached?.rows) return cached
  }
  const raw = await fetchTushare('limit_list_d', { trade_date: date }, '', { token })
  const record = { date, rows: normalizeLimitList(raw), fetchedAt: new Date().toISOString() }
  await writeCache(cacheName, record)
  return record
}

// 全市场某日龙虎榜席位（含缓存，按交易日）。
export async function fetchTopInst({
  tradeDate, token = resolveTushareToken(), useCache = true,
} = {}) {
  const date = normDate(tradeDate)
  if (!date) throw new Error(`非法交易日: ${tradeDate}`)
  const cacheName = `topinst_${date}.json`
  if (useCache) {
    const cached = await readCache(cacheName)
    if (cached?.rows) return cached
  }
  const raw = await fetchTushare('top_inst', { trade_date: date }, '', { token })
  const record = { date, rows: normalizeTopInst(raw), fetchedAt: new Date().toISOString() }
  await writeCache(cacheName, record)
  return record
}
