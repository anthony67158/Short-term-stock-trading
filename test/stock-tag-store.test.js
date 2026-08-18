import test from 'node:test'
import assert from 'node:assert/strict'

import { createStockTagStore } from '../src/stockTagStore.js'

test('多个股票名称挂载时合并去重为一次批量题材请求', async () => {
  const calls = []
  const store = createStockTagStore({
    fetchBatch: async (codes) => {
      calls.push(codes)
      return codes.map((code) => ({
        code,
        displayTags: [{ name: `题材${code}`, kind: 'concept' }],
      }))
    },
  })

  store.ensure('300476')
  store.ensure('300408')
  store.ensure('300476')
  await store.flush()

  assert.deepEqual(calls, [['300476', '300408']])
  assert.equal(store.get('300476').displayTags[0].name, '题材300476')
  assert.equal(store.get('300408').displayTags[0].name, '题材300408')
})

test('已有缓存与在途股票不会重复请求', async () => {
  let calls = 0
  let resolveRequest
  const store = createStockTagStore({
    fetchBatch: (codes) => {
      calls++
      return new Promise((resolve) => {
        resolveRequest = () => resolve(codes.map((code) => ({
          code,
          displayTags: [{ name: 'PCB', kind: 'concept' }],
        })))
      })
    },
  })

  store.ensure('300476')
  const first = store.flush()
  store.ensure('300476')
  const second = store.flush()
  resolveRequest()
  await Promise.all([first, second])
  store.ensure('300476')
  await store.flush()

  assert.equal(calls, 1)
})
