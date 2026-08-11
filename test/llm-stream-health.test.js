import test from 'node:test'
import assert from 'node:assert/strict'

import {
  markEndpointUnusable,
  markSuccess,
  pickEndpoint,
  poolFetch,
  poolStatus,
} from '../api/_llm_pool.js'
import { pumpChatStream } from '../api/_llm.js'

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

test('深度批量可覆盖端点默认关闭并实际下发深度参数', async () => {
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

    assert.equal(sentBody.reasoning_effort, 'high')
  } finally {
    globalThis.fetch = originalFetch
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
