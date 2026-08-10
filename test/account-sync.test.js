import test from 'node:test'
import assert from 'node:assert/strict'

import { createCloudSaveQueue } from '../shared/accountSync.js'

test('云端保存失败后保留最新数据并自动重试到成功', async () => {
  const calls = []
  const states = []
  const timers = []
  const queue = createCloudSaveQueue({
    save: async (payload) => {
      calls.push(payload)
      if (calls.length === 1) return { ok: false, error: 'OSS 暂时不可用' }
      return { ok: true, updatedAt: 123, storage: 'oss' }
    },
    onState: (value) => states.push(value),
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: () => {},
  })

  await queue.enqueue({ version: 1 })
  assert.equal(states.at(-1).status, 'error')
  assert.equal(timers.length, 1)

  await timers[0]()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], { version: 1 })
  assert.equal(states.at(-1).status, 'synced')
  assert.equal(states.at(-1).updatedAt, 123)
})

test('保存进行中产生的新变更会在本轮继续写入 OSS', async () => {
  const calls = []
  let releaseFirst
  const first = new Promise((resolve) => { releaseFirst = resolve })
  const queue = createCloudSaveQueue({
    save: async (payload) => {
      calls.push(payload)
      if (calls.length === 1) await first
      return { ok: true, updatedAt: calls.length, storage: 'oss' }
    },
    onState: () => {},
  })

  const running = queue.enqueue({ version: 1 })
  queue.enqueue({ version: 2 })
  releaseFirst()
  await running

  assert.deepEqual(calls, [{ version: 1 }, { version: 2 }])
})

test('退出账号会取消进行中的旧账号失败重试', async () => {
  const states = []
  const timers = []
  let rejectSave
  const queue = createCloudSaveQueue({
    save: () => new Promise((_, reject) => { rejectSave = reject }),
    onState: (value) => states.push(value),
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: () => {},
  })

  const running = queue.enqueue({ account: 'old' })
  queue.reset()
  rejectSave(new Error('network failed'))
  await running

  assert.equal(timers.length, 0)
  assert.equal(states.some((item) => item.status === 'error'), false)
})

test('版本冲突属于不可重试错误并丢弃旧快照', async () => {
  const states = []
  const timers = []
  const queue = createCloudSaveQueue({
    save: async () => ({
      ok: false,
      retryable: false,
      error: '云端数据已更新，请刷新页面后重试',
    }),
    onState: (value) => states.push(value),
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: () => {},
  })

  const saved = await queue.enqueue({ version: 1 })
  const retried = await queue.retry()

  assert.equal(saved, false)
  assert.equal(retried, true)
  assert.equal(timers.length, 0)
  assert.equal(states.at(-1).status, 'error')
})
