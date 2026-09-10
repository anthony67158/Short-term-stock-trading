import test from 'node:test'
import assert from 'node:assert/strict'

import {
  markFailure,
  markEndpointUnusable,
  markStart,
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
      explain: [{
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'explain-1-key',
        model: 'explain-1-model',
        enabled: true,
      }, {
        baseUrl: 'https://explain-2.example/v1',
        apiKey: 'explain-2-key',
        model: 'explain-2-model',
        enabled: true,
      }],
    },
  }
  const first = pickEndpoint(config, 1000, 'explain')
  assert.equal(first.id, 'explain-1')

  markEndpointUnusable(first.id, 1000)
  const second = pickEndpoint(config, 1001, 'explain')

  assert.equal(second.id, 'explain-2')
})

test('全部端点冷却时半开探测最早恢复的一路', () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        id: 'explain-1', role: 'explain', baseUrl: 'https://explain-1.example/v1',
        apiKey: 'key-1', model: 'model-1', enabled: true,
      }, {
        id: 'explain-2', role: 'explain', baseUrl: 'https://explain-2.example/v1',
        apiKey: 'key-2', model: 'model-2', enabled: true,
      }],
    },
  }
  markEndpointUnusable('explain-1', 1000)
  markEndpointUnusable('explain-2', 2000)
  assert.equal(pickEndpoint(config, 3000, 'explain').id, 'explain-1')
  resetPoolHealthForTests()
})

test('同角色空闲端点轮询使用而不是每次固定命中第一路', () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'explain-1-key',
        model: 'explain-1-model',
        enabled: true,
      }, {
        baseUrl: 'https://explain-2.example/v1',
        apiKey: 'explain-2-key',
        model: 'explain-2-model',
        enabled: true,
      }],
    },
  }

  const first = pickEndpoint(config, 1000, 'explain')
  markSuccess(first.id)
  const second = pickEndpoint(config, 1001, 'explain')

  assert.equal(first.id, 'explain-1')
  assert.equal(second.id, 'explain-2')
})

test('同角色端点采样后优先选择历史响应更快的一路', () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'explain-1-key',
        model: 'explain-1-model',
        enabled: true,
      }, {
        baseUrl: 'https://explain-2.example/v1',
        apiKey: 'explain-2-key',
        model: 'explain-2-model',
        enabled: true,
      }],
    },
  }

  const first = pickEndpoint(config, 1000, 'explain')
  markStart(first.id)
  markSuccess(first.id, 50000)
  markStart(first.id)
  const second = pickEndpoint(config, 1001, 'explain')
  markStart(second.id)
  markSuccess(second.id, 15000)
  markSuccess(first.id, 50000)
  const third = pickEndpoint(config, 1002, 'explain')

  assert.equal(first.id, 'explain-1')
  assert.equal(second.id, 'explain-2')
  assert.equal(third.id, 'explain-2')
})

test('已有成功测速时不为探索空闲慢端点牺牲单任务延迟', () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'explain-1-key',
        model: 'explain-1-model',
        enabled: true,
      }, {
        baseUrl: 'https://explain-2.example/v1',
        apiKey: 'explain-2-key',
        model: 'explain-2-model',
        enabled: true,
      }],
    },
  }

  const first = pickEndpoint(config, 1000, 'explain')
  markSuccess(first.id, 20000)
  const nextIdle = pickEndpoint(config, 1001, 'explain')
  markStart(nextIdle.id)
  const nextBusy = pickEndpoint(config, 1002, 'explain')

  assert.equal(first.id, 'explain-1')
  assert.equal(nextIdle.id, 'explain-1')
  assert.equal(nextBusy.id, 'explain-2')
  markSuccess(nextIdle.id, 20000)
  resetPoolHealthForTests()
})

test('流式请求在响应体消费完成前持续占用端点', async () => {
  const config = {
    roleEndpoints: {
      explain: [{
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
      role: 'explain',
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

test('流式终态失败按连续失败阈值计数，不单次熔断端点', () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        id: 'explain-1',
        role: 'explain',
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'key',
        model: 'model',
        enabled: true,
      }],
    },
  }

  markFailure('explain-1')
  const afterOne = poolStatus(config)[0]
  assert.equal(afterOne.fails, 1)
  assert.equal(afterOne.cooling, false)

  markFailure('explain-1')
  markFailure('explain-1')
  const afterThree = poolStatus(config)[0]
  assert.equal(afterThree.fails, 3)
  assert.equal(afterThree.cooling, true)
  resetPoolHealthForTests()
})

test('深度批量可覆盖端点默认关闭并下发有界推理参数', async () => {
  const config = {
    baseUrl: 'https://main.example/v1',
    apiKey: 'key',
    models: { explain: 'model' },
    reasoning: { explain: false },
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
      role: 'explain',
      reasonFallback: true,
      forceReason: true,
    }, 1)

    assert.equal(sentBody.reasoning_effort, 'medium')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('快速模式显式下发none而不是让网关回退默认深度推理', async () => {
  const config = {
    roleEndpoints: {
      review: [{
        baseUrl: 'https://review.example/v1',
        apiKey: 'key',
        model: 'model',
        reasoning: true,
        enabled: true,
      }],
    },
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
      role: 'review',
      forceNoReason: true,
    }, 1)

    assert.equal(sentBody.reasoning_effort, 'none')
  } finally {
    globalThis.fetch = originalFetch
    resetPoolHealthForTests()
  }
})

test('流式请求在成功响应头前可快速切换备用端点', async () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'key-1',
        model: 'model-1',
        enabled: true,
      }, {
        baseUrl: 'https://explain-2.example/v1',
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
      role: 'explain',
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

test('外层请求仍有效时单端点响应头超时会切换备用端点', async () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'key-1',
        model: 'model-1',
        enabled: true,
      }, {
        baseUrl: 'https://explain-2.example/v1',
        apiKey: 'key-2',
        model: 'model-2',
        enabled: true,
      }],
    },
  }
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url, options) => {
    urls.push(url)
    if (urls.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (options.signal?.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
    }
    return new Response('{}', { status: 200 })
  }
  try {
    const routed = await poolFetch(config, '/chat/completions', {
      body: { model: 'model', stream: true },
      role: 'explain',
      signal: new AbortController().signal,
      timeoutMs: 1000,
      headerTimeoutMs: 250,
      deferSuccess: true,
    }, 2)

    assert.equal(routed.resp.ok, true)
    assert.equal(routed.endpoint.id, 'explain-2')
    assert.equal(urls.length, 2)
    routed.releaseRole()
  } finally {
    globalThis.fetch = originalFetch
    resetPoolHealthForTests()
  }
})

test('备用端点忙碌时保留当前请求而不是切换后重复排队', async () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'key-1',
        model: 'model-1',
        enabled: true,
      }, {
        baseUrl: 'https://explain-2.example/v1',
        apiKey: 'key-2',
        model: 'model-2',
        enabled: true,
      }],
    },
  }
  markStart('explain-2')
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(url)
    await new Promise((resolve) => setTimeout(resolve, 300))
    return new Response('{}', { status: 200 })
  }
  try {
    const routed = await poolFetch(config, '/chat/completions', {
      body: { model: 'model', stream: true },
      role: 'explain',
      signal: new AbortController().signal,
      timeoutMs: 1000,
      headerTimeoutMs: 250,
      deferSuccess: true,
    }, 2)

    assert.equal(routed.resp.ok, true)
    assert.equal(routed.endpoint.id, 'explain-1')
    assert.equal(urls.length, 1)
    routed.releaseRole()
  } finally {
    markSuccess('explain-2')
    globalThis.fetch = originalFetch
    resetPoolHealthForTests()
  }
})

test('等待响应头期间备用端点释放后在总预算内切换', async () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'key-1',
        model: 'model-1',
        enabled: true,
      }, {
        baseUrl: 'https://explain-2.example/v1',
        apiKey: 'key-2',
        model: 'model-2',
        enabled: true,
      }],
    },
  }
  markStart('explain-2')
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url, options) => {
    urls.push(url)
    if (urls.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      if (options.signal?.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
    }
    return new Response('{}', { status: 200 })
  }
  const releaseAlternative = setTimeout(
    () => markSuccess('explain-2'),
    320,
  )
  try {
    const routed = await poolFetch(config, '/chat/completions', {
      body: { model: 'model', stream: true },
      role: 'explain',
      signal: new AbortController().signal,
      timeoutMs: 1000,
      headerTimeoutMs: 100,
      deferSuccess: true,
    }, 2)

    assert.equal(routed.resp.ok, true)
    assert.equal(routed.endpoint.id, 'explain-2')
    assert.equal(urls.length, 2)
    routed.releaseRole()
  } finally {
    clearTimeout(releaseAlternative)
    globalThis.fetch = originalFetch
    resetPoolHealthForTests()
  }
})

test('外层请求取消时不得把同一题切换到备用端点', async () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'key-1',
        model: 'model-1',
        enabled: true,
      }, {
        baseUrl: 'https://explain-2.example/v1',
        apiKey: 'key-2',
        model: 'model-2',
        enabled: true,
      }],
    },
  }
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url, options) => {
    urls.push(url)
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (options.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    return new Response('{}', { status: 200 })
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5)
  try {
    const routed = await poolFetch(config, '/chat/completions', {
      body: { model: 'model', stream: true },
      role: 'explain',
      signal: controller.signal,
      timeoutMs: 1000,
      headerTimeoutMs: 250,
      deferSuccess: true,
    }, 2)

    assert.equal(routed.resp.__err?.name, 'AbortError')
    assert.equal(urls.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    resetPoolHealthForTests()
  }
})

test('外层取消只释放在途，不把端点误记为故障', async () => {
  resetPoolHealthForTests()
  const config = {
    roleEndpoints: {
      explain: [{
        id: 'explain-1',
        role: 'explain',
        baseUrl: 'https://explain-1.example/v1',
        apiKey: 'key-1',
        model: 'model-1',
        enabled: true,
      }],
    },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
      return
    }
    options.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
  const controller = new AbortController()
  const pending = poolFetch(config, '/chat/completions', {
    body: { model: 'model-1', stream: true },
    role: 'explain',
    signal: controller.signal,
    timeoutMs: 1000,
    deferSuccess: true,
  }, 1)
  setTimeout(() => controller.abort(), 5)
  try {
    const routed = await pending
    assert.equal(routed.resp.__err?.name, 'AbortError')
    assert.equal(poolStatus(config)[0].inflight, 0)
    assert.equal(poolStatus(config)[0].fails, 0)
    assert.equal(poolStatus(config)[0].cooling, false)
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

test('上游发送 finish_reason 后不等待缺失的 DONE 帧', async () => {
  const encoder = new TextEncoder()
  const chunks = [encoder.encode(
    'data: {"choices":[{"delta":{"content":"{\\"action\\":\\"持有\\"}"},"finish_reason":"stop"}]}\n\n',
  )]
  let index = 0
  let canceled = false
  const result = await pumpChatStream({
    body: {
      getReader() {
        return {
          async read() {
            if (index++ === 0) return { value: chunks[0], done: false }
            return new Promise((resolve) =>
              setTimeout(() => resolve({ value: undefined, done: true }), 50),
            )
          },
          async cancel() { canceled = true },
        }
      },
    },
  })
  assert.equal(result.content, '{"action":"持有"}')
  assert.equal(result.finishReason, 'stop')
  assert.equal(canceled, true)
})

test('stream 请求被网关降级为普通 JSON 时仍解析正文', async () => {
  const payload = {
    choices: [{
      message: {
        content: '{"action":"持有"}',
        reasoning_content: '已核对证据。',
      },
      finish_reason: 'stop',
    }],
  }
  const result = await pumpChatStream({
    headers: { get: () => 'application/json' },
    body: { getReader() { throw new Error('should use json') } },
    json: async () => payload,
  })
  assert.equal(result.content, payload.choices[0].message.content)
  assert.equal(result.reasoning, payload.choices[0].message.reasoning_content)
})
