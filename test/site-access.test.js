import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROTECTED_SITE_HOST,
  createSiteAccessLimiter,
  createSiteAccessToken,
  isProtectedSiteHost,
  siteAccessCodeDigest,
  verifySiteAccessCode,
  verifySiteAccessToken,
} from '../api/_site_access.js'

test('设备授权只保护备案新域名，不影响 Vercel 和旧 FC 地址', () => {
  assert.equal(PROTECTED_SITE_HOST, 'www.tedixtf.cn')
  assert.equal(isProtectedSiteHost('www.tedixtf.cn'), true)
  assert.equal(isProtectedSiteHost('www.tedixtf.cn:443'), true)
  assert.equal(isProtectedSiteHost('stock-dashboard-one-plum.vercel.app'), false)
  assert.equal(isProtectedSiteHost('stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run'), false)
})

test('授权码只通过服务端密钥派生摘要校验', () => {
  const secret = 'test-server-secret'
  const expectedDigest = siteAccessCodeDigest('87654321', secret)

  assert.equal(
    verifySiteAccessCode('87654321', { expectedDigest, secret }),
    true,
  )
  assert.equal(
    verifySiteAccessCode('87654320', { expectedDigest, secret }),
    false,
  )
  assert.equal(
    verifySiteAccessCode('not-code', { expectedDigest, secret }),
    false,
  )
})

test('设备凭证可长期复用，但篡改、过期或更换服务端密钥后失效', () => {
  const now = Date.UTC(2026, 7, 17)
  const token = createSiteAccessToken({
    secret: 'test-server-secret',
    deviceId: 'device-a',
    now,
    maxAgeSeconds: 3600,
  })

  assert.equal(
    verifySiteAccessToken(token, {
      secret: 'test-server-secret',
      now: now + 30 * 60 * 1000,
    }),
    true,
  )
  assert.equal(
    verifySiteAccessToken(token + 'x', {
      secret: 'test-server-secret',
      now,
    }),
    false,
  )
  assert.equal(
    verifySiteAccessToken(token, {
      secret: 'different-secret',
      now,
    }),
    false,
  )
  assert.equal(
    verifySiteAccessToken(token, {
      secret: 'test-server-secret',
      now: now + 2 * 3600 * 1000,
    }),
    false,
  )
})

test('连续输错授权码会触发窗口限速，成功后清空失败状态', () => {
  const limiter = createSiteAccessLimiter({
    maxAttempts: 3,
    windowMs: 60_000,
  })

  assert.equal(limiter.canAttempt('1.2.3.4', 1_000), true)
  limiter.recordFailure('1.2.3.4', 1_000)
  limiter.recordFailure('1.2.3.4', 2_000)
  limiter.recordFailure('1.2.3.4', 3_000)
  assert.equal(limiter.canAttempt('1.2.3.4', 4_000), false)
  assert.equal(limiter.canAttempt('1.2.3.4', 62_000), true)

  limiter.recordFailure('1.2.3.4', 63_000)
  limiter.reset('1.2.3.4')
  assert.equal(limiter.canAttempt('1.2.3.4', 64_000), true)
})
