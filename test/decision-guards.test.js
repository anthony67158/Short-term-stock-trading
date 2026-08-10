import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeSellAllowance,
  isConfirmationPhase,
  isMinuteSnapshotFresh,
  normalizeConfidence,
} from '../shared/decisionGuards.js'

test('今日无可卖仓位时拒绝卖出', () => {
  assert.deepEqual(computeSellAllowance(2, 0), {
    ok: false,
    requested: 2,
    allowed: 0,
    adjusted: false,
  })
})

test('卖出数量超过今日可卖仓位时收敛到可卖数量', () => {
  assert.deepEqual(computeSellAllowance(3, 2), {
    ok: true,
    requested: 3,
    allowed: 2,
    adjusted: true,
  })
})

test('置信度 0 不会被当成缺失值', () => {
  assert.equal(normalizeConfidence(0), 0)
  assert.equal(normalizeConfidence('75'), 75)
  assert.equal(normalizeConfidence('bad'), null)
  assert.equal(normalizeConfidence(120), 100)
})

test('确认闸门只在连续竞价时段工作', () => {
  assert.equal(isConfirmationPhase('早盘(盘中)'), true)
  assert.equal(isConfirmationPhase('午盘(盘中)'), true)
  assert.equal(isConfirmationPhase('集合竞价'), false)
  assert.equal(isConfirmationPhase('午间休市'), false)
  assert.equal(isConfirmationPhase('盘后(已收盘)'), false)
})

test('分时快照必须属于当日且不超过三分钟', () => {
  assert.equal(isMinuteSnapshotFresh('10:02', '2026-08-07 10:04'), true)
  assert.equal(isMinuteSnapshotFresh('2026-08-07 10:01', '2026-08-07 10:04'), true)
  assert.equal(isMinuteSnapshotFresh('10:00', '2026-08-07 10:04'), false)
  assert.equal(isMinuteSnapshotFresh('2026-08-06 14:59', '2026-08-07 10:00'), false)
  assert.equal(isMinuteSnapshotFresh('10:05', '2026-08-07 10:04'), false)
})
