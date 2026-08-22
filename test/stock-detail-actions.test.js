import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceGenerationActions,
  stockWatchAction,
} from '../shared/stockDetailActions.js'

test('详情页自选按钮明确区分加入、取消与持仓状态', () => {
  assert.deepEqual(stockWatchAction({
    inWatchlist: false,
    isHeld: false,
  }), {
    label: '加入自选',
    icon: 'star',
    disabled: false,
    active: false,
  })
  assert.equal(stockWatchAction({
    inWatchlist: true,
    isHeld: false,
  }).label, '取消自选')
  assert.deepEqual(stockWatchAction({
    inWatchlist: false,
    isHeld: true,
  }), {
    label: '持仓中',
    icon: 'check',
    disabled: true,
    active: true,
  })
})

test('底栏明确区分快速生成与深度生成且只标记当前模式', () => {
  const idle = adviceGenerationActions({
    loading: false,
  })
  assert.deepEqual(idle.quick, {
    label: '快速生成',
    icon: 'spark',
    disabled: false,
    active: false,
  })
  assert.deepEqual(idle.deep, {
    label: '深度生成',
    icon: 'brain',
    disabled: false,
    active: false,
  })

  const quickRunning = adviceGenerationActions({
    loading: true,
    deepMode: false,
  })
  assert.equal(quickRunning.quick.label, '快速生成中')
  assert.equal(quickRunning.quick.active, true)
  assert.equal(quickRunning.deep.label, '深度生成')
  assert.equal(quickRunning.deep.active, false)
  assert.equal(quickRunning.quick.disabled, true)
  assert.equal(quickRunning.deep.disabled, true)

  const deepRunning = adviceGenerationActions({
    loading: true,
    deepMode: true,
  })
  assert.equal(deepRunning.quick.label, '快速生成')
  assert.equal(deepRunning.quick.active, false)
  assert.equal(deepRunning.deep.label, '深度生成中')
  assert.equal(deepRunning.deep.active, true)
})
