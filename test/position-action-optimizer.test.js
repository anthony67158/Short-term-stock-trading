import test from 'node:test'
import assert from 'node:assert/strict'

import {
  optimizePositionActions,
} from '../shared/positionActionOptimizer.js'

function input(overrides = {}) {
  return {
    expectedHoldR: 0.8,
    lowerBoundR: -0.2,
    price: 50,
    hardStopPrice: 45,
    totalLots: 4,
    sellableLots: 4,
    stockWeightPct: 15,
    maxStockWeightPct: 30,
    ...overrides,
  }
}

test('上涨价值充足且尾部风险较小时继续持有胜出', () => {
  const result = optimizePositionActions(input())

  assert.equal(result.schemaVersion, 'position-optimization.v2')
  assert.equal(result.state, 'READY')
  assert.equal(result.selectedAction, 'HOLD')
  assert.equal(result.selectedSellLots, 0)
  assert.ok(result.selectedUtilityR > 0.68)
})

test('仍有上涨价值但尾部风险偏大时部分减仓可以独立胜出', () => {
  const result = optimizePositionActions(input({
    expectedHoldR: 0.4,
    lowerBoundR: -1.2,
  }))

  assert.equal(result.selectedAction, 'REDUCE')
  assert.equal(result.selectedSellLots, 3)
  assert.equal(result.selectedRetainedLots, 1)
  assert.ok(result.improvementOverHoldR > 0.2)
  assert.ok(result.selectedUtilityR > result.holdUtilityR)
  assert.notEqual(
    result.actions.EXIT.actionUtilityR,
    2 * result.actions.REDUCE.actionUtilityR,
  )
})

test('持有期望为负时退出可以胜出但必须扣除真实卖出成本', () => {
  const result = optimizePositionActions(input({
    expectedHoldR: -0.4,
    lowerBoundR: -1,
  }))

  assert.equal(result.selectedAction, 'EXIT')
  assert.equal(result.selectedSellLots, 4)
  assert.ok(result.actions.EXIT.sellCostR > 0)
  assert.ok(result.actions.EXIT.feeAmount >= 5)
  assert.ok(result.actions.EXIT.slippageAmount > 0)
  assert.ok(result.actions.EXIT.actionUtilityR < 0)
})

test('T+1只允许在可卖手数内减仓且不能伪造全部退出', () => {
  const result = optimizePositionActions(input({
    expectedHoldR: 0.4,
    lowerBoundR: -1.2,
    sellableLots: 2,
  }))

  assert.equal(result.selectedAction, 'REDUCE')
  assert.equal(result.selectedSellLots, 2)
  assert.equal(result.actions.EXIT, null)
  assert.ok(result.candidates.every(
    (candidate) => candidate.sellLots <= 2,
  ))
})

test('一手持仓只比较持有和退出，不生成非法部分减仓', () => {
  const result = optimizePositionActions(input({
    expectedHoldR: 0.4,
    lowerBoundR: -1.2,
    totalLots: 1,
    sellableLots: 1,
    stockWeightPct: 5,
  }))

  assert.equal(result.actions.REDUCE, null)
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.action),
    ['HOLD', 'EXIT'],
  )
})

test('非持有动作改善不足0.05R时保持持有避免频繁换手', () => {
  const result = optimizePositionActions(input({
    expectedHoldR: 0.3,
    lowerBoundR: -0.8,
    totalLots: 2,
    sellableLots: 2,
    stockWeightPct: 2,
  }))

  assert.equal(result.selectedAction, 'HOLD')
  assert.equal(result.selectedSellLots, 0)
  assert.ok(
    Math.max(...result.candidates.map(
      (candidate) => candidate.actionUtilityR,
    )) > result.holdUtilityR,
  )
})

test('所有整手与T+1组合都不产生负手数或超卖', () => {
  for (let totalLots = 1; totalLots <= 20; totalLots += 1) {
    for (
      let sellableLots = 0;
      sellableLots <= totalLots;
      sellableLots += 1
    ) {
      const result = optimizePositionActions(input({
        totalLots,
        sellableLots,
      }))
      assert.equal(result.state, 'READY')
      assert.ok(result.selectedSellLots >= 0)
      assert.ok(result.selectedSellLots <= sellableLots)
      assert.equal(
        result.selectedSellLots + result.selectedRetainedLots,
        totalLots,
      )
      assert.ok(result.candidates.every((candidate) => (
        Number.isInteger(candidate.sellLots)
        && candidate.sellLots >= 0
        && candidate.sellLots <= sellableLots
        && candidate.sellLots + candidate.retainedLots === totalLots
      )))
    }
  }
})

test('缺少止损或账户集中度时失败关闭而不是回退拍脑袋参数', () => {
  const missingStop = optimizePositionActions(input({
    hardStopPrice: null,
  }))
  const missingWeight = optimizePositionActions(input({
    stockWeightPct: null,
  }))

  assert.equal(missingStop.state, 'NOT_READY')
  assert.match(missingStop.reason, /hardStopPrice/)
  assert.equal(missingWeight.state, 'NOT_READY')
  assert.match(missingWeight.reason, /stockWeightPct/)
})
