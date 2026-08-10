import test from 'node:test'
import assert from 'node:assert/strict'

import { applyT1ToAlert, t1GateForSide } from '../shared/t1AdvicePolicy.js'

test('今日全部为新仓时卖出和止损提醒被 T+1 阻断', () => {
  const status = { liveQty: 1, boughtToday: 1, sellableToday: 0 }

  assert.equal(t1GateForSide('sell', status).blocked, true)
  assert.equal(t1GateForSide('stop', status).blocked, true)
  assert.equal(t1GateForSide('buy', status).blocked, false)
})

test('原有2手今日补1手时卖出提醒最多保留2手', () => {
  const alert = {
    code: '000636',
    actKind: 'reduce',
    opQty: '减仓3手',
  }
  const projected = applyT1ToAlert(alert, {
    liveQty: 3,
    boughtToday: 1,
    sellableToday: 2,
  })

  assert.equal(projected.t1Blocked, false)
  assert.equal(projected.sellableTodayQty, 2)
  assert.equal(projected.opQty, '减仓2手')
})
