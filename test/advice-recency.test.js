import test from 'node:test'
import assert from 'node:assert/strict'

import { adviceRecency } from '../shared/adviceRecency.js'

const now = new Date(2026, 7, 16, 15, 0).getTime()

test('最近一小时的建议用相对时间突出新鲜度', () => {
  assert.deepEqual(
    adviceRecency(new Date(2026, 7, 16, 14, 58).getTime(), now),
    { label: '刚刚', tone: 'fresh' },
  )
  assert.deepEqual(
    adviceRecency(new Date(2026, 7, 16, 14, 35).getTime(), now),
    { label: '25分钟前', tone: 'fresh' },
  )
})

test('当天、昨天和更早的建议给出清晰时间层级', () => {
  assert.deepEqual(
    adviceRecency(new Date(2026, 7, 16, 9, 0).getTime(), now),
    { label: '今天 09:00', tone: 'today' },
  )
  assert.deepEqual(
    adviceRecency(new Date(2026, 7, 15, 14, 30).getTime(), now),
    { label: '昨天 14:30', tone: 'older' },
  )
  assert.deepEqual(
    adviceRecency(new Date(2026, 7, 12, 10, 0).getTime(), now),
    { label: '08-12 10:00', tone: 'older' },
  )
})

test('非法生成时间不渲染状态', () => {
  assert.equal(adviceRecency(null, now), null)
  assert.equal(adviceRecency('bad', now), null)
})
