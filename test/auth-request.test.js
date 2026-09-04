import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

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
    transient: true,
    code: 'NETWORK_ERROR',
    error: '网络连接失败，请检查网络后重试',
  })
})

test('大型账号登录恢复和保存使用足够传输预算', () => {
  assert.equal(accountRequestTimeoutMs('login'), 45000)
  assert.equal(accountRequestTimeoutMs('register'), 45000)
  assert.equal(accountRequestTimeoutMs('get'), 30000)
  assert.equal(accountRequestTimeoutMs('sync'), 20000)
  assert.equal(accountRequestTimeoutMs('save'), 45000)
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
    transient: true,
    code: 'REQUEST_TIMEOUT',
    error: '请求超时，请重试',
  })
  assert.match(authStoreSource, /accountApiRequest/)
  assert.match(authStoreSource, /state\.status = 'error'/)
})

test('大型账号保存请求使用gzip传输并保持JSON内容完整', async () => {
  let captured = null
  const payload = {
    nick: '测试账号',
    data: {
      advice: {
        '600519': {
          text: '重复分析正文'.repeat(30000),
        },
      },
    },
  }
  const result = await accountApiRequest(
    '/api/account',
    'save',
    payload,
    {
      fetchImpl: async (_url, init) => {
        captured = init
        return {
          text: async () => JSON.stringify({
            ok: true,
            storage: 'oss',
          }),
        }
      },
    },
  )

  assert.equal(result.ok, true)
  assert.equal(captured.headers['Content-Encoding'], 'gzip')
  assert.deepEqual(
    JSON.parse(gunzipSync(Buffer.from(captured.body)).toString('utf8')),
    { action: 'save', ...payload },
  )
})
