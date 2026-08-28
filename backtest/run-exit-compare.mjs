#!/usr/bin/env node
// 出场对比：固定止盈止损 vs 跟踪止损（多阈值），首板打法，样本外扣费后。
// 全程读缓存、零网络。回答"#1 换出场逻辑能否把负期望救回来"。
//
// 用法：node backtest/run-exit-compare.mjs

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { barsForBacktest } from './data/dataStore.js'
import {
  generateFirstBoardSignals,
  isHighQualityFirstBoard,
} from '../shared/backtest/strategies/firstBoardBreakout.js'
import { entriesOnly, applyTrailingExits } from '../shared/backtest/trailingExit.js'
import { runSingleAssetBacktest } from '../shared/backtest/engine.js'
import { computeBacktestMetrics } from '../shared/backtest/metrics.js'
import { walkForwardFolds, tradeInWindow } from './walkForward.js'

const CACHE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cache')

async function loadJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

async function main() {
  // 1. 从缓存的涨停板重建首板事件（按 code）
  const files = (await readdir(CACHE)).filter((f) => f.startsWith('limitlist_'))
  const boardsByCode = new Map()
  for (const f of files) {
    const rec = await loadJson(path.join(CACHE, f))
    const rows = rec?.rows || []
    for (const r of rows) {
      if (r.limitType === 'U' && r.limitTimes === 1 && isHighQualityFirstBoard(r)) {
        if (!boardsByCode.has(r.code)) boardsByCode.set(r.code, [])
        boardsByCode.get(r.code).push(r)
      }
    }
  }
  console.log(`高质量首板标的：${boardsByCode.size}`)

  // 2. 预载日线
  const barsByCode = new Map()
  for (const code of boardsByCode.keys()) {
    const safe = code.replace(/[^0-9A-Za-z.]/g, '_')
    const rec = await loadJson(path.join(CACHE, `daily_${safe}.json`))
    if (rec?.bars?.length) barsByCode.set(code, barsForBacktest(rec, { adjusted: true }))
  }
  console.log(`可回测标的（有日线）：${barsByCode.size}\n`)

  // 3. 各出场方案
  const exits = [
    { label: '固定(9%止盈/5%止损/2日)', kind: 'fixed' },
    { label: '跟踪6%(激活3%)', kind: 'trail', cfg: { mode: 'pct', trailPct: 6, activateProfitPct: 3, initialStopPct: 5, maxHoldDays: 20 } },
    { label: '跟踪8%(激活3%)', kind: 'trail', cfg: { mode: 'pct', trailPct: 8, activateProfitPct: 3, initialStopPct: 5, maxHoldDays: 20 } },
    { label: '跟踪10%(激活5%)', kind: 'trail', cfg: { mode: 'pct', trailPct: 10, activateProfitPct: 5, initialStopPct: 6, maxHoldDays: 30 } },
    { label: 'ATR2.5跟踪', kind: 'trail', cfg: { mode: 'atr', atrMult: 2.5, activateProfitPct: 3, initialStopPct: 5, maxHoldDays: 30 } },
  ]

  console.log('出场方案 | 样本外笔数 | 胜率% | 盈亏比 | 盈利因子 | 期望% | 结论')
  for (const ex of exits) {
    const oos = []
    for (const [code, boards] of boardsByCode) {
      const bars = barsByCode.get(code)
      if (!bars) continue
      let signals
      if (ex.kind === 'fixed') {
        signals = generateFirstBoardSignals(boards, bars)
      } else {
        const entries = entriesOnly(generateFirstBoardSignals(boards, bars))
        signals = applyTrailingExits(entries, bars, ex.cfg)
      }
      const result = runSingleAssetBacktest({ security: { code }, bars, signals })
      const folds = walkForwardFolds(bars.map((b) => b.date), { trainDays: 250, testDays: 60 })
      for (const t of result.trades) {
        if (folds.some((f) => tradeInWindow(t, f.testStart, f.testEnd))) oos.push(t)
      }
    }
    const m = computeBacktestMetrics(oos)
    console.log(`${ex.label} | ${m.trades || 0} | ${m.winRatePct ?? '—'} | ${m.payoffRatio ?? '—'} | ${m.profitFactor ?? '—'} | ${m.expectancyPct ?? '—'} | ${m.expectancyPositive ? '✅正' : '⛔负'}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
