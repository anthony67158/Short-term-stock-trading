import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createAdviceRuntimeSyncCursor,
} from '../shared/adviceAccountSync.js'

test('本机账号保存成功不能推进后台建议读取游标', () => {
  const cursor = createAdviceRuntimeSyncCursor(1000)

  cursor.noteSave(3000)

  assert.equal(cursor.since(), 1000)
})

test('全量快照和成功增量拉取才推进后台建议读取游标', () => {
  const cursor = createAdviceRuntimeSyncCursor()

  cursor.noteSnapshot(1000)
  assert.equal(cursor.since(), 1000)

  cursor.notePull(2500)
  assert.equal(cursor.since(), 2500)

  cursor.notePull(2000)
  assert.equal(cursor.since(), 2500)
})

test('切换账号后的全量快照会重置为新账号游标', () => {
  const cursor = createAdviceRuntimeSyncCursor(5000)

  cursor.noteSnapshot(1000)

  assert.equal(cursor.since(), 1000)
})
