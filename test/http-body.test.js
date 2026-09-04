import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import {
  accountRequestBodyLimit,
  defaultApiRequestBodyLimit,
  RequestBodyError,
  readRequestBody,
  requestBodyLimitForPath,
} from '../api/_http_body.js'

test('请求体按字节读取并保留UTF-8内容', async () => {
  const text = JSON.stringify({ name: '测试账号' })
  const req = Readable.from([Buffer.from(text)])
  req.headers = {}

  assert.equal(
    await readRequestBody(req, { maxBytes: Buffer.byteLength(text) }),
    text,
  )
})

test('请求体超过上限时返回413错误', async () => {
  const req = Readable.from([Buffer.alloc(12)])
  req.headers = { 'content-length': '12' }

  await assert.rejects(
    () => readRequestBody(req, { maxBytes: 8 }),
    (error) => (
      error instanceof RequestBodyError
      && error.statusCode === 413
      && error.code === 'BODY_TOO_LARGE'
    ),
  )
})

test('账号快照可超过通用API上限但受独立上限约束', async () => {
  const body = Buffer.alloc(9 * 1024 * 1024)
  const req = Readable.from([body])
  req.headers = { 'content-length': String(body.length) }

  assert.ok(accountRequestBodyLimit > body.length)
  assert.equal(
    requestBodyLimitForPath('/api/account'),
    accountRequestBodyLimit,
  )
  assert.equal(
    requestBodyLimitForPath('/api/ai'),
    defaultApiRequestBodyLimit,
  )
  assert.equal(
    (await readRequestBody(req, {
      maxBytes: requestBodyLimitForPath('/api/account'),
    })).length,
    body.length,
  )
})

test('未结束请求在读取超时后失败而不是永久占用连接', async () => {
  const req = new PassThrough()
  req.headers = {}
  req.write('partial')

  await assert.rejects(
    () => readRequestBody(req, { maxBytes: 1024, timeoutMs: 10 }),
    (error) => (
      error instanceof RequestBodyError
      && error.statusCode === 408
      && error.code === 'BODY_TIMEOUT'
    ),
  )
  req.destroy()
})

test('gzip请求体按解压后的JSON读取', async () => {
  const text = JSON.stringify({
    action: 'save',
    data: { note: '同步内容'.repeat(1000) },
  })
  const body = gzipSync(Buffer.from(text))
  const req = Readable.from([body])
  req.headers = {
    'content-encoding': 'gzip',
    'content-length': String(body.length),
  }

  assert.equal(
    await readRequestBody(req, {
      maxBytes: Buffer.byteLength(text),
    }),
    text,
  )
})

test('gzip请求体解压后超过限制时返回413', async () => {
  const body = gzipSync(Buffer.from('x'.repeat(4096)))
  const req = Readable.from([body])
  req.headers = {
    'content-encoding': 'gzip',
    'content-length': String(body.length),
  }

  await assert.rejects(
    () => readRequestBody(req, { maxBytes: 1024 }),
    (error) => (
      error instanceof RequestBodyError
      && error.statusCode === 413
      && error.code === 'BODY_TOO_LARGE'
    ),
  )
})
