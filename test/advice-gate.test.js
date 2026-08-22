import test from 'node:test'
import assert from 'node:assert/strict'

import { startAdvicePersistently } from '../shared/adviceUiState.js'
import { ensureAdviceAccountSynced } from '../shared/adviceAccountSync.js'

test('提交云端军师任务前必须等待最新交易账本写入OSS', async () => {
  const events = []
  const result = await ensureAdviceAccountSynced({
    flushLocal: async () => {
      events.push('flush-local')
      return true
    },
    retryCloud: async () => {
      events.push('confirm-cloud')
      return true
    },
  })

  assert.deepEqual(events, ['flush-local', 'confirm-cloud'])
  assert.deepEqual(result, { ok: true })
})

test('最新交易账本未确认写入OSS时禁止提交云端军师任务', async () => {
  const result = await ensureAdviceAccountSynced({
    flushLocal: async () => false,
    retryCloud: async () => {
      throw new Error('本地保存失败后不应继续')
    },
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /账本/)
})

test('登录态单股建议收到服务端确认后才进入云端生成态', async () => {
  const calls = []
  const result = await startAdvicePersistently({
    code: '600519',
    name: '贵州茅台',
  }, {
    canUseServer: () => true,
    triggerServer: async (codes, options) => {
      calls.push({ codes, options })
      return {
        ok: true,
        accepted: true,
        progress: {
          items: [{
            code: '600519',
            status: 'running',
            stage: 'collect',
            phase: '正在采集证据',
          }],
        },
      }
    },
    startLocal: () => {
      throw new Error('不应启动浏览器本地任务')
    },
  })

  assert.equal(result.status, 'started')
  assert.equal(result.mode, 'server')
  assert.equal(result.progress.items[0].stage, 'collect')
  assert.deepEqual(calls[0].codes, ['600519'])
  assert.equal(calls[0].options.force, true)
})

test('服务端未确认受理时回退本地生成', async () => {
  let localStarted = false
  const result = await startAdvicePersistently({ code: '600519' }, {
    canUseServer: () => true,
    triggerServer: async () => ({ ok: false, error: '调度失败' }),
    startLocal: () => { localStarted = true },
  })

  assert.equal(result.mode, 'local')
  assert.equal(localStarted, true)
})

test('任务已持久化但Worker调度失败时保留云端排队态', async () => {
  const result = await startAdvicePersistently({ code: '600519' }, {
    canUseServer: () => true,
    triggerServer: async () => ({
      ok: false,
      queued: true,
      error: '等待云端定时恢复',
    }),
    startLocal: () => {
      throw new Error('已持久化任务不能再本地重复生成')
    },
  })

  assert.equal(result.mode, 'server')
  assert.equal(result.status, 'queued')
  assert.equal(result.error, '等待云端定时恢复')
})
