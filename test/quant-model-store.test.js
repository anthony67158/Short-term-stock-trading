import test from 'node:test'
import assert from 'node:assert/strict'

import { syncControlSelection } from '../shared/modelVersion.js'

test('读取云端模型控制状态后同步本机实际调用版本', () => {
  const writes = []

  const selected = syncControlSelection(
    { selected: 'v2' },
    (key, value) => writes.push([key, value]),
  )

  assert.equal(selected, 'v2')
  assert.deepEqual(writes, [['quantModelVersion', 'v2']])
})

test('模型控制响应缺失时不覆盖本机版本', () => {
  const writes = []

  assert.equal(syncControlSelection(null, (...args) => writes.push(args)), null)
  assert.deepEqual(writes, [])
})
