import test from 'node:test'
import assert from 'node:assert/strict'

import aiHandler from '../api/ai.js'
import agentHandler from '../api/agent.js'
import dailyReportHandler from '../api/daily_report.js'
import llmConfigHandler from '../api/llm_config.js'
import confirmSignalHandler from '../api/confirm_signal.js'
import {
  TRUSTED_ACCOUNT_REQUEST,
  authenticateAccountRequest,
  isAuthorizedAccount,
} from '../api/_account_auth.js'

function encodedHeaders(nick = '测试账号', pw = '测试密码') {
  return {
    'x-account-nick': encodeURIComponent(nick),
    'x-account-password': encodeURIComponent(pw),
  }
}

function responseStub() {
  let resolve
  const ended = new Promise((done) => { resolve = done })
  return {
    statusCode: 200,
    headers: {},
    body: '',
    ended,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value },
    status(code) { this.statusCode = code; return this },
    send(body) { this.body = String(body); resolve(); return this },
    end(body = '') { this.body = String(body); resolve(); return this },
    write() { return true },
  }
}

test('账号请求必须验证密码且服务端可信调用可绕过浏览器凭证', async () => {
  const readAccount = async (nick) => ({
    nick,
    status: 'active',
    pwHash: 'expected',
  })

  assert.equal((await authenticateAccountRequest({}, { readAccount })).ok, false)
  assert.equal((await authenticateAccountRequest({
    headers: encodedHeaders(),
  }, {
    readAccount,
    hashPassword: () => 'wrong',
  })).ok, false)
  assert.equal((await authenticateAccountRequest({
    headers: encodedHeaders(),
  }, {
    readAccount,
    hashPassword: () => 'expected',
  })).ok, true)
  assert.equal((await authenticateAccountRequest({
    [TRUSTED_ACCOUNT_REQUEST]: true,
  })).ok, true)
})

test('付费能力只允许部署白名单中的账号', () => {
  const account = { nick: '已有账号' }
  const accountHash = 'authorized-hash'
  const hashAccount = () => accountHash

  assert.equal(isAuthorizedAccount(account, {
    env: { AUTHORIZED_ACCOUNT_HASHES: accountHash },
    hashAccount,
  }), true)
  assert.equal(isAuthorizedAccount(account, {
    env: { AUTHORIZED_ACCOUNT_HASHES: 'other-hash' },
    hashAccount,
  }), false)
  assert.equal(isAuthorizedAccount(account, {
    env: {},
    hashAccount,
  }), false)
})

test('匿名调用付费AI接口必须在触发模型前返回401', async () => {
  const req = {
    method: 'POST',
    headers: {},
    body: { mode: 'market', payload: {} },
  }
  const res = responseStub()

  await aiHandler(req, res)
  await res.ended

  assert.equal(res.statusCode, 401)
  assert.equal(JSON.parse(res.body).ok, false)
})

test('匿名调用智能体和策略日报同样必须返回401', async () => {
  for (const handler of [
    agentHandler,
    dailyReportHandler,
    llmConfigHandler,
    confirmSignalHandler,
  ]) {
    const req = { method: 'POST', headers: {}, body: {}, query: {} }
    const res = responseStub()

    await handler(req, res)
    await res.ended

    assert.equal(res.statusCode, 401)
    assert.equal(JSON.parse(res.body).ok, false)
  }
})

test('无成本健康检查保持公开且不触发模型', async () => {
  const req = {
    method: 'POST',
    headers: {},
    body: { mode: 'ping' },
  }
  const res = responseStub()

  await aiHandler(req, res)
  await res.ended

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, mode: 'ping' })
})
