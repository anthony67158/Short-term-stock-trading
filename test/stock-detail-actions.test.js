import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceGenerationActions,
  adviceModeGuidance,
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

  const switchedStock = adviceGenerationActions({
    loading: true,
    deepMode: true,
    stateCode: '600000',
    currentCode: '000001',
  })
  assert.equal(switchedStock.quick.disabled, false)
  assert.equal(switchedStock.deep.disabled, false)
  assert.equal(switchedStock.deep.active, false)
})

test('首次生成推荐深度模式并固定展示决策分工', () => {
  assert.deepEqual(adviceModeGuidance({ hasAdvice: false }), {
    firstGeneration: true,
    deepBadge: '首次推荐',
    deepUseCase: '建仓·明显加仓·隔夜前',
    deepTitle: '首次生成、准备建仓、计划明显提高仓位或决定隔夜持有时，优先使用深度生成',
    items: [
      { key: 'deep', icon: 'brain', label: '深度生成', purpose: '定计划' },
      { key: 'quick', icon: 'spark', label: '快速生成', purpose: '看变化' },
      { key: 'judge', icon: 'bell', label: '盯盘 Judge', purpose: '定时机' },
      { key: 'discipline', icon: 'shield', label: '止损纪律', purpose: '始终优先' },
    ],
  })
})

test('已有有效建议后不再把深度生成标记为首次推荐', () => {
  const guidance = adviceModeGuidance({ hasAdvice: true })

  assert.equal(guidance.firstGeneration, false)
  assert.equal(guidance.deepBadge, '')
  assert.equal(guidance.deepUseCase, '建仓·明显加仓·隔夜前')
})
