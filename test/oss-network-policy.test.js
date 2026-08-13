import test from 'node:test'
import assert from 'node:assert/strict'

import {
  allowOssPublicNetwork,
  resolveOssEndpoint,
} from '../shared/ossNetworkPolicy.js'

test('OSS默认拒绝通过地域自动推导公网Endpoint', () => {
  assert.throws(
    () => resolveOssEndpoint({
      OSS_REGION: 'oss-cn-hangzhou',
    }),
    /OSS公网访问已禁用/,
  )
})

test('OSS默认拒绝显式公网Endpoint且允许杭州内网Endpoint', () => {
  assert.throws(
    () => resolveOssEndpoint({
      OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
    }),
    /OSS公网访问已禁用/,
  )
  assert.equal(
    resolveOssEndpoint({
      OSS_ENDPOINT: 'https://oss-cn-hangzhou-internal.aliyuncs.com',
    }),
    'https://oss-cn-hangzhou-internal.aliyuncs.com',
  )
})

test('OSS公网访问只能通过显式开关临时启用', () => {
  assert.equal(allowOssPublicNetwork({}), false)
  assert.equal(
    allowOssPublicNetwork({ OSS_ALLOW_PUBLIC_NETWORK: 'true' }),
    true,
  )
  assert.equal(
    resolveOssEndpoint({
      OSS_REGION: 'oss-cn-hangzhou',
      OSS_ALLOW_PUBLIC_NETWORK: 'true',
    }),
    null,
  )
})
