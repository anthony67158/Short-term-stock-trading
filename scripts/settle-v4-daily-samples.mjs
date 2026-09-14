#!/usr/bin/env node
// 方案A 第2步：逐行读 Python 预处理的持有期样本 JSONL，用已测的
// shared/exitActionValue.js 结算三退出动作净R，并用 alpha158SignalFeatures.js
// 装配 8 维 alpha 连续特征块，输出 v4 训练样本 JSONL。
//
// 按行读取，天然规避大 JSON 的 ERR_STRING_TOO_LONG；结算与特征口径与生产共用
// 同一份纯函数，无 JS/Python 漂移。

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import { computeExitActionValues } from '../shared/exitActionValue.js'
import { alpha158FeatureBlock } from '../shared/alpha158SignalFeatures.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i]] = argv[i + 1]
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const input = args['--input']
  const output = args['--output']
  const stopPct = Math.max(0.01, Number(args['--stop-pct'] || 0.06))
  const lots = Math.max(1, Number(args['--lots'] || 10))
  if (!input || !output) {
    throw new Error('usage: --input jsonl --output jsonl [--stop-pct --lots]')
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(input),
    crlfDelay: Infinity,
  })
  const out = fs.createWriteStream(output)
  let written = 0
  let read = 0

  for await (const line of rl) {
    if (!line.trim()) continue
    read += 1
    const row = JSON.parse(line)
    const entryPrice = Number(row.entryPrice)
    const stopPrice = entryPrice * (1 - stopPct)
    const exit = computeExitActionValues({
      entryPrice,
      stopPrice,
      shares: lots * 100,
      holdingRows: row.holdingRows,
      slippageBps: 5,
    })
    if (!exit.available) continue
    const block = alpha158FeatureBlock({
      state: 'ACTIVE',
      asOfDate: row.signalDate,
      percentile: row.alpha?.percentile,
      recentRankIc: row.alpha?.rankIc20,
      overallRankIc: row.alpha?.rankIc60,
      scoreMomentum5: row.alpha?.scoreMomentum5,
    }, { expectedDate: row.signalDate })

    out.write(`${JSON.stringify({
      signalDate: row.signalDate,
      entryDate: row.entryDate,
      code: row.code,
      fold: row.fold,
      entryPrice: Number(entryPrice.toFixed(4)),
      stopPrice: Number(stopPrice.toFixed(4)),
      hardStopHit: exit.hardStopHit,
      bestAction: exit.bestAction,
      netR: {
        HOLD_TO_HORIZON: exit.actions.HOLD_TO_HORIZON.netR,
        PARTIAL_REDUCE: exit.actions.PARTIAL_REDUCE.netR,
        FULL_EXIT: exit.actions.FULL_EXIT.netR,
      },
      alphaFeatures: block.values,
      alphaAvailable: block.available,
    })}\n`)
    written += 1
    if (read % 20000 === 0) {
      process.stdout.write(
        `${JSON.stringify({ stage: 'PROGRESS', read, written })}\n`,
      )
    }
  }
  out.end()
  process.stdout.write(
    `${JSON.stringify({
      stage: 'DONE', output: path.resolve(output), read, written,
    })}\n`,
  )
}

main()
