// 历史数据仓库 —— 拉取一次、落地本地缓存，回测离线复用。
//
// 缓存目录 backtest/cache/（已 gitignore）。每个标的一个 JSON：
//   { code, name, fetchedAt, bars:[{date,open,high,low,close,preClose,volume,
//     hfq*...}] }
// 回测默认读后复权价(hfq*)跑信号，原始价用于展示。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fetchTushare,
  mergeAdjFactor,
  resolveTushareToken,
} from './tushareClient.js'

const CACHE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'cache',
)

function cachePath(code) {
  const safe = String(code || '').replace(/[^0-9A-Za-z.]/g, '_')
  return path.join(CACHE_ROOT, `daily_${safe}.json`)
}

// Tushare ts_code 形如 600000.SH / 000001.SZ / 300750.SZ / 688981.SH。
export function toTsCode(code) {
  const raw = String(code || '').trim().toUpperCase()
  if (/\.(SH|SZ|BJ)$/.test(raw)) return raw
  const digits = raw.replace(/\D/g, '')
  if (digits.length !== 6) return null
  if (/^(60|68|9)/.test(digits)) return `${digits}.SH`
  if (/^(0|3|2)/.test(digits)) return `${digits}.SZ`
  if (/^(4|8)/.test(digits)) return `${digits}.BJ`
  return `${digits}.SH`
}

export async function loadCachedDaily(code) {
  try {
    const raw = await readFile(cachePath(code), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.bars) ? parsed : null
  } catch {
    return null
  }
}

// 拉取单标的日线 + 复权因子，合成后复权价，落缓存。
export async function fetchDailyWithAdj({
  code,
  name = '',
  startDate,
  endDate,
  token = resolveTushareToken(),
  useCache = true,
} = {}) {
  const tsCode = toTsCode(code)
  if (!tsCode) throw new Error(`非法股票代码: ${code}`)
  if (useCache) {
    const cached = await loadCachedDaily(code)
    if (cached?.bars?.length) return cached
  }
  const [daily, adj] = await Promise.all([
    fetchTushare('daily', {
      ts_code: tsCode,
      start_date: startDate,
      end_date: endDate,
    }, 'trade_date,open,high,low,close,pre_close,vol,amount', { token }),
    fetchTushare('adj_factor', {
      ts_code: tsCode,
      start_date: startDate,
      end_date: endDate,
    }, 'trade_date,adj_factor', { token }),
  ])
  const bars = mergeAdjFactor(daily, adj)
  const record = {
    code: String(code),
    tsCode,
    name,
    startDate,
    endDate,
    fetchedAt: new Date().toISOString(),
    bars,
  }
  await mkdir(CACHE_ROOT, { recursive: true })
  await writeFile(cachePath(code), `${JSON.stringify(record)}\n`)
  return record
}

// 把缓存记录转成回测引擎输入：默认用后复权价，回退原始价。
export function barsForBacktest(record, { adjusted = true } = {}) {
  const bars = Array.isArray(record?.bars) ? record.bars : []
  if (!adjusted) return bars
  return bars.map((bar) => ({
    date: bar.date,
    open: bar.hfqOpen ?? bar.open,
    high: bar.hfqHigh ?? bar.high,
    low: bar.hfqLow ?? bar.low,
    close: bar.hfqClose ?? bar.close,
    preClose: bar.hfqPreClose ?? bar.preClose,
    volume: bar.volume,
  }))
}
