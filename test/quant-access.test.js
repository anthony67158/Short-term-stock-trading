import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRUSTED_QUANT_VERSION,
  canUseQuantModel,
} from '../api/_quant_access.js'

function encodedHeaders(nick = '测试账号', pw = '测试密码') {
  return {
    'x-account-nick': encodeURIComponent(nick),
    'x-account-password': encodeURIComponent(pw),
  }
}

test('默认生产模型保持公开可调用', async () => {
  assert.equal(await canUseQuantModel({}, 'default'), true)
})

test('V2拒绝无凭证、错误凭证和未选择V2的账号', async () => {
  const readAccount = async () => ({
    status: 'active',
    pwHash: 'expected',
    data: { settings: { quantModelVersion: 'default' } },
  })

  assert.equal(await canUseQuantModel({}, 'v2', { readAccount }), false)
  assert.equal(await canUseQuantModel({
    headers: encodedHeaders(),
  }, 'v2', {
    readAccount,
    hashPassword: () => 'wrong',
    isAuthorized: () => true,
  }), false)
  assert.equal(await canUseQuantModel({
    headers: encodedHeaders(),
  }, 'v2', {
    readAccount,
    hashPassword: () => 'expected',
    isAuthorized: () => true,
  }), false)
})

test('V2允许已选择V2的有效账号和服务端可信调用', async () => {
  const readAccount = async (nick) => ({
    status: 'active',
    nick,
    pwHash: 'expected',
    data: { settings: { quantModelVersion: 'v2' } },
  })
  const request = { headers: encodedHeaders() }

  assert.equal(await canUseQuantModel(request, 'v2', {
    readAccount,
    hashPassword: () => 'expected',
    isAuthorized: () => true,
  }), true)

  const trusted = { [TRUSTED_QUANT_VERSION]: 'v2' }
  assert.equal(await canUseQuantModel(trusted, 'v2'), true)
})
