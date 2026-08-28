import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  accountApiRequest,
  accountRequestTimeoutMs,
} from '../src/accountRequest.js'

const root = new URL('../', import.meta.url)
const authStoreSource = readFileSync(
  new URL('src/authStore.js', root),
  'utf8',
)

test('账号请求网络失败时返回可展示错误而不是永久停在加载中', async () => {
  const result = await accountApiRequest(
    '/api/account',
    'login',
    { nick: '测试账号', pw: '测试密码' },
    {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch')
      },
    },
  )

  assert.deepEqual(result, {
    ok: false,
    error: '网络连接失败，请检查网络后重试',
  })
})

test('登录与恢复允许较大账号完成传输而普通同步保持短超时', () => {
  assert.equal(accountRequestTimeoutMs('login'), 45000)
  assert.equal(accountRequestTimeoutMs('register'), 45000)
  assert.equal(accountRequestTimeoutMs('get'), 45000)
  assert.equal(accountRequestTimeoutMs('sync'), 20000)
  assert.equal(accountRequestTimeoutMs('save'), 20000)
})

test('账号请求超时时返回明确提示并允许登录状态收尾', async () => {
  const error = new Error('aborted')
  error.name = 'AbortError'
  const result = await accountApiRequest(
    '/api/account',
    'login',
    { nick: '测试账号', pw: '测试密码' },
    {
      fetchImpl: async () => {
        throw error
      },
    },
  )

  assert.deepEqual(result, {
    ok: false,
    error: '请求超时，请重试',
  })
  assert.match(authStoreSource, /accountApiRequest/)
  assert.match(authStoreSource, /state\.status = 'error'/)
})
