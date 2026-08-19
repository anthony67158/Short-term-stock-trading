import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertSafeRemoteUrl,
  assertSafeWebPushEndpoint,
} from '../api/_safe_remote_url.js'

const publicLookup = async () => [
  { address: '203.0.114.10', family: 4 },
]

test('远程配置端点只允许无凭证的 HTTPS URL', async () => {
  await assert.rejects(
    () => assertSafeRemoteUrl('http://api.example.com/v1', {
      lookup: publicLookup,
    }),
    /HTTPS/,
  )
  await assert.rejects(
    () => assertSafeRemoteUrl('https://user:pass@api.example.com/v1', {
      lookup: publicLookup,
    }),
    /凭证/,
  )
})

test('远程配置端点拒绝本机和私网目标', async () => {
  for (const url of [
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.8/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/v1',
  ]) {
    await assert.rejects(
      () => assertSafeRemoteUrl(url),
      /公网|本机/,
      url,
    )
  }
})

test('远程配置端点拒绝解析到私网的域名并接受公网 HTTPS', async () => {
  await assert.rejects(
    () => assertSafeRemoteUrl('https://rebind.example/v1', {
      lookup: async () => [{ address: '192.168.1.20', family: 4 }],
    }),
    /公网/,
  )

  const safe = await assertSafeRemoteUrl('https://api.example.com/v1/', {
    lookup: publicLookup,
  })
  assert.equal(safe, 'https://api.example.com/v1')
})

test('Web Push只接受浏览器Push Service域名', async () => {
  const accepted = await assertSafeWebPushEndpoint(
    'https://fcm.googleapis.com/fcm/send/subscription-id',
    { lookup: publicLookup },
  )
  assert.match(accepted, /^https:\/\/fcm\.googleapis\.com\//)

  await assert.rejects(
    () => assertSafeWebPushEndpoint(
      'https://attacker.example/push',
      { lookup: publicLookup },
    ),
    /Push Service/,
  )
})
