import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  compileStrategySpecV2,
  evaluateStrategySignalV2,
} from '../shared/strategySpecV2.js'
import {
  getStrategyCatalogV2,
} from '../shared/strategyCatalogV2.js'
import {
  buildDefaultStrategyGovernance,
  transitionStrategyState,
} from '../shared/strategyGovernanceV2.js'

const fixture = JSON.parse(fs.readFileSync(
  new URL(
    '../shared/fixtures/strategy-spec-v2-conformance.json',
    import.meta.url,
  ),
  'utf8',
))

test('StrategySpec v2 编译结果与跨运行时夹具指纹一致', () => {
  const valid = fixture.cases.find((item) => item.valid)
  const compiled = compileStrategySpecV2(valid.spec)

  assert.equal(compiled.schemaVersion, 'strategy-spec.v2')
  assert.equal(compiled.specVersion, valid.expectedSpecVersion)
  assert.equal(compiled.data.signalPrice, 'QFQ')
  assert.equal(compiled.data.executionPrice, 'RAW')
  assert.deepEqual(compiled.capacityAssumptions.capitalScenarios, [
    100000,
    500000,
    1000000,
    5000000,
  ])
  assert.deepEqual(compiled.capacityAssumptions.slippageScenariosBps, [
    5,
    10,
    20,
  ])
})

test('StrategySpec v2 拒绝错误价格流、容量和模型依赖', () => {
  const source = fixture.cases.find((item) => item.valid).spec

  assert.throws(
    () => compileStrategySpecV2({
      ...structuredClone(source),
      data: { ...source.data, executionPrice: 'QFQ' },
    }),
    /executionPrice/,
  )
  assert.throws(
    () => compileStrategySpecV2({
      ...structuredClone(source),
      liquidityLimits: {
        ...source.liquidityLimits,
        maximumParticipationRate: 0.5,
      },
    }),
    /maximumParticipationRate/,
  )
  assert.throws(
    () => compileStrategySpecV2({
      ...structuredClone(source),
      modelDependencies: [{
        id: 'lgb-score-36',
        type: 'MODEL',
        version: 'production',
        featureCount: 37,
        required: true,
      }],
    }),
    /36维/,
  )
  assert.throws(
    () => compileStrategySpecV2({
      ...structuredClone(source),
      untrustedRuntimeFlag: true,
    }),
    /顶层字段/,
  )
})

test('五类策略均有独立版本、状态适配和风险口径', () => {
  const catalog = getStrategyCatalogV2()

  assert.equal(catalog.schemaVersion, 'strategy-catalog.v2')
  assert.equal(catalog.strategies.length, 5)
  assert.deepEqual(
    new Set(catalog.strategies.map((item) => item.family)),
    new Set([
      'TREND_BREAKOUT',
      'CROSS_SECTIONAL_MOMENTUM',
      'RANGE_MEAN_REVERSION',
      'MULTI_FACTOR_RANKING',
      'DEFENSIVE_EXIT',
    ]),
  )
  assert.equal(
    new Set(catalog.strategies.map((item) => item.specVersion)).size,
    5,
  )
  assert.equal(
    catalog.strategies.find(
      (item) => item.family === 'RANGE_MEAN_REVERSION',
    ).signalTimeframe,
    '5m',
  )
  assert.ok(catalog.strategies.every(
    (item) => item.eligibleRegimes.length > 0
      && item.riskLimits
      && item.liquidityLimits
      && item.capacityAssumptions,
  ))
})

test('策略信号在规则通过但市场状态不适配时仍明确失败', () => {
  const strategy = getStrategyCatalogV2().strategies.find(
    (item) => item.family === 'TREND_BREAKOUT',
  )
  const context = {
    marketRegime: 'RANGE',
    technical: {
      donchianBreakout: true,
      maSlope20: 0.8,
    },
    volRatio: 1.8,
    quant: { score: 72 },
  }

  const rejected = evaluateStrategySignalV2(strategy, context)
  const passed = evaluateStrategySignalV2(strategy, {
    ...context,
    marketRegime: 'TREND_STRONG',
  })

  assert.equal(rejected.passed, false)
  assert.equal(rejected.regimeEligible, false)
  assert.equal(rejected.reason, 'REGIME_NOT_ELIGIBLE')
  assert.equal(passed.passed, true)
  assert.equal(passed.regimeEligible, true)
  assert.equal(passed.matchedRules.length, 4)
})

test('策略治理状态不允许跳过回测、影子和人工批准', () => {
  const governance = buildDefaultStrategyGovernance()
  const trend = governance.strategies.find(
    (item) => item.strategyId === 'trend-breakout',
  )
  const baseline = governance.strategies.find(
    (item) => item.strategyId === 'market-quant-resonance',
  )

  assert.equal(governance.schemaVersion, 'strategy-governance.v2')
  assert.equal(trend.state, 'draft')
  assert.equal(baseline.state, 'rejected')
  assert.throws(
    () => transitionStrategyState(trend, 'active'),
    /不允许从draft直接迁移到active/,
  )

  const backtested = transitionStrategyState(trend, 'backtested', {
    artifactHash: 'sha256:test',
  })
  const shadow = transitionStrategyState(backtested, 'shadow')
  assert.equal(shadow.state, 'shadow')
  assert.equal(shadow.artifactHash, 'sha256:test')
})
