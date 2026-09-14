import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { loadHistory, digest } from './data.mjs'
import { runPortfolio } from './engine.mjs'
import { auditLedger } from './ledger-audit.mjs'

const config = JSON.parse(fs.readFileSync('backtest/etf/validation.json'))
const data = loadHistory('backtest/cache/etf-v1', 'backtest/etf/experiment.json')
const priorRaw = fs.readFileSync(config.priorResult)
assert.equal(digest(priorRaw), config.priorSha256, 'PRIOR_RESULT_HASH_MISMATCH')
const prior = JSON.parse(priorRaw)
const sourceFiles = [
  'backtest/etf/validation.json', 'backtest/etf/experiment.json', 'backtest/etf/corporate-actions.json',
  'backtest/etf/data.mjs', 'backtest/etf/execution.mjs', 'backtest/etf/engine.mjs',
  'backtest/etf/ledger-audit.mjs', 'backtest/etf/validate.mjs', 'shared/ashareStrategyExecution.js',
]
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, digest(fs.readFileSync(file))]))
const provenance = { sourceHashes, input: data.manifest, priorSha256: config.priorSha256 }
const id = digest(JSON.stringify(provenance))
const output = path.resolve('backtest/reports/etf-v2', id)
fs.mkdirSync(output, { recursive: true })
function save(file, value) {
  const raw = JSON.stringify(value, null, 2) + '\n'
  const destination = path.join(output, file)
  if (fs.existsSync(destination)) assert.equal(fs.readFileSync(destination, 'utf8'), raw, 'NONDETERMINISTIC_RESULT')
  else fs.writeFileSync(destination, raw)
  return { file, sha256: digest(raw) }
}
function rollingYear(run) {
  const returns = []
  for (let i = 252; i < run.curve.length; i++) {
    returns.push((run.curve[i].equity / run.curve[i - 252].equity - 1) * 100)
  }
  returns.sort((a, b) => a - b)
  return { sessions: 252, windows: returns.length,
    minimumPct: returns[0], medianPct: returns[Math.floor(returns.length / 2)], maximumPct: returns.at(-1),
    positiveWindowPct: returns.filter(value => value > 0).length / returns.length * 100,
    note: 'Overlapping historical windows, not independent outcomes.' }
}
function summary(run) {
  const timestamp = date => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`)
  const years = (timestamp(run.curve.at(-1).date) - timestamp(run.curve[0].date)) / 86400000 / 365.25
  return {
    model: run.model, slippageBps: run.slippageBps, stopExecution: run.stopExecution,
    finalEquity: run.finalEquity, netPnl: run.netPnl, returnPct: run.returnPct, cagrPct: run.cagrPct,
    maxDrawdownPct: run.maxDrawdownPct, exposurePct: run.averageExposurePct, fees: run.fees,
    fillCount: run.fills.length, closedTradeCount: run.trades.length, annual: run.annual,
    annualCostDrag: config.annualOperatingCosts.map(annualCost => ({
      annualCost, approximateYears: years, netPnlAfterSimpleCost: run.netPnl - years * annualCost,
      note: 'Post-hoc cost subtraction, not reinvestment-aware NAV or an actual vendor bill.',
    })),
    rollingYear: rollingYear(run),
  }
}
function execute(label, args, scope = data) {
  const run = runPortfolio({ ...scope, ...args })
  const audit = auditLedger(run, scope)
  const artifact = save(`${label}.json`, { run, audit })
  console.log(JSON.stringify({ label, finalEquity: run.finalEquity,
    maxDrawdownPct: run.maxDrawdownPct, ledger: audit.state }))
  return { summary: summary(run), audit, artifact, run }
}
const report = {
  schemaVersion: 'etf-validation-result.v2', productionEligible: false,
  ...provenance, config, full: {}, subperiods: {}, exclusions: {}, prefixChecks: [],
  priorEconomicEquivalence: {}, priorAudits: {}, changedPriorSignalDates: {},
}
report.referencePriceAudit = data.assets.map(asset => {
  let checked = 0
  for (let i = 1; i < asset.bars.length; i++) {
    const bar = asset.bars[i], previous = asset.bars[i - 1]
    const dividend = asset.dividends.find(item => item.ex_date === bar.date)?.div_cash || 0
    const split = asset.splits.find(item => item.priceDate === bar.date)?.ratio || 1
    const expected = previous.close / split - dividend
    assert.ok(Math.abs(expected - bar.pre_close) <= 0.006,
      `PREVIOUS_REFERENCE_MISMATCH:${asset.code}:${bar.date}`)
    checked++
  }
  return { code: asset.code, checked, state: 'PASS',
    note: 'Internal reference consistency only, not an independent market data source.' }
})
const baseRuns = new Map()
for (const [key, run] of Object.entries(prior.variants)) report.priorAudits[key] = auditLedger(run, data)
for (const scenario of config.executionScenarios) {
  for (const model of config.models) {
    const key = `${scenario.id}-${model}`
    const executed = execute(key, { model, slippageBps: scenario.slippageBps,
      stopExecution: scenario.stopExecution })
    const { run, ...record } = executed
    report.full[key] = record
    if (scenario.id.startsWith('original_')) {
      const old = prior.variants[`${model}:${scenario.slippageBps}`]
      assert.equal(run.finalEquity, old.finalEquity)
      assert.deepEqual(run.fills, old.fills)
      assert.deepEqual(run.curve, old.curve)
      report.priorEconomicEquivalence[key] = true
      const before = new Map(old.signals.map(signal => [signal.date, JSON.stringify(signal)]))
      report.changedPriorSignalDates[key] = run.signals
        .filter(signal => before.get(signal.date) !== JSON.stringify(signal)).map(signal => signal.date)
    }
    if (scenario.id === 'original_5bps') baseRuns.set(model, run)
  }
}
for (const period of config.subperiods) {
  const scoped = { ...data, spec: { ...data.spec, ...period } }
  for (const model of config.models) {
    const key = `${period.start}-${period.end}-${model}`
    const { run, ...record } = execute(key, { model, slippageBps: 10, stopExecution: 'NEXT_OPEN' }, scoped)
    report.subperiods[key] = record
  }
}
for (const excluded of config.assetExclusions) {
  const scoped = { ...data, assets: data.assets.filter(asset => asset.group !== excluded) }
  for (const model of config.models.filter(name => name !== 'cash')) {
    const key = `without-${excluded}-${model}`
    const { run, ...record } = execute(key, { model, slippageBps: 10, stopExecution: 'NEXT_OPEN' }, scoped)
    report.exclusions[key] = record
  }
}
for (const cutoff of config.prefixCutoffs) {
  for (const model of config.models) {
    const run = runPortfolio({ ...data, spec: { ...data.spec, end: cutoff }, model, slippageBps: 5 })
    const full = baseRuns.get(model)
    for (const field of ['curve', 'fills', 'signals']) {
      assert.deepEqual(run[field], full[field].filter(row => row.date <= cutoff),
        `PREFIX_MISMATCH:${model}:${cutoff}:${field}`)
    }
    report.prefixChecks.push({ model, cutoff, state: 'PASS' })
  }
}
report.status = 'VALIDATION_COMPLETE_NOT_RELEASE_ELIGIBLE'
report.blockers = ['FIXED_SURVIVOR_UNIVERSE', 'NOT_AN_UNTOUCHED_HOLDOUT',
  'NO_MINUTE_OR_ORDERBOOK_FILL_VERIFICATION', 'NO_PRODUCTION_ETF_EXPECTED_VALUE_MODEL',
  'PRIOR_EXCESS_RETURN_LOWER_BOUND_NONPOSITIVE', 'STOCK_M0_DECISION_ENVELOPES_STILL_MISSING']
const artifact = save('validation.json', report)
console.log(JSON.stringify({ complete: true, output: path.join(output, artifact.file), sha256: artifact.sha256 }))
