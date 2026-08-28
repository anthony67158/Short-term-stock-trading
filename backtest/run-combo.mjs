#!/usr/bin/env node
// 组合过滤动量策略 · 真实回测 + 消融分析。
//
// 拉全市场涨停(limit_list_d)构建：首板事件、市场情绪序列、板块涨停家数；
// 拉龙虎榜(top_inst)构建：每股每日热钱净买入。然后对组合策略做消融——
// 从"纯首板"逐步叠加 情绪→席位→板块 闸门，看样本外扣费后期望如何变化。
//
// 用法：node backtest/run-combo.mjs --start 20240101 --end 20260101 [--sample N]
//
// 诚实原则：样本外(walk-forward)为准；样本量太小的结果标注不可信；
// 消融是为了看"哪个条件真正贡献 edge"，不是为了凑一个好看的数。

import process from 'node:process'
import { fetchTushare } from './data/tushareClient.js'
import { fetchLimitList, fetchTopInst } from './data/extendedData.js'
import { fetchDailyWithAdj, barsForBacktest } from './data/dataStore.js'
import { hotSeatNetBuyWan } from '../shared/backtest/strategies/lhbInstFollow.js'
import { buildEmotionSeries } from '../shared/backtest/marketEmotion.js'
import { generateComboSignals } from '../shared/backtest/strategies/comboMomentum.js'
import { runSingleAssetBacktest } from '../shared/backtest/engine.js'
import { computeBacktestMetrics } from '../shared/backtest/metrics.js'
import { walkForwardFolds, tradeInWindow } from './walkForward.js'

function parseArgs(argv) {
  const args = { start: '20240101', end: '20260101' }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--start') args.start = argv[++i]
    else if (argv[i] === '--end') args.end = argv[++i]
    else if (argv[i] === '--sample') args.sample = Number(argv[++i])
  }
  return args
}

async function tradeDates(start, end) {
  const rows = await fetchTushare('trade_cal', {
    exchange: 'SSE', start_date: start, end_date: end, is_open: '1',
  }, 'cal_date,is_open')
  return rows.map((r) => String(r.cal_date || '').replaceAll('-', ''))
    .filter((d) => /^\d{8}$/.test(d)).sort()
}

async function main() {
  const args = parseArgs(process.argv)
  let dates = await tradeDates(args.start, args.end)
  if (Number.isFinite(args.sample) && args.sample > 0) dates = dates.slice(-args.sample)
  console.log(`交易日 ${dates.length} 天（${dates[0]}~${dates.at(-1)}）`)

  // 1. 拉每日涨停板 → 情绪序列 + 首板事件 + 板块涨停家数
  const limitByDate = {}
  const boardsByCode = new Map()
  const sectorLimitCountByDate = {}
  for (const date of dates) {
    let rec
    try { rec = await fetchLimitList({ tradeDate: date }) } catch { continue }
    limitByDate[date] = rec.rows
    // 板块涨停家数
    const sectorCount = {}
    for (const r of rec.rows) {
      if (r.limitType === 'U') sectorCount[r.industry] = (sectorCount[r.industry] || 0) + 1
    }
    sectorLimitCountByDate[date] = sectorCount
    // 首板事件（此处先收全部首板，质量闸门在策略里按开关判定）
    for (const r of rec.rows) {
      if (r.limitType === 'U' && r.limitTimes === 1) {
        if (!boardsByCode.has(r.code)) boardsByCode.set(r.code, [])
        boardsByCode.get(r.code).push(r)
      }
    }
  }
  const emotionByDate = buildEmotionSeries(limitByDate)
  console.log(`情绪序列 ${Object.keys(emotionByDate).length} 天；首板涉及 ${boardsByCode.size} 只标的`)

  // 2. 拉龙虎榜 → 每股每日热钱净买入(万元)
  const hotSeatNetByCodeDate = {}
  for (const date of dates) {
    let rec
    try { rec = await fetchTopInst({ tradeDate: date }) } catch { continue }
    // 按 code 分组
    const byCode = {}
    for (const row of rec.rows) {
      if (!byCode[row.code]) byCode[row.code] = []
      byCode[row.code].push(row)
    }
    for (const [code, recs] of Object.entries(byCode)) {
      const { netWan } = hotSeatNetBuyWan(recs)
      hotSeatNetByCodeDate[`${code}|${date}`] = netWan
    }
  }
  console.log(`龙虎榜热钱记录 ${Object.keys(hotSeatNetByCodeDate).length} 条`)

  const ctx = { emotionByDate, hotSeatNetByCodeDate, sectorLimitCountByDate }

  // 3. 预载所有首板标的日线（缓存复用）
  const barsByCode = new Map()
  let loaded = 0
  for (const code of boardsByCode.keys()) {
    try {
      const record = await fetchDailyWithAdj({ code, startDate: args.start, endDate: args.end })
      const bars = barsForBacktest(record, { adjusted: true })
      if (bars.length) barsByCode.set(code, bars)
    } catch { /* skip */ }
    loaded += 1
    if (loaded % 100 === 0) console.log(`  已载入日线 ${loaded}/${boardsByCode.size}…`)
  }

  // 4. 消融：逐步叠加闸门
  const ablations = [
    { label: '纯首板(全关)', cfg: { useEmotionGate: false, useBoardQuality: false, useSeatQuality: false, useSectorResonance: false } },
    { label: '+首板质量', cfg: { useEmotionGate: false, useBoardQuality: true, useSeatQuality: false, useSectorResonance: false } },
    { label: '+情绪闸门', cfg: { useEmotionGate: true, useBoardQuality: true, useSeatQuality: false, useSectorResonance: false } },
    { label: '+板块共振', cfg: { useEmotionGate: true, useBoardQuality: true, useSeatQuality: false, useSectorResonance: true } },
    { label: '+席位质量(全开)', cfg: { useEmotionGate: true, useBoardQuality: true, useSeatQuality: true, useSectorResonance: true } },
  ]

  console.log('\n# 组合过滤动量 · 消融分析（样本外 walk-forward，扣费后）')
  console.log('配置 | 样本外笔数 | 胜率% | 盈亏比 | 盈利因子 | 期望% | 结论')
  for (const ab of ablations) {
    const oosTrades = []
    let allCount = 0
    for (const [code, boards] of boardsByCode) {
      const bars = barsByCode.get(code)
      if (!bars) continue
      const signals = generateComboSignals(boards, bars, ctx, ab.cfg)
      const result = runSingleAssetBacktest({ security: { code }, bars, signals })
      allCount += result.trades.length
      const folds = walkForwardFolds(bars.map((b) => b.date), { trainDays: 250, testDays: 60 })
      for (const t of result.trades) {
        if (folds.some((f) => tradeInWindow(t, f.testStart, f.testEnd))) oosTrades.push(t)
      }
    }
    const m = computeBacktestMetrics(oosTrades)
    const trust = (m.trades || 0) >= 30 ? '' : ' ⚠样本少'
    console.log(
      `${ab.label} | ${m.trades || 0} | ${m.winRatePct ?? '—'} | ${m.payoffRatio ?? '—'} | ${m.profitFactor ?? '—'} | ${m.expectancyPct ?? '—'} | ${m.expectancyPositive ? '✅正期望' : '⛔负'}${trust}`,
    )
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
