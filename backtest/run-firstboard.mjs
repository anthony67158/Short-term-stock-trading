#!/usr/bin/env node
// 首板打板真实回测：拉取日期区间内每个交易日的涨停板，筛出高质量首板，
// 对每只首板股在其首板次日进场做回测，汇总扣费后样本外期望。
//
// 用法：node backtest/run-firstboard.mjs --start 20250101 --end 20260101 [--sample 30]
//   --sample N 仅取最近 N 个交易日（控制拉取量/请求数，先验证再全跑）

import process from 'node:process'
import { fetchTushare } from './data/tushareClient.js'
import { fetchLimitList } from './data/extendedData.js'
import { fetchDailyWithAdj, barsForBacktest } from './data/dataStore.js'
import {
  generateFirstBoardSignals,
  isHighQualityFirstBoard,
} from '../shared/backtest/strategies/firstBoardBreakout.js'
import { runSingleAssetBacktest } from '../shared/backtest/engine.js'
import { computeBacktestMetrics } from '../shared/backtest/metrics.js'

function parseArgs(argv) {
  const args = { start: '20250101', end: '20260101' }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--start') args.start = argv[++i]
    else if (argv[i] === '--end') args.end = argv[++i]
    else if (argv[i] === '--sample') args.sample = Number(argv[++i])
  }
  return args
}

// 交易日历（SSE 开市日）。
async function tradeDates(start, end) {
  const rows = await fetchTushare('trade_cal', {
    exchange: 'SSE', start_date: start, end_date: end, is_open: '1',
  }, 'cal_date,is_open')
  return rows
    .map((r) => String(r.cal_date || '').replaceAll('-', ''))
    .filter((d) => /^\d{8}$/.test(d))
    .sort()
}

async function main() {
  const args = parseArgs(process.argv)
  let dates = await tradeDates(args.start, args.end)
  if (Number.isFinite(args.sample) && args.sample > 0) {
    dates = dates.slice(-args.sample)
  }
  console.log(`交易日 ${dates.length} 天（${dates[0]}~${dates.at(-1)}），拉取涨停板并筛首板…`)

  // 1. 收集每个首板股的首板日
  const firstBoardByCode = new Map() // code -> [首板记录]
  for (const date of dates) {
    let rec
    try { rec = await fetchLimitList({ tradeDate: date }) }
    catch (e) { console.error(`  ${date} 涨停板拉取失败: ${e.message}`); continue }
    for (const row of rec.rows || []) {
      if (isHighQualityFirstBoard(row)) {
        if (!firstBoardByCode.has(row.code)) firstBoardByCode.set(row.code, [])
        firstBoardByCode.get(row.code).push(row)
      }
    }
  }
  console.log(`高质量首板涉及 ${firstBoardByCode.size} 只标的，拉取日线回测…`)

  // 2. 每只票拉日线（需覆盖首板日后若干天用于退出），回测
  const allTrades = []
  let done = 0
  for (const [code, boards] of firstBoardByCode) {
    let record
    try {
      record = await fetchDailyWithAdj({ code, startDate: args.start, endDate: args.end })
    } catch { continue }
    const bars = barsForBacktest(record, { adjusted: true })
    if (!bars.length) continue
    const signals = generateFirstBoardSignals(boards, bars)
    const result = runSingleAssetBacktest({ security: { code }, bars, signals })
    allTrades.push(...result.trades)
    done += 1
    if (done % 50 === 0) console.log(`  已回测 ${done} 只…`)
  }

  const m = computeBacktestMetrics(allTrades, { label: '首板打板' })
  console.log('\n# 首板打板 · 回测结果')
  console.log(`交易次数 ${m.trades} ｜ 胜率 ${m.winRatePct}% ｜ 盈亏比 ${m.payoffRatio} ｜ 盈利因子 ${m.profitFactor}`)
  console.log(`单笔扣费后期望：${m.expectancyPct}% / ${m.expectancyCash} 元 ｜ 最大回撤 ${m.maxDrawdownPct}%`)
  console.log(`平均持有 ${m.avgHoldingDays} 日`)
  console.log(`\n结论：${m.verdict}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
