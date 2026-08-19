import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCloudSaveQueue,
  accountTradeStateFingerprint,
  accountSnapshotForRestore,
  sameAccountTradeState,
  saveWithRevisionRecovery,
} from '../shared/accountSync.js'

test('刷新恢复账号时优先保留尚未上传完成的本地交易快照', () => {
  const cloud = {
    holding: [{ id: 'h1', code: '002309', qty: 25 }],
    closed: [],
    alerts: [{ id: 'cloud-alert' }],
  }
  const pending = {
    data: {
      holding: [{ id: 'h1', code: '002309', qty: 16 }],
      closed: [{ id: 'sell-1', code: '002309', type: 'SELL', qty: 9 }],
      alerts: [{ id: 'cloud-alert' }],
    },
  }

  const restored = accountSnapshotForRestore(cloud, pending)

  assert.equal(restored.holding[0].qty, 16)
  assert.equal(restored.closed[0].id, 'sell-1')
})

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

test('真实交易冲突停止盲目重试并显示冲突状态', async () => {
  const states = []
  const timers = []
  const queue = createCloudSaveQueue({
    save: async () => ({
      ok: false,
      retryable: false,
      code: 'TRADE_STATE_CONFLICT',
      conflict: true,
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
  assert.equal(states.at(-1).status, 'conflict')
})

test('交易账本一致时版本冲突会自动更新修订号并重放保存', async () => {
  const calls = []
  const revisions = []
  const local = {
    plan: [{ code: '600519' }],
    holding: [{ id: 'h1', code: '600000', qty: 2 }],
    closed: [{ id: 't1', code: '600000' }],
    account: { cash: 10000 },
    advice: { '600000': { at: 2 } },
  }
  const remote = {
    ...local,
    advice: { '600000': { at: 3 } },
  }
  const result = await saveWithRevisionRecovery({
    payload: { nick: '测试', data: local, baseRevision: 7 },
    save: async (payload) => {
      calls.push(payload)
      return calls.length === 1
        ? {
            ok: false,
            code: 'ACCOUNT_VERSION_CONFLICT',
            revision: 8,
            retryable: false,
          }
        : { ok: true, storage: 'oss', revision: 9 }
    },
    getLatest: async () => ({
      ok: true,
      revision: 8,
      data: remote,
    }),
    onRevision: (revision) => revisions.push(revision),
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].baseRevision, 8)
  assert.deepEqual(revisions, [8])
})

test('两端交易账本都变化时拒绝自动覆盖', async () => {
  const calls = []
  const result = await saveWithRevisionRecovery({
    payload: {
      data: {
        holding: [{ id: 'local', code: '600000', qty: 2 }],
        closed: [],
      },
      baseRevision: 7,
    },
    save: async (payload) => {
      calls.push(payload)
      return {
        ok: false,
        code: 'ACCOUNT_VERSION_CONFLICT',
        revision: 8,
        retryable: false,
      }
    },
    getLatest: async () => ({
      ok: true,
      revision: 8,
      data: {
        holding: [{ id: 'remote', code: '600000', qty: 1 }],
        closed: [],
      },
    }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'TRADE_STATE_CONFLICT')
  assert.equal(result.retryable, false)
  assert.equal(calls.length, 1)
})

test('交易账本比较忽略AI建议和运行状态变化', () => {
  const base = {
    plan: [{ code: '600519' }],
    holding: [{ id: 'h1', code: '600000', qty: 2 }],
    closed: [{ id: 't1' }],
    account: { cash: 10000 },
  }
  assert.equal(sameAccountTradeState({
    ...base,
    advice: { a: { at: 1 } },
  }, {
    ...base,
    advice: { a: { at: 2 } },
    jobs: { a: { status: 'running' } },
  }), true)
  assert.equal(sameAccountTradeState(base, {
    ...base,
    holding: [{ id: 'h1', code: '600000', qty: 1 }],
  }), false)
})

test('本地待办基于的云端交易指纹未变时允许重放本地交易', async () => {
  const base = {
    holding: [{ id: 'h1', code: '600000', qty: 1 }],
    closed: [],
  }
  const localPending = {
    holding: [{ id: 'h1', code: '600000', qty: 2 }],
    closed: [{ id: 'buy-2', code: '600000' }],
  }
  const calls = []
  const result = await saveWithRevisionRecovery({
    payload: {
      data: localPending,
      baseRevision: 7,
      baseTradeFingerprint: accountTradeStateFingerprint(base),
    },
    save: async (payload) => {
      calls.push(payload)
      return calls.length === 1
        ? {
            ok: false,
            code: 'ACCOUNT_VERSION_CONFLICT',
            revision: 8,
            retryable: false,
          }
        : { ok: true, storage: 'oss', revision: 9 }
    },
    getLatest: async () => ({
      ok: true,
      revision: 8,
      data: {
        ...base,
        advice: { '600000': { at: 2 } },
      },
    }),
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].baseRevision, 8)
})
