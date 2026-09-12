import test from 'node:test'
import assert from 'node:assert/strict'

import {
  executionProgressLabel,
  expectationCaption,
  reviewTerminology,
} from '../shared/reviewPresentation.js'

test('模拟账户与实盘账户使用不同执行术语', () => {
  assert.equal(
    reviewTerminology(true).executionLabel,
    '模拟执行',
  )
  assert.match(
    reviewTerminology(true).selectionDescription,
    /模拟账本/,
  )
  assert.doesNotMatch(
    reviewTerminology(true).selectionDescription,
    /真实/,
  )
  assert.equal(
    reviewTerminology(false).executionLabel,
    '真实执行',
  )
})

test('每笔期望标签与数值正负一致', () => {
  assert.equal(expectationCaption(8), '每笔平均盈利')
  assert.equal(expectationCaption(-8), '每笔平均亏损')
  assert.equal(expectationCaption(0), '每笔平均持平')
  assert.equal(expectationCaption(null), '每笔平均结果')
})

test('执行进度明确区分已成交和原计划手数', () => {
  assert.equal(executionProgressLabel({
    status: 'COMPLETED',
    filledLots: 2,
    remainingLots: 0,
    targetLots: 2,
  }), '已成交 2/2手')
  assert.equal(executionProgressLabel({
    status: 'PARTIALLY_RECORDED',
    filledLots: 2,
    remainingLots: 1,
    targetLots: 3,
  }), '已成交 2/3手')
  assert.equal(executionProgressLabel({
    status: 'EXPIRED',
    filledLots: 0,
    remainingLots: 2,
    targetLots: 2,
  }), '未成交 · 原计划2手')
})
