import test from 'node:test'
import assert from 'node:assert/strict'

import { isChunkLoadError, shouldReloadChunk } from '../src/chunkError.js'

test('识别部署后旧页面加载失效分包的错误', () => {
  assert.equal(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/AccountHub-old.js')), true)
  assert.equal(isChunkLoadError(new Error('ChunkLoadError: Loading chunk 12 failed')), true)
  assert.equal(isChunkLoadError(new Error('普通组件渲染失败')), false)
})

test('失效分包只自动刷新一次，避免循环刷新', () => {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  }
  const error = new TypeError('Failed to fetch dynamically imported module')

  assert.equal(shouldReloadChunk(error, 'account-hub', storage), true)
  assert.equal(shouldReloadChunk(error, 'account-hub', storage), false)
  assert.equal(shouldReloadChunk(new Error('普通错误'), 'other', storage), false)
})
