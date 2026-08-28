#!/usr/bin/env node
// 日内首板真实回测：对高质量首板，取【首板次日(D+1)分钟线】做日内进出场，
// 用 D+2 开盘价兑现，样本外扣费后期望，与日线裸版对比。
//
// 数据重：每个首板事件需 1 次分钟线拉取(D+1)。用 --sample N 限制事件数先验证。
// 日线来自缓存（用于定位 D+1/D+2 交易日与 D+2 开盘价）。
//
// 用法：node backtest/run-intraday-firstboard.mjs --sample 200 [--freq 5min]

import process from 'node:process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { barsForBacktest, toTsCode } from './data/dataStore.js'
import { fetchMinsForDay } from './data/minuteData.js'
import { isHighQualityFirstBoard } from '../shared/backtest/strategies/firstBoardBreakout.js'
import { simulateIntradayFirstBoard } from '../shared/backtest/strategies/intradayFirstBoard.js'
import { computeBacktestMetrics } from '../shared/backtest/metrics.js'

const CACHE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cache')

function parseArgs(argv) {
  const a = { freq: '5min', sample: 200 }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--sample') a.sample = Number(argv[++i])
    else if (argv[i] === '--freq') a.freq = argv[++i]
  }
  return a
}

async function loadJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

async function main() {
  const args = parseArgs(process.argv)

  // 1. 从缓存涨停板收集高质量首板事件 (code, date)
  const files = (await readdir(CACHE)).filter((f) => f.startsWith('limitlist_'))
  const events = []
  for (const f of files) {
    const rec = await loadJson(path.join(CACHE, f))
    for (const r of rec?.rows || []) {
      if (r.limitType === 'U' && r.limitTimes === 1 && isHighQualityFirstBoard(r)) {
        events.push({ code: r.code, boardDate: r.date })
      }
    }
  }
  events.sort((a, b) => (a.boardDate < b.boardDate ? -1 : 1))
  console.log(`高质量首板事件：${events.length}`)

  // 2. 预载各 code 的日线（缓存）用于定位 D+1/D+2
  const barsCache = new Map()
  async function bars(code) {
    if (barsCache.has(code)) return barsCache.get(code)
    const safe = (toTsCode(code) || code).replace(/[^0-9A-Za-z.]/g, '_')
    const rec = await loadJson(path.join(CACHE, `daily_${safe}.json`))
    const b = rec?.bars?.length ? barsForBacktest(rec, { adjusted: false }) : null // 分钟为不复权，日线也用不复权对齐兑现价
    barsCache.set(code, b)
    return b
  }

  // 3. 取样本，逐事件跑日内模拟
  let sampled = events
  if (Number.isFinite(args.sample) && args.sample > 0) {
    // 均匀抽样，避免只取某段时间
    const step = Math.max(1, Math.floor(events.length / args.sample))
    sampled = events.filter((_, i) => i % step === 0).slice(0, args.sample)
  }
  console.log(`抽样事件：${sampled.length}，拉分钟线(${args.freq})…\n`)

  const intradayTrades = []
  const baselineTrades = [] // 对照：裸开盘买D+1、D+2开盘卖
  let entered = 0
  let skipped = 0
  let done = 0
  for (const ev of sampled) {
    const b = await bars(ev.code)
    if (!b) continue
    const di = b.findIndex((x) => x.date === ev.boardDate)
    if (di < 0 || di + 2 >= b.length) continue
    const d1 = b[di + 1] // 进场日
    const d2 = b[di + 2] // 兑现日
    const prevClose = b[di].close

    // 分钟线（D+1）
    let mrec
    try { mrec = await fetchMinsForDay({ code: ev.code, date: d1.date, freq: args.freq }) }
    catch { continue }

    const sim = simulateIntradayFirstBoard({
      entryMins: mrec.rows,
      nextOpenPrice: d2.open,
      prevClose,
    })
    if (sim.entered) { intradayTrades.push(sim.trade); entered += 1 }
    else skipped += 1

    // 对照基线：D+1 开盘买、D+2 开盘卖（裸日线，无日内闸门）
    if (d1.open > 0 && d2.open > 0) {
      const ret = (d2.open - d1.open) / d1.open * 100 - 0.15 // 粗略扣费0.15%
      baselineTrades.push({ netPnl: (d2.open - d1.open) * 100, returnPct: +ret.toFixed(3), holdingDays: 1 })
    }

    done += 1
    if (done % 50 === 0) console.log(`  已处理 ${done}/${sampled.length}（进场${entered} 跳过${skipped}）…`)
  }

  const mIntra = computeBacktestMetrics(intradayTrades, { label: '日内首板' })
  const mBase = computeBacktestMetrics(baselineTrades, { label: '裸日线基线' })

  console.log('\n# 日内首板 vs 裸日线基线（扣费后）')
  console.log('方案 | 笔数 | 胜率% | 盈亏比 | 盈利因子 | 期望% | 结论')
  console.log(`日内择时进场 | ${mIntra.trades} | ${mIntra.winRatePct} | ${mIntra.payoffRatio} | ${mIntra.profitFactor} | ${mIntra.expectancyPct} | ${mIntra.expectancyPositive ? '✅正' : '⛔负'}`)
  console.log(`裸日线基线 | ${mBase.trades} | ${mBase.winRatePct} | ${mBase.payoffRatio} | ${mBase.profitFactor} | ${mBase.expectancyPct} | ${mBase.expectancyPositive ? '✅正' : '⛔负'}`)
  console.log(`\n进场率：${entered}/${entered + skipped}（日内闸门过滤掉 ${skipped} 个弱势次日）`)
  console.log('注：样本为抽样，且未做walk-forward切分，属可行性快检；正向再全量+样本外确认。')
}

main().catch((e) => { console.error(e); process.exit(1) })
