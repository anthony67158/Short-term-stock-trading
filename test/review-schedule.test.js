import test from 'node:test'
import assert from 'node:assert/strict'

import {
  claimReviewCodes,
  completeReviewClaim,
  failReviewClaim,
  reviewRunKey,
} from '../shared/reviewSchedule.js'

const holdings = [
  { code: '600001', name: '主板一号' },
  { code: '600001', name: '重复持仓' },
  { code: '300001', name: '创业一号' },
  { code: '688001', name: '科创一号' },
]

test('同一日期场次按股票去重领取且未过期租约不能重复领取', () => {
  const data = { holding: holdings }
  const first = claimReviewCodes(data, {
    dayKey: '2026-08-13',
    session: 'noon',
    now: 1000,
    limit: 2,
    leaseMs: 60000,
  })
  const second = claimReviewCodes(data, {
    dayKey: '2026-08-13',
    session: 'noon',
    now: 2000,
    limit: 2,
    leaseMs: 60000,
  })

  assert.deepEqual(first.map((item) => item.code), ['600001', '300001'])
  assert.deepEqual(second.map((item) => item.code), ['688001'])
  assert.equal(data.reviewAuto.runs[reviewRunKey('2026-08-13', 'noon')].codes['600001'].attempts, 1)
})

test('成功完成后永久跳过，失败或过期租约允许有限重试', () => {
  const data = { holding: holdings.slice(0, 2) }
  const options = {
    dayKey: '2026-08-13',
    session: 'close',
    now: 1000,
    limit: 1,
    leaseMs: 100,
  }
  claimReviewCodes(data, options)
  failReviewClaim(data, {
    dayKey: options.dayKey,
    session: options.session,
    code: '600001',
    error: '模型超时',
    now: 1050,
  })
  const retry = claimReviewCodes(data, { ...options, now: 1100 })
  assert.equal(retry.length, 1)

  completeReviewClaim(data, {
    dayKey: options.dayKey,
    session: options.session,
    code: '600001',
    review: { code: '600001', at: 1200, result: { stance: '持有' } },
    now: 1200,
  })
  assert.equal(claimReviewCodes(data, { ...options, now: 5000 }).length, 0)
  assert.equal(data.reviews['600001'].session, 'close')
  assert.equal(data.reviews['600001'].dayKey, '2026-08-13')
})

test('午间完成不阻止同日收盘复盘', () => {
  const data = { holding: holdings.slice(0, 1) }
  claimReviewCodes(data, {
    dayKey: '2026-08-13',
    session: 'noon',
    now: 1000,
    limit: 1,
  })
  completeReviewClaim(data, {
    dayKey: '2026-08-13',
    session: 'noon',
    code: '600001',
    review: { code: '600001', at: 1100, result: {} },
    now: 1100,
  })

  const close = claimReviewCodes(data, {
    dayKey: '2026-08-13',
    session: 'close',
    now: 2000,
    limit: 1,
  })
  assert.deepEqual(close.map((item) => item.code), ['600001'])
})
