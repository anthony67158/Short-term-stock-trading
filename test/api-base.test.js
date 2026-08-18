import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PRODUCTION_API_BASE,
  PRODUCTION_SITE_HOST,
  api,
  resolveApiBase,
} from '../src/apiBase.js'

test('生产环境缺少VITE_API_BASE时回退稳定FC地址', () => {
  assert.equal(resolveApiBase({ PROD: true }), PRODUCTION_API_BASE)
  assert.equal(
    resolveApiBase({ PROD: true, VITE_API_BASE: 'https://example.com/' }),
    'https://example.com',
  )
})

test('本地开发保持相对API路径以使用Vite代理', () => {
  assert.equal(resolveApiBase({ DEV: true }), '')
  assert.equal(api('/not-api'), '/not-api')
})

test('备案新域名使用同域 API 以携带设备授权凭证', () => {
  assert.equal(PRODUCTION_SITE_HOST, 'www.tedixtf.cn')
  assert.equal(
    resolveApiBase(
      { PROD: true, VITE_API_BASE: PRODUCTION_API_BASE },
      { hostname: PRODUCTION_SITE_HOST },
    ),
    '',
  )
})
