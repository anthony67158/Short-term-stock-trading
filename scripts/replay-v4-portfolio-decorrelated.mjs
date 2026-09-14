#!/usr/bin/env node
// Task12：组合层强制低相关去重的净R账户回放（对照 replay-v4-portfolio.mjs）。
//
// 与基线回放的唯一区别：每个信号日建仓前，用 shared/portfolioCorrelationSelection
// 对「候选 + 当前在场持仓」的入场前 trailing 收益做贪心皮尔逊去重，把并发持仓
// 相关性压到 maxCorrelation 以下，其余账户口径（净R已含费、按风险现金定仓、
// 到期入账、并发上限）与基线完全一致，从而可比地量化「去相关是否压回撤」。
//
// 严格无前视：相关性只用 signalDate 及之前的 trailing 收益（由
// enrich-v4-trailing-returns.py 生成），绝不使用持有期未来 bar。

import fs from 'node:fs'
import readline from 'node:readline'

import { evaluateAcceptance } from '../shared/profitabilityAcceptance.js'
import {
  selectLowCorrelationBook,
} from '../shared/portfolioCorrelationSelection.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i]] = argv[i + 1]
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const input = args['--input'] // enrich 输出的 trailing-returns JSONL
  const fold = args['--fold'] ? Number(args['--fold']) : null
  const minPct = Number(args['--min-pct'] || 0.8)
  const topK = Math.max(1, Number(args['--top-k'] || 5))
  const riskPct = Number(args['--risk-pct'] || 0.8) / 100
  const horizon = Math.max(2, Number(args['--horizon'] || 10))
  const initialCash = Number(args['--initial'] || 100000)
  const maxConcurrent = Math.max(1, Number(args['--max-concurrent'] || 40))
  // maxCorrelation>=1 等价于关闭去相关（用于产出可比基线）。
  const maxCorrelation = Number(args['--max-correlation'] || 0.7)
  if (!input) throw new Error('usage: --input trailing.jsonl [--fold 3 ...]')

  const rl = readline.createInterface({
    input: fs.createReadStream(input),
    crlfDelay: Infinity,
  })
  const byDate = new Map()
  for await (const line of rl) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    if (fold != null && r.fold !== fold) continue
    const pct = r.alphaScorePctRank
    if (!(pct >= minPct)) continue
    if (r.hardStopHit == null) continue
    if (!Number.isFinite(r.netRHold)) continue
    const d = r.signalDate
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d).push({
      key: r.code,
      pct,
      netR: r.netRHold,
      returns: Array.isArray(r.trailingReturns) ? r.trailingReturns : [],
    })
  }
  const dates = [...byDate.keys()].sort()
  if (!dates.length) throw new Error('no samples after filter')

  let equity = initialCash
  const equitySeries = [equity]
  const perTradeNetR = []
  const settleAt = new Map() // exitIdx -> [{ pnl, key }]
  // 在场持仓（含 trailing 收益），用于相关性判定。
  let holdings = [] // [{ key, returns, exitIdx }]
  let entered = 0
  let corrSkipped = 0

  for (let di = 0; di < dates.length; di += 1) {
    const due = settleAt.get(di) || []
    for (const t of due) equity += t.pnl
    if (due.length) settleAt.delete(di)
    // 到期的从在场持仓移除。
    if (due.length) {
      const doneKeys = new Set(due.map((t) => t.token))
      holdings = holdings.filter((h) => !doneKeys.has(h.token))
    }

    const cand = byDate.get(dates[di])
      .filter((c) => Number.isFinite(c.netR))
      .sort((a, b) => b.pct - a.pct)

    const room = Math.min(topK, maxConcurrent - holdings.length)
    if (room > 0 && cand.length) {
      const picked = selectLowCorrelationBook(cand, holdings, {
        maxCorrelation,
        maxHoldings: maxConcurrent,
        roomForNew: room,
      })
      corrSkipped += picked.skipped.filter(
        (s) => s.reason === 'HIGH_CORRELATION',
      ).length
      for (const c of picked.accepted) {
        const riskCash = equity * riskPct
        const pnl = c.netR * riskCash
        const exitIdx = Math.min(dates.length - 1, di + horizon + 1)
        const token = `${c.key}@${di}`
        if (!settleAt.has(exitIdx)) settleAt.set(exitIdx, [])
        settleAt.get(exitIdx).push({ pnl, token })
        holdings.push({ key: c.key, token, returns: c.returns, exitIdx })
        entered += 1
        perTradeNetR.push(c.netR)
      }
    }
    equitySeries.push(equity)
  }
  for (const [, due] of settleAt) for (const t of due) equity += t.pnl
  equitySeries.push(equity)

  const returnPct = (equity / initialCash - 1) * 100
  let peak = initialCash
  let maxDd = 0
  for (const v of equitySeries) {
    peak = Math.max(peak, v)
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - v) / peak) * 100 : 0)
  }
  const acceptance = evaluateAcceptance({
    baseRun: {
      equitySeries,
      returnPct,
      maximumDrawdownPct: maxDd,
      perTradeNetR,
    },
    stressRun: { returnPct },
  })

  const report = {
    schemaVersion: 'v4-portfolio-replay-decorrelated.v1',
    params: {
      fold, minPct, topK, riskPct, horizon, maxConcurrent,
      maxCorrelation, initialCash,
    },
    signalDays: dates.length,
    span: { from: dates[0], to: dates.at(-1) },
    trades: entered,
    correlationSkipped: corrSkipped,
    finalEquity: Number(equity.toFixed(2)),
    returnPct: Number(returnPct.toFixed(4)),
    maxDrawdownPct: Number(maxDd.toFixed(4)),
    meanTradeNetR: perTradeNetR.length
      ? Number(
        (perTradeNetR.reduce((s, v) => s + v, 0) / perTradeNetR.length)
          .toFixed(4),
      )
      : null,
    winRatePct: perTradeNetR.length
      ? Number(
        (perTradeNetR.filter((v) => v > 0).length / perTradeNetR.length * 100)
          .toFixed(2),
      )
      : null,
    acceptance,
  }
  if (args['--output']) {
    fs.writeFileSync(args['--output'], JSON.stringify(report, null, 2))
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main()
