import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BATCH_COMPLETION_VISIBLE_MS,
  batchProgressVisibility,
} from '../shared/batchProgressVisibility.js'

test('运行中的V3批量进度始终显示', () => {
  assert.deepEqual(batchProgressVisibility({
    running: true,
    total: 6,
    finishedAt: 0,
  }, 10_000), {
    visible: true,
    hideAfterMs: null,
  })
})

test('V3批量完成态只保留八秒后自动隐藏', () => {
  assert.equal(BATCH_COMPLETION_VISIBLE_MS, 8000)
  assert.deepEqual(batchProgressVisibility({
    running: false,
    total: 6,
    finishedAt: 10_000,
  }, 17_999), {
    visible: true,
    hideAfterMs: 1,
  })
  assert.deepEqual(batchProgressVisibility({
    running: false,
    total: 6,
    finishedAt: 10_000,
  }, 18_000), {
    visible: false,
    hideAfterMs: null,
  })
})

test('刷新后读到旧完成批次时不重新展示', () => {
  assert.deepEqual(batchProgressVisibility({
    running: false,
    total: 1,
    finishedAt: 10_000,
    at: 30_000,
  }, 30_000), {
    visible: false,
    hideAfterMs: null,
  })
})
