import test from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'

import {
  sendApiResponse,
  sendJsonResponse,
} from '../api/_http_response.js'

function fakeResponse() {
  const headers = new Map()
  return {
    headers,
    body: null,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value))
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase())
    },
    end(body) {
      this.body = body
    },
  }
}

test('大型 JSON 响应在浏览器支持 gzip 时压缩且保持原始内容', () => {
  const req = {
    headers: {
      'accept-encoding': 'gzip, deflate, br',
    },
  }
  const res = fakeResponse()
  const value = {
    ok: true,
    data: {
      advice: Array.from(
        { length: 200 },
        (_, index) => ({
          code: String(index).padStart(6, '0'),
          reasoning: '完整建议与证据'.repeat(100),
        }),
      ),
    },
  }

  sendJsonResponse(req, res, value)

  assert.equal(res.headers.get('content-encoding'), 'gzip')
  assert.equal(res.headers.get('vary'), 'Accept-Encoding')
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.deepEqual(
    JSON.parse(gunzipSync(res.body).toString('utf8')),
    value,
  )
  assert.ok(
    res.body.length < Buffer.byteLength(JSON.stringify(value)) * 0.3,
  )
})

test('小型 JSON 或客户端不支持 gzip 时保持未压缩响应', () => {
  for (const req of [
    { headers: {} },
    { headers: { 'accept-encoding': 'gzip' } },
  ]) {
    const res = fakeResponse()
    const value = { ok: true }

    sendJsonResponse(req, res, value)

    assert.equal(res.headers.get('content-encoding'), undefined)
    assert.deepEqual(JSON.parse(res.body.toString('utf8')), value)
  }
})

test('账号接口预先序列化后通过 res.send 返回的大 JSON 同样压缩', () => {
  const req = {
    headers: {
      'accept-encoding': 'gzip, deflate, br',
    },
  }
  const res = fakeResponse()
  const value = {
    ok: true,
    data: {
      advice: '完整建议'.repeat(20_000),
    },
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  sendApiResponse(req, res, JSON.stringify(value))

  assert.equal(res.headers.get('content-encoding'), 'gzip')
  assert.deepEqual(
    JSON.parse(gunzipSync(res.body).toString('utf8')),
    value,
  )
})
