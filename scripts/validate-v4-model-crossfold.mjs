#!/usr/bin/env node
// R4/R5 验证：v4 特征的跨折时间外推能力（正式、可复现）。
//
// 目的：证明「用模型预测净R」比「规则按 alpha 分位追高」更能跨 regime 外推。
// 做法：fold1+fold2 训练岭回归（标准化特征），在 fold3（完全未见）上：
//   1) 按预测分位分十档，看真实净R是否单调（排序能力）；
//   2) IC/RankIC（预测 vs 真实净R）。
// 所有输入已在 [-1,1]，带有限值守卫；确定性、无随机。
//
// 这是排序能力证据，非账户收益；账户结论见 R6/Task8。

import fs from 'node:fs'
import readline from 'node:readline'

const FEATURES = [
  'alphaScorePctRank',
  'alphaScoreZ',
  'alphaScoreMomentum5',
]

function finite(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 岭回归（标准化X，不罚偏置），返回 {mu,sd,coef}。
function fitRidge(X, y, lambda = 1.0) {
  const n = X.length
  const d = X[0].length
  const mu = new Array(d).fill(0)
  const sd = new Array(d).fill(0)
  for (const row of X) for (let j = 0; j < d; j += 1) mu[j] += row[j]
  for (let j = 0; j < d; j += 1) mu[j] /= n
  for (const row of X) for (let j = 0; j < d; j += 1) {
    sd[j] += (row[j] - mu[j]) ** 2
  }
  for (let j = 0; j < d; j += 1) sd[j] = Math.sqrt(sd[j] / n) + 1e-9
  // 设计矩阵 [standardized | 1]
  const p = d + 1
  const AtA = Array.from({ length: p }, () => new Array(p).fill(0))
  const Aty = new Array(p).fill(0)
  for (let i = 0; i < n; i += 1) {
    const z = new Array(p)
    for (let j = 0; j < d; j += 1) z[j] = (X[i][j] - mu[j]) / sd[j]
    z[d] = 1
    for (let a = 0; a < p; a += 1) {
      Aty[a] += z[a] * y[i]
      for (let b = 0; b < p; b += 1) AtA[a][b] += z[a] * z[b]
    }
  }
  for (let j = 0; j < d; j += 1) AtA[j][j] += lambda // 不罚偏置
  const coef = solve(AtA, Aty)
  return { mu, sd, coef }
}

// 高斯消元解 Ax=b。
function solve(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c += 1) {
    let piv = c
    for (let r = c + 1; r < n; r += 1) {
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    }
    [M[c], M[piv]] = [M[piv], M[c]]
    const d = M[c][c] || 1e-12
    for (let j = c; j <= n; j += 1) M[c][j] /= d
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue
      const f = M[r][c]
      for (let j = c; j <= n; j += 1) M[r][j] -= f * M[c][j]
    }
  }
  return M.map((row) => row[n])
}

function predict(model, x) {
  const { mu, sd, coef } = model
  let s = coef[coef.length - 1]
  for (let j = 0; j < mu.length; j += 1) {
    s += coef[j] * ((x[j] - mu[j]) / sd[j])
  }
  return s
}

function spearman(a, b) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0])
    const r = new Array(arr.length)
    idx.forEach(([, i], k) => { r[i] = k })
    return r
  }
  return pearson(rank(a), rank(b))
}
function pearson(a, b) {
  const n = a.length
  const ma = a.reduce((s, v) => s + v, 0) / n
  const mb = b.reduce((s, v) => s + v, 0) / n
  let num = 0; let da = 0; let db = 0
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0
}

async function main() {
  const args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1]
  const input = args['--input']
  if (!input) throw new Error('usage: --input jsonl')

  const rl = readline.createInterface({
    input: fs.createReadStream(input), crlfDelay: Infinity,
  })
  const byFold = { 1: [], 2: [], 3: [] }
  for await (const line of rl) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    const af = r.alphaFeatures || {}
    const x = FEATURES.map((k) => finite(af[k]))
    const y = finite(r.netR?.HOLD_TO_HORIZON)
    if (x.some((v) => v == null) || y == null) continue
    if (byFold[r.fold]) byFold[r.fold].push({ x, y })
  }

  const train = [...byFold[1], ...byFold[2]]
  const test = byFold[3]
  const model = fitRidge(train.map((r) => r.x), train.map((r) => r.y))
  const preds = test.map((r) => ({ p: predict(model, r.x), y: r.y }))
  preds.sort((a, b) => a.p - b.p)
  const deciles = []
  for (let q = 0; q < 10; q += 1) {
    const seg = preds.slice(q * preds.length / 10, (q + 1) * preds.length / 10)
    const mean = seg.reduce((s, r) => s + r.y, 0) / seg.length
    deciles.push({ decile: q, n: seg.length, realMeanNetR: Number(mean.toFixed(4)) })
  }
  const ic = pearson(preds.map((r) => r.p), preds.map((r) => r.y))
  const rankIc = spearman(preds.map((r) => r.p), preds.map((r) => r.y))
  // 单调性：相邻档非降比例
  let mono = 0
  for (let i = 1; i < deciles.length; i += 1) {
    if (deciles[i].realMeanNetR >= deciles[i - 1].realMeanNetR) mono += 1
  }
  const report = {
    schemaVersion: 'v4-crossfold-validate.v1',
    features: FEATURES,
    trainFolds: [1, 2],
    testFold: 3,
    trainN: train.length,
    testN: test.length,
    coefStandardized: model.coef.map((c) => Number(c.toFixed(5))),
    testIC: Number(ic.toFixed(5)),
    testRankIC: Number(rankIc.toFixed(5)),
    monotonicSteps: `${mono}/9`,
    deciles,
    topBottomSpread: Number(
      (deciles[9].realMeanNetR - deciles[0].realMeanNetR).toFixed(4),
    ),
  }
  if (args['--output']) {
    fs.writeFileSync(args['--output'], JSON.stringify(report, null, 2))
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main()
