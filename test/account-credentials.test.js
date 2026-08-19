import test from 'node:test'
import assert from 'node:assert/strict'

import {
  accountCredentialHeaders,
  accountCredentialPayload,
  parseStoredAccountSession,
  storedAccountSession,
} from '../shared/accountCredentials.js'

test('持久账号会话只保存令牌且不保留登录密码', () => {
  assert.deepEqual(
    storedAccountSession('测试账号', 'signed-token'),
    { nick: '测试账号', token: 'signed-token' },
  )
  assert.equal(
    JSON.stringify(storedAccountSession('测试账号', 'signed-token')).includes('pw'),
    false,
  )
})

test('旧密码会话只作为一次性换票凭证读取', () => {
  assert.deepEqual(
    parseStoredAccountSession({ nick: '旧账号', pw: 'legacy-password' }),
    {
      credentials: { nick: '旧账号', pw: 'legacy-password' },
      legacyPassword: true,
    },
  )
  assert.deepEqual(
    parseStoredAccountSession({ nick: '新账号', token: 'signed-token' }),
    {
      credentials: { nick: '新账号', token: 'signed-token' },
      legacyPassword: false,
    },
  )
})

test('账号请求凭证优先使用令牌且不传播密码', () => {
  const credentials = {
    nick: '测试账号',
    token: 'signed-token',
    pw: 'must-not-leak',
  }

  assert.deepEqual(accountCredentialPayload(credentials), {
    nick: '测试账号',
    token: 'signed-token',
  })
  assert.deepEqual(accountCredentialHeaders(credentials), {
    'X-Account-Nick': encodeURIComponent('测试账号'),
    'X-Account-Token': encodeURIComponent('signed-token'),
  })
})
