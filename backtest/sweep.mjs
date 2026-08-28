#!/usr/bin/env node
// 参数扫描：对回踩低吸策略族做网格搜索，找是否存在扣费后样本外正期望的配置。
// 目的不是过拟合，而是回答"这套打法有没有 edge 的可行域"。
// 用法：node backtest/sweep.mjs --pool backtest/pool.json --start 20220101 --end 20260101

import process from 'node:process'
import { loadCachedDaily, barsForBacktest } from './data/dataStore.js'
import { readFile } from 'node:fs/promises'
import { generatePullbackDipSignals } from '../shared/backtest/strategies/pullbackDipBuy.js'
import { runSingleAssetBacktest } from '../shared/backtest/engine.js'
import { computeBacktestMetrics } from '../shared/backtest/metrics.js'
import { walkForwardFolds, tradeInWindow } from './walkForward.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--pool') args.pool = argv[++i]
    else if (argv[i] === '--start') args.start = argv[++i]
    else if (argv[i] === '--end') args.end = argv[++i]
  }
  return args
}

async function loadPool(poolPath) {
  const parsed = JSON.parse(await readFile(poolPath, 'utf8'))
  return (Array.isArray(parsed) ? parsed : parsed.codes || [])
    .map((c) => (typeof c === 'string' ? c : c.code))
}

// 扫描网格：动量门槛 × 锚点 × 止盈R × 最长持有 × 止损buffer
const GRID = {
  momentumMinPct: [8, 12, 18],
  anchor: ['ma5', 'ma10'],
  takeProfitR: [1.5, 2.0, 3.0],
  maxHoldDays: [3, 5, 10],
  stopBufferPct: [1.0, 2.0],
}

function* configs() {
  for (const momentumMinPct of GRID.momentumMinPct)
    for (const anchor of GRID.anchor)
      for (const takeProfitR of GRID.takeProfitR)
        for (const maxHoldDays of GRID.maxHoldDays)
          for (const stopBufferPct of GRID.stopBufferPct)
            yield { momentumMinPct, anchor, takeProfitR, maxHoldDays, stopBufferPct }
}

async function main() {
  const args = parseArgs(process.argv)
  const codes = await loadPool(args.pool)
  // 预载所有标的的后复权K线（走缓存，零网络）
  const stocks = []
  for (const code of codes) {
    const rec = await loadCachedDaily(code)
    if (rec?.bars?.length) {
      stocks.push({ code, bars: barsForBacktest(rec, { adjusted: true }) })
    }
  }
  console.log(`已载入 ${stocks.length} 只标的缓存，开始扫描 ${[...configs()].length} 组参数…\n`)

  const results = []
  for (const cfg of configs()) {
    const oosTrades = []
    let allTrades = 0
    for (const stock of stocks) {
      const signals = generatePullbackDipSignals(stock.bars, cfg)
      const result = runSingleAssetBacktest({
        security: { code: stock.code }, bars: stock.bars, signals,
      })
      allTrades += result.trades.length
      const dates = stock.bars.map((b) => b.date)
      const folds = walkForwardFolds(dates, { trainDays: 250, testDays: 60 })
      for (const t of result.trades) {
        if (folds.some((f) => tradeInWindow(t, f.testStart, f.testEnd))) oosTrades.push(t)
      }
    }
    const m = computeBacktestMetrics(oosTrades)
    results.push({
      cfg,
      oosTrades: m.trades || 0,
      expPct: m.expectancyPct ?? null,
      winRate: m.winRatePct ?? null,
      profitFactor: m.profitFactor ?? null,
      positive: m.expectancyPositive || false,
    })
  }

  // 按样本外收益率期望排序，样本量太小(<20)的置后。
  results.sort((a, b) => {
    const aok = a.oosTrades >= 20 ? 1 : 0
    const bok = b.oosTrades >= 20 ? 1 : 0
    if (aok !== bok) return bok - aok
    return (b.expPct ?? -999) - (a.expPct ?? -999)
  })

  console.log('Top 12（样本外，交易数≥20优先）：')
  console.log('期望% | 胜率% | 盈亏因子 | 样本外笔数 | 参数')
  for (const r of results.slice(0, 12)) {
    const c = r.cfg
    console.log(
      `${String(r.expPct).padStart(6)} | ${String(r.winRate).padStart(5)} | ${String(r.profitFactor).padStart(6)} | ${String(r.oosTrades).padStart(4)} | mom${c.momentumMinPct} ${c.anchor} R${c.takeProfitR} hold${c.maxHoldDays} stop${c.stopBufferPct}`,
    )
  }
  const anyPositive = results.some((r) => r.positive && r.oosTrades >= 20)
  console.log(`\n是否存在样本外正期望配置(样本≥20)：${anyPositive ? '✅ 有' : '⛔ 无'}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
