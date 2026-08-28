import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dailyEmotionSnapshot,
  emotionScore,
  emotionRegime,
  momentumAllowedByEmotion,
  buildEmotionSeries,
} from '../shared/backtest/marketEmotion.js'

function limitRow(type, height) {
  return { limitType: type, limitTimes: height }
}

test('dailyEmotionSnapshot 统计涨停/炸板/连板高度与炸板率', () => {
  const rows = [
    limitRow('U', 1), limitRow('U', 1), limitRow('U', 3), limitRow('U', 5),
    limitRow('Z', null), limitRow('Z', null),
    limitRow('D', null),
  ]
  const snap = dailyEmotionSnapshot(rows)
  assert.equal(snap.upCount, 4)
  assert.equal(snap.bustCount, 2)
  assert.equal(snap.downCount, 1)
  assert.equal(snap.maxHeight, 5)
  assert.equal(snap.connBoards, 2) // height>=2 的有 3板和5板
  assert.equal(snap.bustRate, +(2 / 6).toFixed(3))
})

test('强情绪(涨停多、连板高、炸板低)得高分，弱情绪得低分', () => {
  const strong = emotionScore({ upCount: 90, downCount: 0, maxHeight: 7, connBoards: 18, bustRate: 0.15 })
  const weak = emotionScore({ upCount: 20, downCount: 15, maxHeight: 2, connBoards: 2, bustRate: 0.55 })
  assert.ok(strong > 70, `强情绪应>70，实际${strong}`)
  assert.ok(weak < 40, `弱情绪应<40，实际${weak}`)
})

test('相位划分：高潮/冰点/退潮', () => {
  assert.equal(emotionRegime(80), 'CLIMAX')
  assert.equal(emotionRegime(30), 'FREEZE')
  // 高位快速回落=退潮
  assert.equal(emotionRegime(74, 90), 'EBB')
})

test('momentumAllowedByEmotion：冰点/退潮禁止打板', () => {
  assert.equal(momentumAllowedByEmotion('FREEZE'), false)
  assert.equal(momentumAllowedByEmotion('EBB'), false)
  assert.equal(momentumAllowedByEmotion('CLIMAX'), true)
  assert.equal(momentumAllowedByEmotion('RECOVERY_OR_NORMAL'), true)
})

test('buildEmotionSeries 输出按日期的情绪时间序列与择时开关', () => {
  const limitByDate = {
    '20260110': [limitRow('U', 1), limitRow('U', 5), limitRow('U', 3), ...Array(80).fill(limitRow('U', 1))],
    '20260111': [limitRow('U', 1), limitRow('D', null), limitRow('Z', null), limitRow('Z', null)],
  }
  const series = buildEmotionSeries(limitByDate)
  assert.ok(series['20260110'].score > series['20260111'].score)
  assert.equal(typeof series['20260110'].momentumAllowed, 'boolean')
})
