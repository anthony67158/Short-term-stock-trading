#!/usr/bin/env node
// R6：基于 v4 样本的净R组合账户回放（未调参年度验证）。
//
// 用途：回答“按 alpha 选股、日线持有、10万本金，一年能到什么水平”。
// 复用已结算的含费净R(HOLD_TO_HORIZON)，做组合层账户模拟：
//   每个信号日 → 取 alpha 分位≥minPct 的候选，按 alpha 分位排序取 topK
//   → 每笔按账户权益×单笔风险% 定风险现金 → 盈亏 = 净R × 风险现金
//   → 持有 horizon 个交易日后在退出日入账（用信号日+horizon+1 近似退出日）
// 同一时间并发持仓数受 maxConcurrent 限制（组合风险预算的粗近似）。
//
// 注意：净R 已含费/滑点(样本口径)，此处不重复计费。这是日线近似的组合验证，
// 不等于生产分钟链路；结论须配合验收门槛的 provable 标注解读。

import fs from 'node:fs'
import readline from 'node:readline'

import {
  evaluateAcceptance,
} from '../shared/profitabilityAcceptance.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i]] = argv[i + 1]
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const input = args['--input']
  const fold = args['--fold'] ? Number(args['--fold']) : null
  const minPct = Number(args['--min-pct'] || 0.8)
  const topK = Math.max(1, Number(args['--top-k'] || 5))
  const riskPct = Number(args['--risk-pct'] || 0.8) / 100
  const horizon = Math.max(2, Number(args['--horizon'] || 10))
  const initialCash = Number(args['--initial'] || 100000)
  const maxConcurrent = Math.max(1, Number(args['--max-concurrent'] || 10))
  if (!input) throw new Error('usage: --input jsonl [--fold 3 ...]')

  // 读样本，按信号日分组，取 alpha≥minPct 的候选。
  const rl = readline.createInterface({
    input: fs.createReadStream(input),
    crlfDelay: Infinity,
  })
  const byDate = new Map()
  for await (const line of rl) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    if (fold != null && r.fold !== fold) continue
    const pct = r.alphaFeatures?.alphaScorePctRank
    if (!(pct >= minPct)) continue
    if (r.hardStopHit == null) continue
    const d = r.signalDate
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d).push({
      code: r.code,
      pct,
      netR: r.netR?.HOLD_TO_HORIZON,
    })
  }
  const dates = [...byDate.keys()].sort()
  if (!dates.length) throw new Error('no samples after filter')

  // 账户模拟：权益、并发持仓、到期入账。
  let equity = initialCash
  const equitySeries = [equity]
  const perTradeNetR = []
  // 到期入账队列：exitDateIndex -> [{pnl}]
  const settleAt = new Map()
  let concurrent = 0

  let entered = 0
  for (let di = 0; di < dates.length; di += 1) {
    // 先结算今日到期。
    const due = settleAt.get(di) || []
    for (const t of due) {
      equity += t.pnl
      concurrent -= 1
    }
    if (due.length) settleAt.delete(di)

    // 今日建仓：alpha 降序，每日最多 topK 笔，受并发上限约束。
    const cand = byDate.get(dates[di])
      .filter((c) => Number.isFinite(c.netR))
      .sort((a, b) => b.pct - a.pct)
    // 每日取 topK（不超过并发余量）。
    const room = Math.min(topK, maxConcurrent - concurrent)
    for (let k = 0; k < room && k < cand.length; k += 1) {
      const c = cand[k]
      const riskCash = equity * riskPct
      const pnl = c.netR * riskCash
      const exitIdx = Math.min(dates.length - 1, di + horizon + 1)
      if (!settleAt.has(exitIdx)) settleAt.set(exitIdx, [])
      settleAt.get(exitIdx).push({ pnl })
      concurrent += 1
      entered += 1
      perTradeNetR.push(c.netR)
    }
    equitySeries.push(equity)
  }
  // 结算所有剩余未到期。
  for (const [, due] of settleAt) {
    for (const t of due) equity += t.pnl
  }
  equitySeries.push(equity)

  const returnPct = (equity / initialCash - 1) * 100
  // 最大回撤
  let peak = initialCash
  let maxDd = 0
  for (const v of equitySeries) {
    peak = Math.max(peak, v)
    maxDd = Math.max(maxDd, peak > 0 ? (peak - v) / peak * 100 : 0)
  }
  const acceptance = evaluateAcceptance({
    baseRun: {
      equitySeries,
      returnPct,
      maximumDrawdownPct: maxDd,
      perTradeNetR,
    },
    // 无独立 10bps 档（净R已含费），用同一序列占位说明压力档需另跑。
    stressRun: { returnPct },
  })

  const report = {
    schemaVersion: 'v4-portfolio-replay.v1',
    params: { fold, minPct, topK, riskPct, horizon, maxConcurrent, initialCash },
    signalDays: dates.length,
    span: { from: dates[0], to: dates.at(-1) },
    trades: entered,
    finalEquity: Number(equity.toFixed(2)),
    returnPct: Number(returnPct.toFixed(4)),
    maxDrawdownPct: Number(maxDd.toFixed(4)),
    meanTradeNetR: perTradeNetR.length
      ? Number((perTradeNetR.reduce((s, v) => s + v, 0) / perTradeNetR.length).toFixed(4))
      : null,
    winRatePct: perTradeNetR.length
      ? Number((perTradeNetR.filter((v) => v > 0).length / perTradeNetR.length * 100).toFixed(2))
      : null,
    acceptance,
  }
  if (args['--output']) {
    fs.writeFileSync(args['--output'], JSON.stringify(report, null, 2))
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main()
