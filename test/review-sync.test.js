import test from 'node:test'
import assert from 'node:assert/strict'

import { planStore } from '../src/planStore.js'

test('跨设备增量同步按时间戳合并云端自动复盘', () => {
  planStore.setData({
    plan: [],
    holding: [],
    closed: [],
    reviews: {
      '600001': {
        code: '600001',
        session: 'noon',
        dayKey: '2026-08-13',
        at: 300,
      },
    },
  })

  const changed = planStore.mergeCloud({
    reviews: {
      '600001': {
        code: '600001',
        session: 'close',
        dayKey: '2026-08-13',
        at: 500,
      },
      '300001': {
        code: '300001',
        session: 'close',
        dayKey: '2026-08-13',
        at: 450,
      },
    },
  })

  assert.equal(changed, true)
  assert.equal(planStore.get().reviews['600001'].session, 'close')
  assert.equal(planStore.get().reviews['300001'].at, 450)
})

test('较旧的云端复盘不能覆盖本机较新结果', () => {
  planStore.setData({
    plan: [],
    holding: [],
    closed: [],
    reviews: {
      '600001': {
        code: '600001',
        session: 'manual',
        dayKey: '2026-08-13',
        at: 600,
      },
    },
  })

  const changed = planStore.mergeCloud({
    reviews: {
      '600001': {
        code: '600001',
        session: 'close',
        dayKey: '2026-08-13',
        at: 500,
      },
    },
  })

  assert.equal(changed, false)
  assert.equal(planStore.get().reviews['600001'].session, 'manual')
})
