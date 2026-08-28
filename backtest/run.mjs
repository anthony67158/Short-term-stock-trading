#!/usr/bin/env node
// 回测 CLI —— 一条命令量出"回踩低吸"扣费后到底赚不赚钱。
//
// 用法：
//   node backtest/run.mjs --codes 600000,000001,300750 \
//     --start 20210101 --end 20260101 [--no-cache] [--adjusted]
//   node backtest/run.mjs --pool backtest/pool.json --start ... --end ...
//
// 输出：终端打印总体 + 样本外(walk-forward)期望看板；同时写
//   backtest/reports/pullback_<时间戳>.md（已 gitignore）。
//
// 门槛：只有【样本外单笔扣费后期望 > 0】才认定具备真实优势，可进入实盘接入。

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import {
  fetchDailyWithAdj,
  barsForBacktest,
  loadCachedDaily,
} from './data/dataStore.js'
import { fetchMoneyflow } from './data/extendedData.js'
import { generatePullbackDipSignals, latestBuyPlan } from '../shared/backtest/strategies/pullbackDipBuy.js'
import { runSingleAssetBacktest } from '../shared/backtest/engine.js'
import { computeBacktestMetrics } from '../shared/backtest/metrics.js'
import { walkForwardFolds, tradeInWindow } from './walkForward.js'

const REPORT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'reports',
)

function parseArgs(argv) {
  const args = { start: '20210101', end: '20260101', cache: true, adjusted: true }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--codes') args.codes = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--pool') args.pool = argv[++i]
    else if (arg === '--start') args.start = argv[++i]
    else if (arg === '--end') args.end = argv[++i]
    else if (arg === '--no-cache') args.cache = false
    else if (arg === '--raw') args.adjusted = false
    else if (arg === '--train-days') args.trainDays = Number(argv[++i])
    else if (arg === '--test-days') args.testDays = Number(argv[++i])
    else if (arg === '--plan') args.planMode = true
    else if (arg === '--flow') args.flow = true
    else if (arg === '--flow-min') args.flowMinNetWan = Number(argv[++i])
    else if (arg === '--flow-window') args.flowConfirmWindow = Number(argv[++i])
  }
  return args
}

async function resolveCodes(args) {
  if (args.codes?.length) return args.codes.map((code) => ({ code }))
  if (args.pool) {
    const raw = await readFile(path.resolve(args.pool), 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : parsed.codes || []
    return list.map((item) =>
      typeof item === 'string' ? { code: item } : item)
  }
  return []
}

async function backtestOne(entry, args) {
  const code = entry.code
  let record
  try {
    record = args.cache
      ? (await loadCachedDaily(code)) || await fetchDailyWithAdj({ ...entry, startDate: args.start, endDate: args.end })
      : await fetchDailyWithAdj({ ...entry, startDate: args.start, endDate: args.end, useCache: false })
  } catch (error) {
    return { code, error: String(error.message || error) }
  }
  const bars = barsForBacktest(record, { adjusted: args.adjusted })
  if (!bars.length) return { code, error: '无可用K线' }

  // 资金承接确认：可选拉取 moneyflow，构造按日期索引的主力净流入映射。
  let moneyflowByDate = null
  let strategyConfig = {}
  if (args.flow) {
    try {
      const flowRecord = args.cache !== false
        ? await fetchMoneyflow({ code, startDate: args.start, endDate: args.end })
        : await fetchMoneyflow({ code, startDate: args.start, endDate: args.end, useCache: false })
      moneyflowByDate = Object.fromEntries(
        (flowRecord.rows || []).map((row) => [row.date, row]),
      )
      strategyConfig = {
        requireFlowConfirm: true,
        flowConfirmWindow: Number.isFinite(args.flowConfirmWindow) ? args.flowConfirmWindow : 3,
        flowMinNetWan: Number.isFinite(args.flowMinNetWan) ? args.flowMinNetWan : 0,
      }
    } catch (error) {
      return { code, error: `资金流拉取失败: ${error.message || error}` }
    }
  }

  const signals = generatePullbackDipSignals(bars, strategyConfig, { moneyflowByDate })
  const result = runSingleAssetBacktest({
    security: { code, name: record.name || '' },
    bars,
    signals,
  })
  return {
    code,
    name: record.name || '',
    bars,
    trades: result.trades,
    rejections: result.rejections,
  }
}

function fmt(value) {
  return value == null ? '—' : String(value)
}

function renderReport(overall, oos, perStock, args) {
  const lines = []
  lines.push(`# 回踩低吸策略 · 回测期望看板`)
  lines.push('')
  lines.push(`- 区间：${args.start} → ${args.end}`)
  lines.push(`- 标的数：${perStock.length}`)
  lines.push(`- 价格口径：${args.adjusted ? '后复权' : '原始价'}`)
  lines.push('')
  lines.push(`## 总体（全样本，含样本内，仅供参考）`)
  lines.push('')
  lines.push(`| 指标 | 值 |`)
  lines.push(`| --- | --- |`)
  lines.push(`| 交易次数 | ${fmt(overall.trades)} |`)
  lines.push(`| 胜率 | ${fmt(overall.winRatePct)}% |`)
  lines.push(`| 盈亏比 | ${fmt(overall.payoffRatio)} |`)
  lines.push(`| 盈利因子 | ${fmt(overall.profitFactor)} |`)
  lines.push(`| **单笔扣费后期望** | **${fmt(overall.expectancyCash)} 元 / ${fmt(overall.expectancyPct)}%** |`)
  lines.push(`| 最大回撤 | ${fmt(overall.maxDrawdownPct)}% |`)
  lines.push(`| 平均持有 | ${fmt(overall.avgHoldingDays)} 日 |`)
  lines.push('')
  lines.push(`## 样本外（walk-forward，真优势判据）`)
  lines.push('')
  lines.push(`| 指标 | 值 |`)
  lines.push(`| --- | --- |`)
  lines.push(`| 样本外交易次数 | ${fmt(oos.trades)} |`)
  lines.push(`| 样本外胜率 | ${fmt(oos.winRatePct)}% |`)
  lines.push(`| **样本外单笔扣费后期望** | **${fmt(oos.expectancyCash)} 元 / ${fmt(oos.expectancyPct)}%** |`)
  lines.push(`| 样本外盈利因子 | ${fmt(oos.profitFactor)} |`)
  lines.push('')
  lines.push(`### 结论`)
  lines.push('')
  lines.push(oos.expectancyPositive
    ? `✅ 样本外扣费后收益率期望为正（${fmt(oos.expectancyPct)}%/笔，现金 ${fmt(oos.expectancyCash)} 元），具备真实统计优势，可进入实盘接入评估。`
    : `⛔ 样本外扣费后收益率期望非正（${fmt(oos.expectancyPct)}%/笔），**不具备优势，禁止接入实盘**；需迭代策略规则或数据质量后重测。`)
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = parseArgs(process.argv)
  const entries = await resolveCodes(args)
  if (!entries.length) {
    console.error('请用 --codes 600000,000001 或 --pool file.json 指定标的')
    process.exit(2)
  }

  const perStock = []
  const allTrades = []
  const errors = []
  for (const entry of entries) {
    const out = await backtestOne(entry, args)
    if (out.error) { errors.push(out); continue }
    perStock.push(out)
    allTrades.push(...out.trades)
  }

  if (!perStock.length) {
    console.error('无可回测标的。错误：')
    for (const e of errors) console.error(`  ${e.code}: ${e.error}`)
    process.exit(1)
  }

  // —— 计划模式：直接回答"现在能不能买、买什么价" ——
  if (args.planMode) {
    console.log('# 回踩低吸 · 当前可执行买入计划\n')
    console.log(`（数据截至各标的最新交易日，价格口径：${args.adjusted ? '后复权' : '原始价'}）\n`)
    for (const stock of perStock) {
      const result = latestBuyPlan(stock.bars)
      const head = `【${stock.code}${stock.name ? ' ' + stock.name : ''}】`
      if (!result.actionable) {
        console.log(`${head} ⏸ 暂不买入：${result.reason}`)
        continue
      }
      const p = result.plan
      console.log(`${head} ✅ 可买（信号日 ${result.signalDate}）`)
      console.log(`   何时买：${p.entryWindow}，回踩到位、承接确认`)
      console.log(`   买入价：≈${p.entryTriggerPrice} 元（回踩${p.anchor.toUpperCase()}=${p.anchorPrice} 附近企稳）`)
      console.log(`   止损价：${p.stopPrice} 元 ｜ 止盈价：${p.targetPrice} 元 ｜ 盈亏比：${p.riskReward}:1`)
      console.log(`   最长持有：${p.maxHoldDays} 个交易日（未到止盈则次日退出）\n`)
    }
    if (errors.length) console.log(`（${errors.length} 只标的拉取失败，已跳过）`)
    return
  }

  // 样本外：对每只票按其交易日切 walk-forward 窗，只计入样本外窗内的交易。
  const oosTrades = []
  for (const stock of perStock) {
    const dates = stock.bars.map((bar) => bar.date)
    const folds = walkForwardFolds(dates, {
      trainDays: Number.isFinite(args.trainDays) ? args.trainDays : 250,
      testDays: Number.isFinite(args.testDays) ? args.testDays : 60,
    })
    for (const trade of stock.trades) {
      if (folds.some((f) => tradeInWindow(trade, f.testStart, f.testEnd))) {
        oosTrades.push(trade)
      }
    }
  }

  const overall = computeBacktestMetrics(allTrades, { label: '全样本' })
  const oos = computeBacktestMetrics(oosTrades, { label: '样本外' })

  const report = renderReport(overall, oos, perStock, args)
  await mkdir(REPORT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = path.join(REPORT_DIR, `pullback_${stamp}.md`)
  await writeFile(reportPath, report)

  console.log(report)
  if (errors.length) {
    console.log(`（${errors.length} 只标的拉取/回测失败，已跳过）`)
  }
  console.log(`报告已写入 ${reportPath}`)
}

main().catch((error) => {
  console.error('回测失败：', error.message || error)
  process.exit(1)
})
