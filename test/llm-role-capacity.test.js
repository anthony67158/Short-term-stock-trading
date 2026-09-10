import test from 'node:test'
import assert from 'node:assert/strict'

import {
  poolFetch,
  resetPoolHealthForTests,
} from '../api/_llm_pool.js'

const response = () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
})

const onePerRole = {
  roleEndpoints: {
    explain: [{
      baseUrl: 'https://explain.example/v1',
      apiKey: 'test-key',
      model: 'explain-model',
      enabled: true,
    }],
    assistant: [{
      baseUrl: 'https://assistant.example/v1',
      apiKey: 'test-key',
      model: 'assistant-model',
      enabled: true,
    }],
  },
}

test('同一解释端点最多承接一个在途请求', async () => {
  resetPoolHealthForTests()
  const originalFetch = global.fetch
  const pending = []
  let calls = 0
  global.fetch = async () => {
    calls++
    return new Promise((resolve) => pending.push(resolve))
  }

  try {
    const first = poolFetch(onePerRole, '/chat/completions', {
      role: 'explain',
      body: { model: 'explain-model' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = poolFetch(onePerRole, '/chat/completions', {
      role: 'explain',
      body: { model: 'explain-model' },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(calls, 1)
    pending.shift()(response())
    await first
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls, 2)
    pending.shift()(response())
    await second
  } finally {
    for (const resolve of pending.splice(0)) resolve(response())
    global.fetch = originalFetch
    resetPoolHealthForTests()
  }
})

test('解释与助手容量互相独立', async () => {
  resetPoolHealthForTests()
  const originalFetch = global.fetch
  const pending = []
  const urls = []
  global.fetch = async (url) => {
    urls.push(url)
    return new Promise((resolve) => pending.push(resolve))
  }

  try {
    const explain = poolFetch(onePerRole, '/chat/completions', {
      role: 'explain',
      body: { model: 'explain-model' },
    })
    const assistant = poolFetch(onePerRole, '/chat/completions', {
      role: 'assistant',
      body: { model: 'assistant-model' },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(urls.length, 2)
    assert.ok(urls.some((url) =>
      url.startsWith('https://explain.example')))
    assert.ok(urls.some((url) =>
      url.startsWith('https://assistant.example')))
    for (const resolve of pending.splice(0)) resolve(response())
    await Promise.all([explain, assistant])
  } finally {
    for (const resolve of pending.splice(0)) resolve(response())
    global.fetch = originalFetch
    resetPoolHealthForTests()
  }
})

test('两路解释请求分散到两个解释端点', async () => {
  resetPoolHealthForTests()
  const originalFetch = global.fetch
  const pending = []
  const urls = []
  const config = {
    roleEndpoints: {
      explain: Array.from({ length: 2 }, (_, index) => ({
        baseUrl: `https://explain-${index + 1}.example/v1`,
        apiKey: `key-${index + 1}`,
        model: `model-${index + 1}`,
        enabled: true,
      })),
    },
  }
  global.fetch = async (url) => {
    urls.push(url)
    return new Promise((resolve) => pending.push(resolve))
  }

  try {
    const requests = Array.from({ length: 2 }, () =>
      poolFetch(config, '/chat/completions', {
        role: 'explain',
        body: { model: 'explain-model' },
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(urls.length, 2)
    assert.equal(new Set(urls).size, 2)
    for (const resolve of pending.splice(0)) resolve(response())
    await Promise.all(requests)
  } finally {
    for (const resolve of pending.splice(0)) resolve(response())
    global.fetch = originalFetch
    resetPoolHealthForTests()
  }
})
