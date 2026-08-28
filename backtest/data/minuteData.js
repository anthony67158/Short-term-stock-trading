// 分钟线数据管线（stk_mins）。
//
// 代理接口 stk_mins：freq ∈ 1min/5min/15min，start_date/end_date 用
// "YYYY-MM-DD HH:MM:SS"，返回 { trade_time, open, close, high, low, vol, amount }，
// 且为【降序】——归一化时转升序。分钟数据量大，按 (code, date) 单日缓存。
//
// 传输复用 fetchTushare；归一化为纯函数可离线测试。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchTushare, resolveTushareToken } from './tushareClient.js'
import { toTsCode } from './dataStore.js'

const CACHE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'cache',
  'mins',
)

function numeric(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// 'YYYY-MM-DD HH:MM:SS' → { date:'YYYYMMDD', time:'HHMM' }
function splitTradeTime(value) {
  const s = String(value || '').trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
  if (!m) return { date: null, time: null }
  return { date: `${m[1]}${m[2]}${m[3]}`, time: `${m[4]}${m[5]}` }
}

// 归一化分钟行：升序、结构化 { date, time, open, high, low, close, vol, amount }。
export function normalizeMins(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const { date, time } = splitTradeTime(row.trade_time)
      return {
        date,
        time, // 'HHMM'
        tradeTime: String(row.trade_time || ''),
        open: numeric(row.open),
        high: numeric(row.high),
        low: numeric(row.low),
        close: numeric(row.close),
        vol: numeric(row.vol),
        amount: numeric(row.amount),
      }
    })
    .filter((r) => r.date && r.time && r.close != null)
    // 升序：先日期后时间
    .sort((a, b) => (a.date === b.date
      ? (a.time < b.time ? -1 : 1)
      : (a.date < b.date ? -1 : 1)))
}

function cachePath(code, date, freq) {
  const safe = String(code).replace(/[^0-9A-Za-z.]/g, '_')
  return path.join(CACHE_ROOT, `${safe}_${date}_${freq}.json`)
}

async function readCache(p) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

// 拉单标的单交易日的分钟线（含缓存）。date: 'YYYYMMDD'。
export async function fetchMinsForDay({
  code, date, freq = '5min',
  token = resolveTushareToken(), useCache = true,
} = {}) {
  const tsCode = toTsCode(code)
  if (!tsCode) throw new Error(`非法股票代码: ${code}`)
  const d = String(date).replaceAll('-', '')
  if (!/^\d{8}$/.test(d)) throw new Error(`非法日期: ${date}`)
  const p = cachePath(tsCode, d, freq)
  if (useCache) {
    const cached = await readCache(p)
    if (cached?.rows) return cached
  }
  const fmt = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  const raw = await fetchTushare('stk_mins', {
    ts_code: tsCode, freq,
    start_date: `${fmt} 09:00:00`,
    end_date: `${fmt} 15:00:00`,
  }, '', { token })
  const record = {
    code: String(code), tsCode, date: d, freq,
    rows: normalizeMins(raw),
    fetchedAt: new Date().toISOString(),
  }
  await mkdir(CACHE_ROOT, { recursive: true })
  await writeFile(p, `${JSON.stringify(record)}\n`)
  return record
}
