#!/usr/bin/env node
// Task8：v4 组合参数寻优（fold3 未调参年度，找最接近目标的最优组合）。
//
// 一次性把 fold 样本读进内存，再对参数网格反复回放，避免重复读大文件。
// 目标（可接近，非硬性）：年度收益 10-20%、最大回撤≤10%、正净R下界。
// 打分：对未达标项按距离惩罚，收益在区间内给满分、超区间轻罚，回撤超限重罚。
//
// 退出动作可选 HOLD_TO_HORIZON / PARTIAL_REDUCE / FULL_EXIT —— 三者净R已在
// 样本中，寻优同时挑最优退出方式。净R已含费/滑点，日线近似。

import fs from 'node:fs'
import readline from 'node:readline'

const EXITS = ['HOLD_TO_HORIZON', 'PARTIAL_REDUCE', 'FULL_EXIT']

function replay(rowsByDate, dates, {
  minPct, topK, riskPct, horizon, maxConcurrent, exit, initial,
}) {
  let equity = initial
  const curve = [equity]
  const trades = []
  const settleAt = new Map()
  let concurrent = 0
  for (let di = 0; di < dates.length; di += 1) {
    const due = settleAt.get(di) || []
    for (const t of due) { equity += t.pnl; concurrent -= 1 }
    if (due.length) settleAt.delete(di)
    const cand = (rowsByDate.get(dates[di]) || [])
      .filter((c) => c.pct >= minPct && Number.isFinite(c.netR[exit]))
      .sort((a, b) => b.pct - a.pct)
    const room = Math.min(topK, maxConcurrent - concurrent)
    for (let k = 0; k < room && k < cand.length; k += 1) {
      const riskCash = equity * riskPct
      const pnl = cand[k].netR[exit] * riskCash
      const exitIdx = Math.min(dates.length - 1, di + horizon + 1)
      if (!settleAt.has(exitIdx)) settleAt.set(exitIdx, [])
      settleAt.get(exitIdx).push({ pnl })
      concurrent += 1
      trades.push(cand[k].netR[exit])
    }
    curve.push(equity)
  }
  for (const [, due] of settleAt) for (const t of due) equity += t.pnl
  curve.push(equity)
  let peak = initial
  let maxDd = 0
  for (const v of curve) {
    peak = Math.max(peak, v)
    maxDd = Math.max(maxDd, peak > 0 ? (peak - v) / peak * 100 : 0)
  }
  const ret = (equity / initial - 1) * 100
  const win = trades.length
    ? trades.filter((v) => v > 0).length / trades.length * 100
    : 0
  const meanR = trades.length
    ? trades.reduce((s, v) => s + v, 0) / trades.length
    : 0
  return {
    trades: trades.length,
    returnPct: ret,
    maxDrawdownPct: maxDd,
    winRatePct: win,
    meanTradeNetR: meanR,
  }
}

// 越大越好：收益在[10,20]满分，超出线性衰减；回撤>10按超出量重罚；无交易判 0。
function score(m) {
  if (m.trades < 30) return -1e9
  let s = 0
  if (m.returnPct >= 10 && m.returnPct <= 20) s += 100
  else if (m.returnPct > 20) s += 100 - (m.returnPct - 20) * 2
  else s += 100 - (10 - m.returnPct) * 4 // 低于10惩罚更重
  const ddOver = Math.max(0, m.maxDrawdownPct - 10)
  s -= ddOver * 6
  return s
}

async function main() {
  const args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1]
  const input = args['--input']
  const fold = args['--fold'] ? Number(args['--fold']) : null
  const initial = Number(args['--initial'] || 100000)
  const output = args['--output']
  if (!input) throw new Error('usage: --input jsonl --fold 3 [--output f]')

  // 读全部候选（不预过滤 minPct，寻优时再筛）。
  const rl = readline.createInterface({
    input: fs.createReadStream(input), crlfDelay: Infinity,
  })
  const byDate = new Map()
  for await (const line of rl) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    if (fold != null && r.fold !== fold) continue
    const pct = r.alphaFeatures?.alphaScorePctRank
    if (!(pct >= 0)) continue
    const d = r.signalDate
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d).push({ pct, netR: r.netR })
  }
  const dates = [...byDate.keys()].sort()

  const grid = {
    minPct: [0.7, 0.8, 0.85, 0.9],
    topK: [2, 3, 5, 8],
    riskPct: [0.2, 0.3, 0.5, 0.8].map((v) => v / 100),
    horizon: [5, 10],
    maxConcurrent: [15, 30, 60],
    exit: EXITS,
  }
  const results = []
  for (const minPct of grid.minPct)
  for (const topK of grid.topK)
  for (const riskPct of grid.riskPct)
  for (const horizon of grid.horizon)
  for (const maxConcurrent of grid.maxConcurrent)
  for (const exit of grid.exit) {
    const m = replay(byDate, dates, {
      minPct, topK, riskPct, horizon, maxConcurrent, exit, initial,
    })
    results.push({
      params: { minPct, topK, riskPct, horizon, maxConcurrent, exit },
      metrics: {
        trades: m.trades,
        returnPct: Number(m.returnPct.toFixed(3)),
        maxDrawdownPct: Number(m.maxDrawdownPct.toFixed(3)),
        winRatePct: Number(m.winRatePct.toFixed(2)),
        meanTradeNetR: Number(m.meanTradeNetR.toFixed(4)),
      },
      score: Number(score(m).toFixed(2)),
    })
  }
  results.sort((a, b) => b.score - a.score)
  const top = results.slice(0, 15)
  const report = {
    schemaVersion: 'v4-portfolio-optimize.v1',
    fold,
    combos: results.length,
    signalDays: dates.length,
    top,
  }
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2))
  process.stdout.write(`${JSON.stringify({ combos: results.length, top: top.slice(0, 8) }, null, 2)}\n`)
}

main()
