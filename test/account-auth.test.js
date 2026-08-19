import test from 'node:test'
import assert from 'node:assert/strict'

import aiHandler from '../api/ai.js'
import agentHandler from '../api/agent.js'
import dailyReportHandler from '../api/daily_report.js'
import llmConfigHandler from '../api/llm_config.js'
import aiSearchConfigHandler from '../api/ai_search_config.js'
import confirmSignalHandler from '../api/confirm_signal.js'
import {
  TRUSTED_ACCOUNT_REQUEST,
  authenticateAccountRequest,
  isAuthorizedAccount,
  isRuntimeConfigAdmin,
} from '../api/_account_auth.js'
import {
  createAccountSessionToken,
  verifyAccountSessionToken,
} from '../api/_account_session.js'

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

test('账号会话令牌绑定账号密码摘要并在过期后失效', () => {
  const account = { nick: '已有账号', pwHash: 'password-hash' }
  const secret = 'session-secret'
  const now = Date.parse('2026-08-19T00:00:00.000Z')
  const token = createAccountSessionToken(account, {
    secret,
    now,
    maxAgeSeconds: 60,
  })

  assert.equal(verifyAccountSessionToken(account, token, {
    secret,
    now: now + 30_000,
  }), true)
  assert.equal(verifyAccountSessionToken(
    { ...account, pwHash: 'changed' },
    token,
    { secret, now: now + 30_000 },
  ), false)
  assert.equal(verifyAccountSessionToken(account, token, {
    secret,
    now: now + 61_000,
  }), false)
})

test('运行时全局配置只允许显式管理员且单付费账号兼容回退', () => {
  const account = { nick: '已有账号' }
  const accountHash = 'authorized-hash'
  const hashAccount = () => accountHash

  assert.equal(isRuntimeConfigAdmin(account, {
    env: {
      AUTHORIZED_ACCOUNT_HASHES: `${accountHash},other`,
      RUNTIME_CONFIG_ADMIN_HASHES: accountHash,
    },
    hashAccount,
  }), true)
  assert.equal(isRuntimeConfigAdmin(account, {
    env: { AUTHORIZED_ACCOUNT_HASHES: `${accountHash},other` },
    hashAccount,
  }), false)
  assert.equal(isRuntimeConfigAdmin(account, {
    env: { AUTHORIZED_ACCOUNT_HASHES: accountHash },
    hashAccount,
  }), true)
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
    aiSearchConfigHandler,
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
