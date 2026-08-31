import test from 'node:test'
import assert from 'node:assert/strict'

import {
  KLINE_FRESH_CACHE_MS,
  createResilientKlineFetcher,
} from '../api/stock_detail.js'
import stockDetailHandler from '../api/stock_detail.js'

function candles(count = 180) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-08-${String((index % 28) + 1).padStart(2, '0')}`,
    open: 10 + index / 100,
    close: 10.05 + index / 100,
    high: 10.1 + index / 100,
    low: 9.95 + index / 100,
    volume: 1000 + index,
    amount: 100_000 + index,
    pct: 0.5,
  }))
}

test('腾讯返回501时公式与详情K线自动切换其他行情源', async () => {
  const load = createResilientKlineFetcher({
    fetchTencent: async () => {
      throw new Error('HTTP 501')
    },
    fetchEastmoney: async () => ({
      name: '测试股票',
      candles: candles(),
      source: 'eastmoney',
    }),
    fetchSina: async () => {
      throw new Error('sina unavailable')
    },
  })

  const result = await load('002230', '101', 80)
  assert.equal(result.source, 'eastmoney')
  assert.equal(result.candles.length, 80)
})

test('东财和腾讯同时失败时日K回退新浪独立数据源', async () => {
  const load = createResilientKlineFetcher({
    fetchTencent: async () => {
      throw new Error('HTTP 501')
    },
    fetchEastmoney: async () => {
      throw new Error('empty klines')
    },
    fetchSina: async () => ({
      name: '测试股票',
      candles: candles(),
      source: 'sina',
    }),
  })

  const result = await load('002230', '101', 120)
  assert.equal(result.source, 'sina')
  assert.equal(result.candles.length, 120)
})

test('较快但残缺的数据源不会覆盖稍后返回的完整K线', async () => {
  const load = createResilientKlineFetcher({
    fetchTencent: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        name: '测试股票',
        candles: candles(200),
      }
    },
    fetchEastmoney: async () => ({
      name: '测试股票',
      candles: candles(160),
    }),
    fetchSina: async () => {
      throw new Error('sina unavailable')
    },
  })

  const result = await load('002230', '101', 120)
  assert.equal(result.source, 'tencent')
  assert.equal(result.candles.length, 120)
})

test('实时行情源全部失败时使用最近成功K线而不是返回空数组', async () => {
  let now = 1000
  let fail = false
  const load = createResilientKlineFetcher({
    now: () => now,
    fetchTencent: async () => {
      if (fail) throw new Error('HTTP 501')
      return {
        name: '测试股票',
        candles: candles(),
        source: 'tencent',
      }
    },
    fetchEastmoney: async () => {
      throw new Error('eastmoney unavailable')
    },
    fetchSina: async () => {
      throw new Error('sina unavailable')
    },
  })

  const fresh = await load('002230', '101', 120)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.fetchedAt, 1000)
  fail = true
  now += KLINE_FRESH_CACHE_MS + 1
  const fallback = await load('002230', '101', 120)
  assert.equal(fallback.stale, true)
  assert.equal(fallback.fetchedAt, 1000)
  assert.equal(fallback.candles.length, 120)
})

test('冷实例所有行情源失败时返回空结果而不是成功快照', async () => {
  const fail = () => {
    throw new Error('HTTP 501')
  }
  const load = createResilientKlineFetcher({
    fetchTencent: fail,
    fetchEastmoney: fail,
    fetchSina: fail,
  })

  assert.equal(await load('002230', '101', 120), null)
})

test('详情接口不会把全源失败的空K线响应标记为成功', async () => {
  const originalFetch = globalThis.fetch
  let status = 0
  let payload = null
  globalThis.fetch = async () => new Response('', { status: 501 })
  const response = {
    setHeader() {},
    status(value) {
      status = value
      return this
    },
    send(value) {
      payload = JSON.parse(value)
    },
  }
  try {
    await stockDetailHandler({
      query: {
        code: '002230',
        klt: '101',
        lmt: '120',
        trends: '1',
        quote: '1',
      },
    }, response)
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(status, 200)
  assert.deepEqual(payload, {
    ok: false,
    error: '行情数据暂时不可用，请稍后重试',
    errorCode: 'KLINE_UNAVAILABLE',
  })
})

test('详情和公式同时请求同股K线时合并为一组上游调用', async () => {
  let calls = 0
  const load = createResilientKlineFetcher({
    fetchTencent: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        name: '测试股票',
        candles: candles(),
        source: 'tencent',
      }
    },
    fetchEastmoney: async () => {
      throw new Error('eastmoney unavailable')
    },
    fetchSina: async () => {
      throw new Error('sina unavailable')
    },
  })

  const [formula, detail] = await Promise.all([
    load('002230', '101', 80),
    load('002230', '101', 120),
  ])
  assert.equal(calls, 1)
  assert.equal(formula.candles.length, 80)
  assert.equal(detail.candles.length, 120)
})
