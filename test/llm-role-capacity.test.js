import test from 'node:test'
import assert from 'node:assert/strict'

import {
  poolFetch,
  resetPoolHealthForTests,
} from '../api/_llm_pool.js'

const config = {
  roleEndpoints: {
    advisor: [{
      id: 'advisor-1',
      role: 'advisor',
      baseUrl: 'https://advisor.example/v1',
      apiKey: 'test-key',
      model: 'advisor-model',
      enabled: true,
    }],
    review: [{
      id: 'review-1',
      role: 'review',
      baseUrl: 'https://review.example/v1',
      apiKey: 'test-key',
      model: 'review-model',
      enabled: true,
    }],
  },
}

const response = () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
})

test('同一角色每个端点最多承接一个在途请求', async () => {
  resetPoolHealthForTests()
  const originalFetch = global.fetch
  const pending = []
  let calls = 0
  global.fetch = async () => {
    calls++
    return new Promise((resolve) => pending.push(resolve))
  }

  try {
    const first = poolFetch(config, '/chat/completions', {
      role: 'advisor',
      body: { model: 'advisor-model' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = poolFetch(config, '/chat/completions', {
      role: 'advisor',
      body: { model: 'advisor-model' },
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

test('advisor与review容量互相独立', async () => {
  resetPoolHealthForTests()
  const originalFetch = global.fetch
  const pending = []
  let calls = 0
  global.fetch = async (url) => {
    calls++
    return new Promise((resolve) => pending.push({ url, resolve }))
  }

  try {
    const advisor = poolFetch(config, '/chat/completions', {
      role: 'advisor',
      body: { model: 'advisor-model' },
    })
    const review = poolFetch(config, '/chat/completions', {
      role: 'review',
      body: { model: 'review-model' },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(calls, 2)
    assert.equal(
      pending.some((item) => item.url.startsWith('https://advisor.example')),
      true,
    )
    assert.equal(
      pending.some((item) => item.url.startsWith('https://review.example')),
      true,
    )
    for (const item of pending.splice(0)) item.resolve(response())
    await Promise.all([advisor, review])
  } finally {
    for (const item of pending.splice(0)) item.resolve(response())
    global.fetch = originalFetch
    resetPoolHealthForTests()
  }
})

test('四个复核请求会同时分散到四个独立端点', async () => {
  resetPoolHealthForTests()
  const originalFetch = global.fetch
  const pending = []
  const urls = []
  const reviewConfig = {
    roleEndpoints: {
      review: Array.from({ length: 4 }, (_, index) => ({
        id: `review-${index + 1}`,
        role: 'review',
        baseUrl: `https://review-${index + 1}.example/v1`,
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
    const requests = Array.from({ length: 4 }, () =>
      poolFetch(reviewConfig, '/chat/completions', {
        role: 'review',
        body: { model: 'review-model' },
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(urls.length, 4)
    assert.equal(new Set(urls).size, 4)
    for (const resolve of pending.splice(0)) resolve(response())
    await Promise.all(requests)
  } finally {
    for (const resolve of pending.splice(0)) resolve(response())
    global.fetch = originalFetch
    resetPoolHealthForTests()
  }
})
