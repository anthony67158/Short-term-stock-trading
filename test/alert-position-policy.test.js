import test from 'node:test'
import assert from 'node:assert/strict'

import {
  positionGateForAlert,
  retirePositionAlert,
} from '../shared/alertPositionPolicy.js'

test('未持仓时加仓、减仓、止盈和止损预警全部失效', () => {
  const alerts = [
    { actKind: 'add', note: '补仓点' },
    { actKind: 'reduce', note: '减仓点' },
    { note: '止盈' },
    { note: '止损' },
  ]

  for (const alert of alerts) {
    const gate = positionGateForAlert(alert, { liveQty: 0 })
    assert.equal(gate.allowed, false)
    assert.equal(gate.policy, 'position-missing')
  }
})

test('自选股买点无需持仓即可继续监控', () => {
  const gate = positionGateForAlert(
    { candCode: '600519', note: '买点' },
    { liveQty: 0 },
  )

  assert.equal(gate.allowed, true)
})

test('已建仓后遗留的自选买点预警自动失效', () => {
  const gate = positionGateForAlert(
    { candCode: '600519', note: '买点' },
    { liveQty: 1, holdingIds: new Set(['holding-1']) },
  )

  assert.equal(gate.allowed, false)
  assert.equal(gate.policy, 'candidate-already-held')
})

test('异常预警同时标记自选和加仓时按更严格的加仓资格处理', () => {
  const gate = positionGateForAlert(
    { candCode: '600519', actCode: '600519', actKind: 'add', note: '补仓点' },
    { liveQty: 0 },
  )

  assert.equal(gate.allowed, false)
  assert.equal(gate.policy, 'position-missing')
})

test('持仓计划必须匹配仍存在的持仓ID', () => {
  const missing = positionGateForAlert(
    { planId: 'holding-old', note: '止损' },
    { liveQty: 2, holdingIds: new Set(['holding-new']) },
  )
  const current = positionGateForAlert(
    { planId: 'holding-new', note: '止损' },
    { liveQty: 2, holdingIds: new Set(['holding-new']) },
  )

  assert.equal(missing.allowed, false)
  assert.equal(missing.policy, 'holding-plan-missing')
  assert.equal(current.allowed, true)
})

test('陈旧持仓预警静默退役且不伪造已推送时间', () => {
  const alert = {
    id: 'a1',
    enabled: true,
    phase: 'watching',
    watchingAt: 100,
    watchingPrice: 10,
  }
  const gate = positionGateForAlert(
    { ...alert, actKind: 'add' },
    { liveQty: 0 },
  )
  const retired = retirePositionAlert(alert, gate, 200)

  assert.equal(retired.enabled, false)
  assert.equal(retired.phase, 'invalid')
  assert.equal(retired.retiredAt, 200)
  assert.equal(retired.retiredPolicy, 'position-missing')
  assert.equal(retired.triggeredAt, undefined)
  assert.equal(retired.watchingAt, null)
})
