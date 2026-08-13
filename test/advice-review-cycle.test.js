import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceReviewDue,
  nextAdviceReviewAt,
} from '../shared/adviceReviewPolicy.js'
import { buildAdviceCacheEntry } from '../shared/adviceContinuity.js'

test('持仓建议在交易时段按15分钟安排下一次自动复核', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()

  assert.equal(
    nextAdviceReviewAt({ now, mode: 'hold_advice', intervalMin: 15 }),
    new Date('2026-08-10T02:15:00Z').getTime(),
  )
})

test('午间到期的复核顺延到下午开盘', () => {
  const now = new Date('2026-08-10T03:25:00Z').getTime()

  assert.equal(
    nextAdviceReviewAt({ now, mode: 'hold_advice', intervalMin: 15 }),
    new Date('2026-08-10T05:00:00Z').getTime(),
  )
})

test('收盘后到期的复核顺延到下一交易日开盘', () => {
  const now = new Date('2026-08-14T06:55:00Z').getTime()

  assert.equal(
    nextAdviceReviewAt({ now, mode: 'hold_advice', intervalMin: 15 }),
    new Date('2026-08-17T01:30:00Z').getTime(),
  )
})

test('建议缓存记录连续复核责任链', () => {
  const firstAt = new Date('2026-08-10T02:00:00Z').getTime()
  const first = buildAdviceCacheEntry(null, {
    mode: 'hold_advice',
    advice: {
      action: '持有',
      continuity: { changeType: 'initial' },
    },
  }, firstAt)
  const secondAt = new Date('2026-08-10T02:15:00Z').getTime()
  const second = buildAdviceCacheEntry(first, {
    mode: 'hold_advice',
    advice: {
      action: '减仓',
      continuity: { changeType: 'reverse' },
    },
  }, secondAt)

  assert.equal(first.advice.reviewCycle.sequence, 1)
  assert.equal(first.advice.reviewCycle.reviewedAt, firstAt)
  assert.equal(first.advice.reviewCycle.nextReviewAt, firstAt + 15 * 60000)
  assert.equal(second.advice.reviewCycle.sequence, 2)
  assert.equal(second.advice.reviewCycle.previousAction, '持有')
  assert.equal(second.advice.reviewCycle.changeType, 'reverse')
  assert.equal(adviceReviewDue(second, second.advice.reviewCycle.nextReviewAt - 1), false)
  assert.equal(adviceReviewDue(second, second.advice.reviewCycle.nextReviewAt), true)
})

test('军师正文暂缺时也安排下次重试，避免每5分钟重复调用', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const entry = buildAdviceCacheEntry(null, {
    mode: 'buy_advice',
    result: { score: 61 },
    advice: null,
  }, now)

  assert.equal(entry.reviewCycle.changeType, 'unavailable')
  assert.equal(entry.reviewCycle.nextReviewAt, now + 30 * 60000)
  assert.equal(adviceReviewDue(entry, now + 5 * 60000), false)
})
