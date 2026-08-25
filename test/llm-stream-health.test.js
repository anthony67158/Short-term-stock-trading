import test from 'node:test'
import assert from 'node:assert/strict'

import {
  markEndpointUnusable,
  markSuccess,
  pickEndpoint,
  poolFetch,
  poolStatus,
  resetPoolHealthForTests,
} from '../api/_llm_pool.js'
import { pumpChatStream } from '../api/_llm.js'

test('空流端点立即冷却，下一次请求切换到备用端点', () => {
  const config = {
    roleEndpoints: {
      advisor: [{
        baseUrl: 'https://advisor-1.example/v1',
        apiKey: 'advisor-1-key',
        model: 'advisor-1-model',
        enabled: true,
      }, {
        baseUrl: 'https://advisor-2.example/v1',
        apiKey: 'advisor-2-key',
        model: 'advisor-2-model',
        enabled: true,
      }],
    },
  }
  const first = pickEndpoint(config, 1000, 'advisor')
  assert.equal(first.id, 'advisor-1')

  markEndpointUnusable(first.id, 1000)
  const second = pickEndpoint(config, 1001, 'advisor')

  assert.equal(second.id, 'advisor-2')
})

test('流式请求在响应体消费完成前持续占用端点', async () => {
  const config = {
    roleEndpoints: {
      advisor: [{
        baseUrl: 'https://stream.example/v1',
        apiKey: 'key',
        model: 'model',
        enabled: true,
      }],
    },
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
    routed.releaseRole()
    assert.equal(poolStatus(config)[0].inflight, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('深度批量可覆盖端点默认关闭并下发有界推理参数', async () => {
  const config = {
    baseUrl: 'https://main.example/v1',
    apiKey: 'key',
    models: { advisor: 'model' },
    reasoning: { advisor: false },
  }
  const originalFetch = globalThis.fetch
  let sentBody = null
  globalThis.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body)
    return new Response('{}', { status: 200 })
  }
  try {
    await poolFetch(config, '/chat/completions', {
      body: { model: 'model', stream: true },
      role: 'advisor',
      reasonFallback: true,
      forceReason: true,
    }, 1)

    assert.equal(sentBody.reasoning_effort, 'medium')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('流式请求在成功响应头前可快速切换备用端点', async () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      advisor: [{
        baseUrl: 'https://advisor-1.example/v1',
        apiKey: 'key-1',
        model: 'model-1',
        enabled: true,
      }, {
        baseUrl: 'https://advisor-2.example/v1',
        apiKey: 'key-2',
        model: 'model-2',
        enabled: true,
      }],
    },
  }
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(url)
    return new Response('{}', { status: urls.length === 1 ? 503 : 200 })
  }
  try {
    const routed = await poolFetch(config, '/chat/completions', {
      body: { model: 'model', stream: true },
      role: 'advisor',
      deferSuccess: true,
    }, 2)

    assert.equal(routed.resp.ok, true)
    assert.equal(urls.length, 2)
    assert.notEqual(urls[0], urls[1])
    routed.releaseRole()
  } finally {
    globalThis.fetch = originalFetch
    resetPoolHealthForTests()
  }
})

test('流读取中断时保留已经收到的推理和正文', async () => {
  const encoder = new TextEncoder()
  const chunks = [
    encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"正在核对支撑位。"}}]}\n\n'),
    encoder.encode('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"持有\\""}}]}\n\n'),
  ]
  let index = 0
  const response = {
    body: {
      getReader() {
        return {
          async read() {
            if (index < chunks.length) return { value: chunks[index++], done: false }
            throw new Error('upstream stream reset')
          },
        }
      },
    },
  }

  const result = await pumpChatStream(response)

  assert.equal(result.reasoning, '正在核对支撑位。')
  assert.equal(result.content, '{"action":"持有"')
})
