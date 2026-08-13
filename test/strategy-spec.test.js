import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileStrategySpec,
  createDefaultStrategySpec,
  evaluateStrategySignal,
  strategySpecFingerprint,
} from '../shared/strategySpec.js'

test('默认策略规格完整声明数据、信号、评分、仓位、退出和成交假设', () => {
  const spec = createDefaultStrategySpec()
  const compiled = compileStrategySpec(spec)

  assert.equal(compiled.schemaVersion, 'strategy-spec.v1')
  assert.equal(compiled.data.signalAt, 'CLOSE')
  assert.equal(compiled.execution.entryAt, 'NEXT_OPEN')
  assert.equal(compiled.execution.tPlusOne, true)
  assert.equal(compiled.execution.rejectLimitUpBuy, true)
  assert.equal(compiled.execution.rejectLimitDownSell, true)
  assert.equal(compiled.position.lotSize, 100)
  assert.equal(compiled.universe.minimumListingDays, 20)
  assert.equal(compiled.score.bonuses.highConfidence, 5)
  assert.equal(compiled.marketRanking.filters.maxPct, 8.8)
  assert.equal(compiled.marketRanking.factorWeights.fund, 0.3)
  assert.equal(compiled.exit.maxHoldingDays > 0, true)
  assert.match(compiled.specVersion, /^strategy\./)
})

test('相同策略内容生成稳定版本且参数变化必然改变版本', () => {
  const first = createDefaultStrategySpec()
  const second = structuredClone(first)
  const changed = structuredClone(first)
  changed.exit.stopLossPct = 4

  assert.equal(strategySpecFingerprint(first), strategySpecFingerprint(second))
  assert.notEqual(strategySpecFingerprint(first), strategySpecFingerprint(changed))
})

test('ALL和ANY条件树对同一上下文给出确定性信号与命中证据', () => {
  const spec = createDefaultStrategySpec({
    entry: {
      type: 'ALL',
      conditions: [
        { field: 'marketScore', op: 'GTE', value: 60 },
        {
          type: 'ANY',
          conditions: [
            { field: 'quant.score', op: 'GTE', value: 70 },
            { field: 'quant.highConfFired', op: 'EQ', value: true },
          ],
        },
        { field: 'pct', op: 'BETWEEN', value: [-2, 7] },
      ],
    },
  })
  const passed = evaluateStrategySignal(spec, {
    marketScore: 65,
    pct: 3,
    quant: { score: 72, highConfFired: false },
  })
  const failed = evaluateStrategySignal(spec, {
    marketScore: 65,
    pct: 3,
    quant: { score: 55, highConfFired: false },
  })

  assert.equal(passed.passed, true)
  assert.equal(passed.matchedRules.length, 3)
  assert.equal(failed.passed, false)
  assert.ok(failed.failedRules.some((item) => item.field === 'quant.score'))
})

test('策略编译拒绝未知字段操作符和不完整风险参数', () => {
  assert.throws(
    () => compileStrategySpec(createDefaultStrategySpec({
      entry: { field: 'process.env.SECRET', op: 'EQ', value: true },
    })),
    /不支持的策略字段/,
  )
  assert.throws(
    () => compileStrategySpec(createDefaultStrategySpec({
      entry: { field: 'marketScore', op: 'EXEC', value: 1 },
    })),
    /不支持的条件操作符/,
  )
  assert.throws(
    () => compileStrategySpec(createDefaultStrategySpec({
      exit: { stopLossPct: 0, takeProfitPct: 5, maxHoldingDays: 5 },
    })),
    /stopLossPct/,
  )
  assert.throws(
    () => compileStrategySpec(createDefaultStrategySpec({
      score: {
        method: 'WEIGHTED_SUM',
        weights: { marketScore: 0.8, quantScore: 0.8 },
      },
    })),
    /评分权重之和必须为1/,
  )
  assert.throws(
    () => compileStrategySpec(createDefaultStrategySpec({
      position: {
        allocationPct: 30,
        maxPositions: 5,
      },
    })),
    /仓位预算不能超过100%/,
  )
  assert.throws(
    () => compileStrategySpec(createDefaultStrategySpec({
      entry: { field: 'marketScore', op: 'GTE', value: 'unknown' },
    })),
    /比较阈值必须为有限数/,
  )
  assert.throws(
    () => compileStrategySpec(createDefaultStrategySpec({
      execution: { feePolicy: 'UNKNOWN' },
    })),
    /feePolicy/,
  )
  assert.throws(
    () => compileStrategySpec(createDefaultStrategySpec({
      marketRanking: {
        factorWeights: {
          fund: 1,
          volume: 1,
        },
      },
    })),
    /市场因子权重之和必须为1/,
  )
})

test('条件缺失值明确失败而不是按零值参与判断', () => {
  const spec = createDefaultStrategySpec({
    entry: { field: 'quant.score', op: 'GTE', value: 0 },
  })
  const result = evaluateStrategySignal(spec, { quant: {} })

  assert.equal(result.passed, false)
  assert.equal(result.failedRules[0].reason, 'MISSING_VALUE')
})
