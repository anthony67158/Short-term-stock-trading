import fs from 'node:fs'
import path from 'node:path'
import { loadHistory, digest } from './data.mjs'
import { runPortfolio } from './engine.mjs'
import { auditLegacyResult } from '../audit-current-chain.mjs'

function bootstrapExcess(candidate, baseline, repetitions = 2000) {
  const returns = curve => curve.map((row, index) =>
    row.equity / (index ? curve[index - 1].equity : 100000) - 1)
  const a = returns(candidate.curve), b = returns(baseline.curve)
  const diffs = a.map((value, i) => value - b[i])
  let seed = 20260914
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  const means = []
  for (let iteration = 0; iteration < repetitions; iteration++) {
    let total = 0, count = 0
    while (count < diffs.length) {
      const start = Math.floor(random() * diffs.length)
      for (let j = 0; j < 20 && count < diffs.length; j++, count++) {
        total += diffs[(start + j) % diffs.length]
      }
    }
    means.push(total / count * 252 * 100)
  }
  means.sort((x, y) => x - y)
  return {
    method: 'paired circular moving-block bootstrap; 20 sessions; 2000 draws; fixed seed',
    meanAnnualizedExcessPct: diffs.reduce((sum, n) => sum + n, 0) / diffs.length * 252 * 100,
    lower95Pct: means[Math.floor(means.length * 0.025)],
    upper95Pct: means[Math.floor(means.length * 0.975)],
    caveat: 'Exploratory dependent historical evidence; not a fresh holdout or selection-adjusted CI.',
  }
}

const root = path.resolve('backtest/etf')
const output = path.resolve('backtest/reports/etf-v1')
fs.mkdirSync(output, { recursive: true })
const sourceFiles = ['experiment.json', 'corporate-actions.json', 'data.mjs', 'execution.mjs', 'engine.mjs', 'run.mjs']
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]))
sourceHashes['shared/ashareStrategyExecution.js'] = digest(fs.readFileSync('shared/ashareStrategyExecution.js'))
let data
try {
  data = loadHistory('backtest/cache/etf-v1', path.join(root, 'experiment.json'))
} catch (error) {
  const blocked = { state: 'BLOCKED_DATA', reason: error.message, sourceHashes, productionEligible: false }
  fs.writeFileSync(path.join(output, 'blocked.json'), JSON.stringify(blocked, null, 2))
  console.error(JSON.stringify(blocked))
  process.exit(2)
}
const result = {
  schemaVersion: 'etf-study-result.v1', productionEligible: false,
  sourceHashes, input: data.manifest, corporateActionsHash: data.corporateActionsHash,
  spec: data.spec, sessions: data.calendar.filter(date => date >= data.spec.start).length,
  quality: data.assets.map(asset => ({
    code: asset.code, bars: asset.bars.length, dividends: asset.dividends.length, splits: asset.splits.length,
  })),
  variants: {},
}
const legacy = '/tmp/backtest-current-chain-191d-result.json'
if (fs.existsSync(legacy)) result.legacyAudit = auditLegacyResult(JSON.parse(fs.readFileSync(legacy)))
for (const slippageBps of data.spec.slippageBps) {
  for (const model of [...data.spec.models, 'buy_hold_reference']) {
    const run = runPortfolio({ ...data, model, slippageBps })
    result.variants[`${model}:${slippageBps}`] = run
    console.log(JSON.stringify({
      model, slippageBps, finalEquity: run.finalEquity, returnPct: run.returnPct,
      maxDrawdownPct: run.maxDrawdownPct, fills: run.fills.length, fees: run.fees,
    }))
  }
}
result.comparisons = {}
for (const model of ['monthly_trend', 'weekly_rotation']) {
  const run = result.variants[`${model}:5`]
  const stress = result.variants[`${model}:10`]
  const paired = bootstrapExcess(run, result.variants['static_risk_matched:5'])
  result.comparisons[model] = {
    ...paired,
    positiveNetReturn: run.netPnl > 0,
    positiveUnderStress: stress.netPnl > 0,
    drawdownUnder10Pct: run.maxDrawdownPct <= 10,
    positiveExcessLowerBound: paired.lower95Pct > 0,
    state: 'RESEARCH_ONLY',
    blockers: ['FIXED_UNIVERSE_SELECTION_BIAS', 'NO_UNTOUCHED_FORWARD_PERIOD',
      'DAILY_EXECUTION_APPROXIMATION', 'NO_PRODUCTION_ETF_VALUE_CONTRACT'],
  }
}
const id = digest(JSON.stringify({ sourceHashes, input: data.manifest }))
const file = path.join(output, `result-${id}.json`)
const encoded = JSON.stringify(result, null, 2)
if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== encoded) throw new Error('NONDETERMINISTIC_RESULT')
fs.writeFileSync(file, encoded)
const summary = ['# ETF Frozen Research Results', '',
  `Evaluation: ${data.spec.start}-${data.spec.end}; ${result.sessions} sessions; initial cash CNY 100000.`,
  '', 'Research only. Not production-equivalent and not an untouched holdout.', '',
  '| Model | Slippage bps | Final equity | Return % | CAGR % | MDD % | Fees | Fills | Exposure % |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|']
for (const run of Object.values(result.variants)) {
  summary.push(`| ${run.model} | ${run.slippageBps} | ${run.finalEquity.toFixed(2)} | ${run.returnPct.toFixed(2)} | ${run.cagrPct.toFixed(2)} | ${run.maxDrawdownPct.toFixed(2)} | ${run.fees.toFixed(2)} | ${run.fills.length} | ${run.averageExposurePct.toFixed(2)} |`)
}
summary.push('', '## Annual Mark-to-Market Returns', '',
  '| Year | Static risk matched | Monthly trend | Weekly rotation | Buy and hold reference |',
  '|---|---:|---:|---:|---:|')
for (const year of Object.keys(result.variants['cash:5'].annual)) {
  summary.push(`| ${year} | ${['static_risk_matched', 'monthly_trend', 'weekly_rotation', 'buy_hold_reference']
    .map(model => result.variants[`${model}:5`].annual[year].returnPct.toFixed(2)).join(' | ')} |`)
}
summary.push('', '## Comparisons', '', '```json', JSON.stringify(result.comparisons, null, 2), '```',
  '', '## Limits', '', ...data.spec.limitations.map(item => `- ${item}`),
  '- Buy-and-hold is a diagnostic reference with the same initial sizing, no subsequent stop or rebalance; risk drifts.',
  '- End equity includes open holdings and dividend receivables; it is not fully liquidated cash.',
  '- Intraday fills are stop-price approximations without minute data or order-book evidence.',
  '- Final equity excludes software/data subscription costs and cash interest.',
  '', `Result: ${file}`, `SHA-256: ${digest(encoded)}`)
fs.writeFileSync(path.join(output, `summary-${id}.md`), summary.join('\n') + '\n')
console.log(JSON.stringify({ output: file, comparisons: result.comparisons }))
