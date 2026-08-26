import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRUSTED_QUANT_VERSION,
  canUseQuantModel,
  resolveQuantModelForRequest,
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

test('FC后台任务只在内部密钥匹配时可调用选定量化模型', async () => {
  const previous = process.env.CRON_KEY
  process.env.CRON_KEY = 'internal-cron-key'
  try {
    assert.equal(await canUseQuantModel({
      headers: {
        'x-cron-key': 'internal-cron-key',
      },
    }, 'v2.1'), true)
    assert.equal(await canUseQuantModel({
      headers: {
        'x-cron-key': 'wrong-key',
      },
    }, 'v2.1', {
      readAccount: async () => null,
    }), false)
  } finally {
    if (previous == null) delete process.env.CRON_KEY
    else process.env.CRON_KEY = previous
  }
})

test('V2.1只允许当前账号明确选择V2.1，不复用V2.0授权', async () => {
  const readAccount = async (nick) => ({
    status: 'active',
    nick,
    pwHash: 'expected',
    data: { settings: { quantModelVersion: 'v2.1' } },
  })
  const request = { headers: encodedHeaders() }

  assert.equal(await canUseQuantModel(request, 'v2.1', {
    readAccount,
    hashPassword: () => 'expected',
    isAuthorized: () => true,
  }), true)
  assert.equal(await canUseQuantModel(request, 'v2', {
    readAccount,
    hashPassword: () => 'expected',
    isAuthorized: () => true,
  }), false)

  const trusted = { [TRUSTED_QUANT_VERSION]: 'v2.1' }
  assert.equal(await canUseQuantModel(trusted, 'v2.1'), true)
})

test('已登录请求始终使用账号当前选择的量化模型', async () => {
  const readAccount = async (nick) => ({
    status: 'active',
    nick,
    pwHash: 'expected',
    data: { settings: { quantModelVersion: 'v2' } },
  })
  const request = { headers: encodedHeaders() }

  assert.equal(await resolveQuantModelForRequest(
    request,
    'default',
    {
      readAccount,
      hashPassword: () => 'expected',
      isAuthorized: () => true,
    },
  ), 'v2')
  assert.equal(request[TRUSTED_QUANT_VERSION], 'v2')
})

test('AI已完成鉴权时直接复用账号模型设置不重复读取账号', async () => {
  const request = { headers: encodedHeaders() }
  const account = {
    status: 'active',
    data: { settings: { quantModelVersion: 'v2.1' } },
  }
  let accountReads = 0

  assert.equal(await resolveQuantModelForRequest(
    request,
    'default',
    {
      account,
      readAccount: async () => {
        accountReads++
        return account
      },
      isAuthorized: () => true,
    },
  ), 'v2.1')
  assert.equal(accountReads, 0)
})
