import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'

import {
  RequestBodyError,
  readRequestBody,
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
