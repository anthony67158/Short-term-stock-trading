import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EXIT_ACTIONS,
  EXIT_ACTION_VALUE_VERSION,
  computeExitActionValues,
} from '../shared/exitActionValue.js'

function bar(date, o, h, l, c) {
  return { date, open: o, high: h, low: l, close: c, preClose: o }
}

test('非法输入返回不可用且不臆造数值', () => {
  assert.equal(computeExitActionValues({}).available, false)
  assert.equal(
    computeExitActionValues({
      entryPrice: 10, stopPrice: 11, shares: 100, holdingRows: [bar('d', 10, 10, 10, 10)],
    }).available,
    false, // stop 高于 entry 非法
  )
  assert.equal(
    computeExitActionValues({
      entryPrice: 10, stopPrice: 9, shares: 100, holdingRows: [],
    }).available,
    false, // 无持有期
  )
})

test('三种退出动作都产出净R', () => {
  const out = computeExitActionValues({
    entryPrice: 10,
    stopPrice: 9,
    shares: 1000,
    holdingRows: [
      bar('d1', 10.2, 10.5, 10.1, 10.4),
      bar('d2', 10.4, 11.2, 10.3, 11.0),
      bar('d3', 11.0, 11.5, 10.8, 11.3),
    ],
    slippageBps: 5,
  })
  assert.equal(out.available, true)
  assert.equal(out.schemaVersion, EXIT_ACTION_VALUE_VERSION)
  for (const action of EXIT_ACTIONS) {
    assert.ok(action in out.actions)
    assert.equal(typeof out.actions[action].netR, 'number')
  }
  assert.ok(EXIT_ACTIONS.includes(out.bestAction))
})

test('跌破止损当日标记硬止损，供训练排除', () => {
  const out = computeExitActionValues({
    entryPrice: 10,
    stopPrice: 9.5,
    shares: 1000,
    holdingRows: [
      bar('d1', 10.0, 10.1, 9.9, 10.0),
      bar('d2', 9.8, 9.9, 9.2, 9.3),  // 跌破止损
      bar('d3', 9.3, 9.4, 9.0, 9.1),
    ],
  })
  assert.equal(out.hardStopHit, true)
  assert.equal(out.actions.HOLD_TO_HORIZON.hardStopHit, true)
  // 硬止损净R应接近 -1R（含费略差）。
  assert.ok(out.actions.HOLD_TO_HORIZON.netR <= -0.9)
})

test('部分减仓在首次+1R锁盈后余仓持有', () => {
  const out = computeExitActionValues({
    entryPrice: 10,
    stopPrice: 9,        // 1R = 1元, +1R 目标=11
    shares: 1000,
    holdingRows: [
      bar('d1', 10.2, 11.2, 10.1, 10.5), // 触及11 → 减半仓
      bar('d2', 10.5, 10.8, 10.4, 10.6),
      bar('d3', 10.6, 10.9, 10.5, 10.7),
    ],
  })
  const partial = out.actions.PARTIAL_REDUCE
  assert.equal(partial.hardStopHit, false)
  assert.equal(typeof partial.netR, 'number')
  // 部分减仓锁定了+1R一半，净R应为正。
  assert.ok(partial.netR > 0)
})

test('全退出走吊灯跟踪止盈：冲高后回落触发', () => {
  const out = computeExitActionValues({
    entryPrice: 10,
    stopPrice: 9,        // giveBackR=1R=1元
    shares: 1000,
    holdingRows: [
      bar('d1', 10.5, 13.0, 10.4, 12.8), // 峰值13，跟踪线=13-1=12
      bar('d2', 12.5, 12.6, 11.8, 11.9), // 低11.8<12 触发跟踪止盈
      bar('d3', 11.9, 12.0, 11.5, 11.6),
    ],
  })
  const full = out.actions.FULL_EXIT
  assert.equal(full.hardStopHit, false)
  // 在约12附近止盈，净R应显著为正(约+2R区间)。
  assert.ok(full.netR > 1)
})
