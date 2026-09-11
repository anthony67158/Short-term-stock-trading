import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { evaluateDecision } from '../api/_decision_orchestrator.js'
import { buildStrategyPatternAnalysis } from '../shared/strategyPatternFeatures.js'
import {
  resolveStrategyPatternCapabilities,
} from '../shared/strategyPatternCapabilities.js'
import { buildRealOutcomeLearning } from '../shared/realOutcomeLearning.js'

assert.ok(process.argv.includes('--online'), 'Use --online for real quotes and quant inference')
const base = 'https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run'
const output = 'harness-artifacts/strategy-runtime'
await mkdir(output, { recursive: true })
const fixture = JSON.parse(await readFile('test/fixtures/comprehensive-test-account.json', 'utf8'))
fixture.account.simulation = true
const before = JSON.stringify(fixture)
const codes = [...new Set([...fixture.holding, ...fixture.plan].map((s) => s.code))]
async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(45_000) })
  assert.equal(response.status, 200, path)
  const value = await response.json()
  assert.notEqual(value.ok, false, value.error)
  return value
}
const report = {
  schemaVersion: 'strategy-runtime-acceptance.v1',
  startedAt: Date.now(),
  scope: 'real-public-quotes-with-isolated-fixture-no-cloud-account-writes',
  strategyPatternCapabilities:
    resolveStrategyPatternCapabilities(process.env),
  cases: [], failures: [],
}
const market = await get('/api/market')
const quotes = (await get(`/api/quote?codes=${codes.join(',')}`)).list
assert.equal(quotes.length, codes.length)
await writeFile(`${output}/market.json`, JSON.stringify(market), { mode: 0o600 })
await writeFile(`${output}/quotes.json`, JSON.stringify(quotes), { mode: 0o600 })
for (const code of codes) {
  try {
    const detail = await get(`/api/stock_detail?code=${code}&quote=1&trends=1&lmt=120`)
    await writeFile(`${output}/${code}-market.json`, JSON.stringify(detail), { mode: 0o600 })
    const quote = detail.quote || quotes.find((q) => q.code === code)
    const analysis = buildStrategyPatternAnalysis({ quote, candles: detail.candles, mode: 'close' })
    const result = await evaluateDecision({
      code, book: fixture, quotes, detail, trends: detail.trends,
      fund: detail.fund, market, sector: null,
    })
    const advice = result.result
    await writeFile(`${output}/${code}-decision.json`, JSON.stringify({
      code, advice, quote, patterns: analysis,
    }), { mode: 0o600 })
    const plans = advice.decisionPaths || []
    assert.ok(plans.length > 0, 'Missing price paths')
    assert.ok(plans.every((p) => p.opportunityScore?.state === 'READY'), 'Quant inference unavailable')
    assert.ok(plans.every((p) => Number.isFinite(p.opportunityScore.expectedNetR)))
    assert.equal(result.meta.llmCalls, 0)
    assert.equal(
      advice.strategyPatternCapabilities?.playbookBlend,
      false,
      'Product pattern tools enabled playbook blending',
    )
    assert.equal(
      advice.strategyPatternCapabilities?.modelFeatures,
      false,
      'Product pattern tools enabled model features',
    )
    if (advice.strategyPattern) {
      assert.ok(
        advice.strategyPattern.score >= 70,
        'Displayed pattern did not meet evidence threshold',
      )
    }
    for (const plan of plans) {
      const confirmation =
        plan.entryPlan?.strategyPatternConfirmation
      if (!confirmation) continue
      assert.equal(
        confirmation.patternId,
        plan.patternContext?.id,
        'Confirmation contract does not match route pattern',
      )
      assert.match(confirmation.summary, /持续观察满60秒/)
    }
    assert.notEqual(advice.decisionPlan.actionability, 'READY', 'Closed-market instruction must not execute')
    assert.equal(JSON.stringify(fixture), before, 'Read-only evaluation mutated the ledger')
    report.cases.push({
      code, name: quote.name, tradeDate: quote.tradeDate, price: quote.price,
      bars: detail.candles.length, trends: detail.trends?.length || 0,
      historyDays: detail.fund?.historyDayCount,
      action: advice.decisionPlan.action, actionability: advice.decisionPlan.actionability,
      lots: advice.decisionPlan.quantity?.lots,
      reasons: advice.decisionPlan.blockedReasons,
      patterns: analysis.patterns.filter((p) => p.matched),
      paths: plans.map((p) => ({
        route: p.route, entry: p.entryPlan?.price,
        stop: p.exitPlan?.hardStopPrice, target: p.exitPlan?.takeProfitPrice,
        expectedNetR: p.opportunityScore.expectedNetR,
        modelVersion: p.opportunityScore.modelVersion,
      })),
    })
    console.log(JSON.stringify({ code, action: advice.decisionPlan.action, paths: plans.length, pass: true }))
  } catch (error) {
    report.failures.push({ code, error: error.message })
    console.log(JSON.stringify({ code, pass: false, error: error.message }))
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 })
}
report.simulationLearningSamples = buildRealOutcomeLearning(fixture).overall.samples
assert.equal(report.simulationLearningSamples, 0)
report.passed = report.failures.length === 0
report.finishedAt = Date.now()
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 })
process.exitCode = report.passed ? 0 : 1
