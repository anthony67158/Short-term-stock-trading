import test from 'node:test'
import assert from 'node:assert/strict'

import {
  pearsonCorrelation,
  selectLowCorrelationBook,
  PORTFOLIO_CORRELATION_SELECTION_VERSION,
} from '../shared/portfolioCorrelationSelection.js'

test('pearsonCorrelation：完全同向=1，完全反向=-1，无波动=0', () => {
  assert.equal(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]), 1)
  assert.equal(pearsonCorrelation([1, 2, 3, 4], [8, 6, 4, 2]), -1)
  // 常数序列无波动 → 视为不相关。
  assert.equal(pearsonCorrelation([1, 1, 1, 1], [1, 2, 3, 4]), 0)
  // 长度不足 → 0。
  assert.equal(pearsonCorrelation([1, 2], [1, 2]), 0)
})

test('高相关候选被剔除，低相关候选纳入', () => {
  const base = [0.01, -0.02, 0.03, -0.01, 0.02, 0.0]
  const nearlySame = base.map((v) => v * 1.01 + 0.0001)
  const opposite = base.map((v) => -v) // |corr|=1 也算高相关
  const independent = [-0.01, 0.025, 0.005, -0.03, 0.01, 0.02]
  const candidates = [
    { key: 'A', returns: base },
    { key: 'B', returns: nearlySame }, // 与A高相关 → 剔除
    { key: 'C', returns: opposite }, // 与A反向高相关 → 剔除（用绝对值）
    { key: 'D', returns: independent }, // 低相关 → 纳入
  ]
  const out = selectLowCorrelationBook(candidates, [], {
    maxCorrelation: 0.7,
    maxHoldings: 10,
  })
  assert.equal(out.schemaVersion, PORTFOLIO_CORRELATION_SELECTION_VERSION)
  const keys = out.accepted.map((c) => c.key)
  assert.ok(keys.includes('A'))
  assert.ok(!keys.includes('B'))
  assert.ok(!keys.includes('C'))
  assert.ok(keys.includes('D'))
  const highCorr = out.skipped.filter((s) => s.reason === 'HIGH_CORRELATION')
  assert.equal(highCorr.length, 2)
})

test('已在场持仓参与相关性判定但不占新增容量', () => {
  const held = [{ key: 'H', returns: [0.01, -0.02, 0.03, -0.01, 0.02, 0.0] }]
  const sameAsHeld = held[0].returns.map((v) => v * 1.0 + 0.00001)
  const independent = [0.05, -0.04, 0.01, 0.02, -0.03, 0.01]
  const out = selectLowCorrelationBook(
    [
      { key: 'X', returns: sameAsHeld }, // 与在场H高相关 → 剔除
      { key: 'Y', returns: independent }, // 低相关 → 纳入
    ],
    held,
    { maxCorrelation: 0.7, roomForNew: 5, maxHoldings: 10 },
  )
  const keys = out.accepted.map((c) => c.key)
  assert.ok(!keys.includes('X'))
  assert.ok(keys.includes('Y'))
})

test('roomForNew 限制单轮新增，maxHoldings 限制总持仓', () => {
  const mk = (k, seed) => ({
    key: k,
    // 互不相关的随机序列，确保只被容量约束拦截而非相关性。
    returns: Array.from({ length: 8 }, (_, i) =>
      Math.sin(seed * 7.13 + i * 2.7) * 0.03,
    ),
  })
  const candidates = [mk('a', 1), mk('b', 2), mk('c', 3), mk('d', 4)]
  const roomLimited = selectLowCorrelationBook(candidates, [], {
    maxCorrelation: 0.95,
    roomForNew: 2,
    maxHoldings: 10,
  })
  assert.equal(roomLimited.acceptedCount, 2)
  assert.ok(
    roomLimited.skipped.some((s) => s.reason === 'NEW_CAPACITY_FULL'),
  )

  const bookLimited = selectLowCorrelationBook(
    candidates,
    [mk('h1', 9), mk('h2', 10)],
    { maxCorrelation: 0.95, roomForNew: 10, maxHoldings: 3 },
  )
  // 已在场2 + 只能再加1 = 3。
  assert.equal(bookLimited.acceptedCount, 1)
  assert.ok(bookLimited.skipped.some((s) => s.reason === 'BOOK_FULL'))
})
