import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceGenerationAction,
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

test('底栏主按钮始终表达军师生成操作建议而不是AI助手', () => {
  assert.equal(adviceGenerationAction({
    loading: false,
    hasAdvice: false,
  }).label, '军师生成 AI 操作建议')
  assert.equal(adviceGenerationAction({
    loading: true,
    hasAdvice: false,
  }).label, '军师生成中…')
  assert.equal(adviceGenerationAction({
    loading: false,
    hasAdvice: true,
  }).label, '重新生成军师 AI 操作建议')
})
