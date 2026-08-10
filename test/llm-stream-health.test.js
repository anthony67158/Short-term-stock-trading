import test from 'node:test'
import assert from 'node:assert/strict'

import {
  markEndpointUnusable,
  markSuccess,
  pickEndpoint,
  poolFetch,
  poolStatus,
} from '../api/_llm_pool.js'

test('空流端点立即冷却，下一次请求切换到备用端点', () => {
  const config = {
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    models: { advisor: 'main-model' },
    endpoints: [{
      id: 'backup',
      baseUrl: 'https://backup.example/v1',
      apiKey: 'backup-key',
      models: { advisor: 'backup-model' },
    }],
  }
  const first = pickEndpoint(config, 1000, 'advisor')
  assert.equal(first.id, 'default')

  markEndpointUnusable(first.id, 1000)
  const second = pickEndpoint(config, 1001, 'advisor')

  assert.equal(second.id, 'backup')
})

test('流式请求在响应体消费完成前持续占用端点', async () => {
  const config = {
    endpoints: [{
      id: 'stream-health-test',
      baseUrl: 'https://stream.example/v1',
      apiKey: 'key',
      models: { advisor: 'model' },
    }],
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 200 })
  try {
    const routed = await poolFetch(config, '/chat/completions', {
      body: { model: 'model' },
      role: 'advisor',
      deferSuccess: true,
    }, 1)

    assert.equal(routed.deferred, true)
    assert.equal(poolStatus(config)[0].inflight, 1)
    markSuccess(routed.endpoint.id)
    assert.equal(poolStatus(config)[0].inflight, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
