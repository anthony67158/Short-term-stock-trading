import test from 'node:test'
import assert from 'node:assert/strict'

import { startAdvicePersistently } from '../shared/adviceUiState.js'

test('登录态单股建议优先提交服务端持久任务', () => {
  const calls = []
  const result = startAdvicePersistently({
    code: '600519',
    name: '贵州茅台',
  }, {
    canUseServer: () => true,
    triggerServer: (codes, options) => {
      calls.push({ codes, options })
      return true
    },
    startLocal: () => {
      throw new Error('不应启动浏览器本地任务')
    },
  })

  assert.equal(result.status, 'started')
  assert.equal(result.mode, 'server')
  assert.deepEqual(calls[0].codes, ['600519'])
  assert.equal(calls[0].options.force, true)
})

test('无法提交服务端时才回退本地生成', () => {
  let localStarted = false
  const result = startAdvicePersistently({ code: '600519' }, {
    canUseServer: () => false,
    triggerServer: () => false,
    startLocal: () => { localStarted = true },
  })

  assert.equal(result.mode, 'local')
  assert.equal(localStarted, true)
})
