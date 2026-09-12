import test from 'node:test'
import assert from 'node:assert/strict'

import { adviceRecency } from '../shared/adviceRecency.js'

const now = Date.parse('2026-08-16T07:00:00.000Z')

test('最近一小时的建议用相对时间突出新鲜度', () => {
  assert.deepEqual(
    adviceRecency(Date.parse('2026-08-16T06:58:00.000Z'), now),
    { label: '刚刚', tone: 'fresh' },
  )
  assert.deepEqual(
    adviceRecency(Date.parse('2026-08-16T06:35:00.000Z'), now),
    { label: '25分钟前', tone: 'fresh' },
  )
})

test('当天、昨天和更早的建议给出清晰时间层级', () => {
  assert.deepEqual(
    adviceRecency(Date.parse('2026-08-16T01:00:00.000Z'), now),
    { label: '今天 09:00', tone: 'today' },
  )
  assert.deepEqual(
    adviceRecency(Date.parse('2026-08-15T06:30:00.000Z'), now),
    { label: '昨天 14:30', tone: 'older' },
  )
  assert.deepEqual(
    adviceRecency(Date.parse('2026-08-12T02:00:00.000Z'), now),
    { label: '08-12 10:00', tone: 'older' },
  )
})

test('非法生成时间不渲染状态', () => {
  assert.equal(adviceRecency(null, now), null)
  assert.equal(adviceRecency('bad', now), null)
})
