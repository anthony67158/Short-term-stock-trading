import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  PRODUCTION_API_ORIGIN,
  internalApiOrigin,
} from '../api/_internal_origin.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

test('生产自请求不信任自定义域名并固定走FC稳定地址', () => {
  assert.equal(
    internalApiOrigin({
      headers: {
        host: 'www.tedixtf.cn',
        'x-forwarded-host': 'www.tedixtf.cn',
      },
    }),
    PRODUCTION_API_ORIGIN,
  )
  assert.equal(
    internalApiOrigin({
      headers: { host: 'attacker.example' },
    }),
    PRODUCTION_API_ORIGIN,
  )
})

test('FC实例优先走本机回环且本地开发保持本地端口', () => {
  assert.equal(
    internalApiOrigin(
      { headers: { host: 'www.tedixtf.cn' } },
      { FC_SERVER_PORT: '9000' },
    ),
    'http://127.0.0.1:9000',
  )
  assert.equal(
    internalApiOrigin({
      headers: { host: 'localhost:3000' },
    }, {}),
    'http://localhost:3000',
  )
})

test('军师和助手内部数据采集统一使用安全自请求地址', () => {
  assert.match(read('api/ai.js'), /internalApiOrigin\(req\)/)
  assert.match(read('api/agent.js'), /internalApiOrigin\(req\)/)
})
