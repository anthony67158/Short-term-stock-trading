import test from 'node:test'
import assert from 'node:assert/strict'

import { walkForwardFolds, tradeInWindow } from '../backtest/walkForward.js'

function makeDates(n) {
  // 生成 n 个连续伪交易日（不含真实日历，仅用于切窗逻辑测试）
  const out = []
  let y = 2024
  let m = 1
  let d = 1
  for (let i = 0; i < n; i += 1) {
    out.push(`${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`)
    d += 1
    if (d > 28) { d = 1; m += 1; if (m > 12) { m = 1; y += 1 } }
  }
  return out
}

test('样本不足一个fold时返回空', () => {
  const folds = walkForwardFolds(makeDates(100), { trainDays: 250, testDays: 60 })
  assert.equal(folds.length, 0)
})

test('滚动切出非重叠样本外窗', () => {
  const dates = makeDates(500)
  const folds = walkForwardFolds(dates, { trainDays: 250, testDays: 60 })
  assert.ok(folds.length >= 2)
  // 第一个 fold 的样本外紧接训练窗之后
  assert.ok(folds[0].trainEnd < folds[0].testStart)
  // 相邻 fold 的样本外窗不重叠（后一个 testStart > 前一个 testEnd）
  assert.ok(folds[1].testStart > folds[0].testEnd)
})

test('tradeInWindow 按入场日归属样本外窗', () => {
  assert.equal(
    tradeInWindow({ entryDate: '20240515' }, '20240501', '20240531'),
    true,
  )
  assert.equal(
    tradeInWindow({ entryDate: '20240615' }, '20240501', '20240531'),
    false,
  )
})
