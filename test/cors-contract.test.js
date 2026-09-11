import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCors } from '../api/_lib.js'

test('跨域公式扫描允许幂等请求头通过预检', () => {
  const headers = {}
  applyCors({
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value)
    },
  })

  assert.match(
    headers['access-control-allow-headers'],
    /(?:^|,\s*)Idempotency-Key(?:,|$)/i,
  )
})
