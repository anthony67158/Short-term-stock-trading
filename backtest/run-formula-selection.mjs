#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluateFormulaSelection,
} from '../shared/formulaSelection.js'
import {
  buildFormulaPriceDecision,
} from '../shared/formulaPriceEngine.js'
import {
  executionPrice,
  tradeFees,
} from '../shared/ashareStrategyExecution.js'
import {
  computeBacktestMetrics,
} from '../shared/backtest/metrics.js'

const CACHE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'cache',
)

function daysFromArgs(argv) {
  const index = argv.indexOf('--days')
  if (index < 0) return 400
  const value = Math.trunc(Number(argv[index + 1]))
  return Number.isFinite(value) ? Math.max(60, Math.min(800, value)) : 400
}

function adjusted(bar) {
  return {
    date: bar.date,
    open: Number(bar.hfqOpen ?? bar.open),
    high: Number(bar.hfqHigh ?? bar.high),
    low: Number(bar.hfqLow ?? bar.low),
    close: Number(bar.hfqClose ?? bar.close),
    volume: Number(bar.volume),
    amount: Number(bar.amount || 0) * 1000,
  }
}

function trade(entry, exit, quantity, entryDate, exitDate, reason) {
  const buyPrice = executionPrice(entry, 'BUY', 5)
  const sellPrice = executionPrice(exit, 'SELL', 5)
  const buyGross = buyPrice * quantity
  const sellGross = sellPrice * quantity
  const cost = buyGross + tradeFees('BUY', buyGross).total
  const proceeds = sellGross - tradeFees('SELL', sellGross).total
  const netPnl = proceeds - cost
  return {
    entryDate,
    exitDate,
    netPnl: +netPnl.toFixed(2),
    returnPct: +((netPnl / cost) * 100).toFixed(3),
    holdingDays: null,
    exitReason: reason,
  }
}

function simulate(rows, signalIndex, decision) {
  const triggerIndex = signalIndex + 1
  const trigger = rows[triggerIndex]
  if (!trigger) return null
  const entry = Number(decision.primaryPrice)
  const pullback = decision.priceType === 'PULLBACK_WATCH'
  const touched = pullback
    ? trigger.low <= entry && trigger.high >= entry
    : trigger.high >= entry
  if (!touched) return null

  const quantity = Math.max(
    200,
    Math.floor(10_000 / (entry * 100)) * 100,
  )
  const stop = Number(decision.stopPrice)
  const target = Number(decision.targetPrice)
  for (
    let index = triggerIndex + 1;
    index <= Math.min(triggerIndex + 5, rows.length - 1);
    index += 1
  ) {
    const bar = rows[index]
    if (bar.low <= stop) {
      return trade(entry, stop, quantity, trigger.date, bar.date, 'STOP')
    }
    if (bar.high >= target) {
      return trade(entry, target, quantity, trigger.date, bar.date, 'TARGET')
    }
    if (index === Math.min(triggerIndex + 5, rows.length - 1)) {
      return trade(
        entry,
        bar.close,
        quantity,
        trigger.date,
        bar.date,
        'TIME',
      )
    }
  }
  return null
}

const days = daysFromArgs(process.argv)
const files = (await readdir(CACHE))
  .filter((file) => /^daily_.*\.(SH|SZ)\.json$/.test(file))
const tradesByFormula = new Map()
let stocks = 0
let signals = 0

for (const file of files) {
  const record = JSON.parse(await readFile(path.join(CACHE, file), 'utf8'))
  const code = String(record.tsCode || record.code || '').slice(0, 6)
  if (/^(68|8|4|9)/.test(code)) continue
  const allRows = (record.bars || []).map(adjusted)
  const start = Math.max(30, allRows.length - days)
  if (allRows.length <= start + 6) continue
  stocks += 1

  for (let index = start; index < allRows.length - 6; index += 1) {
    const rows = allRows.slice(0, index + 1)
    const current = rows.at(-1)
    const previous = rows.at(-2)
    const formula = evaluateFormulaSelection({
      mode: 'close',
      candles: rows.slice(-60),
      quote: {
        code,
        name: record.name || '',
        price: current.close,
        open: current.open,
        high: current.high,
        low: current.low,
        pct: previous?.close > 0
          ? (current.close / previous.close - 1) * 100
          : null,
        amount: current.amount,
        turnover: 5,
      },
      fund: {
        mainNetYi: 1,
        retailNetYi: -1,
        main5dYi: 1,
        historyDayCount: 5,
      },
      sectorOpportunity: { matched: true },
    })
    for (const match of formula.matches) {
      const decision = buildFormulaPriceDecision({
        code,
        quote: { price: current.close },
        formulaMatches: [match],
        positionMode: 'UNOWNED',
        marketAllowsRisk: true,
        dataComplete: true,
        dataFresh: true,
      })
      if (decision.action !== 'WATCH_BUY') continue
      signals += 1
      const completed = simulate(allRows, index, decision)
      if (!completed) continue
      if (!tradesByFormula.has(match.formulaId)) {
        tradesByFormula.set(match.formulaId, [])
      }
      tradesByFormula.get(match.formulaId).push(completed)
    }
  }
}

console.log('# 公式选股技术形态上限测试')
console.log('')
console.log(`- 日线标的：${stocks}`)
console.log(`- 最近交易日：每股最多 ${days} 日`)
console.log(`- 有完整价格合同的信号：${signals}`)
console.log('- 口径：假设板块与资金均已确认，仅检验技术形态；不是正式验证结果')
console.log('- 成交：次日触价、T+1、5 bps滑点及A股标准费用')
console.log('')
console.log('| 公式 | 成交 | 胜率 | 期望 | 盈利因子 | 最大回撤 |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: |')
for (const [formulaId, trades] of tradesByFormula) {
  const metrics = computeBacktestMetrics(trades)
  console.log(
    `| ${formulaId} | ${metrics.trades || 0}`
    + ` | ${metrics.winRatePct ?? '--'}%`
    + ` | ${metrics.expectancyPct ?? '--'}%`
    + ` | ${metrics.profitFactor ?? '--'}`
    + ` | ${metrics.maxDrawdownPct ?? '--'}% |`,
  )
}
console.log('')
console.log('结论：所有结果固定保持 OBSERVE_ONLY；必须补齐历史板块、资金与盘中快照后才能申请升权。')
