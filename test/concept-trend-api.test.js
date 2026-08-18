import test from 'node:test'
import assert from 'node:assert/strict'

import {
  conceptIntradayFromPayload,
  conceptCloseHistoryFromPayload,
  fetchLongestKlinePayload,
  resolveConceptHistoryResponse,
  conceptKlineFromPayload,
  conceptKlinePeriod,
} from '../api/sector_history.js'

test('概念分时 API 响应固定声明真实来源、交易日和汇总', () => {
  const response = conceptIntradayFromPayload({
    data: {
      code: 'BK1128',
      name: 'CPO概念',
      preClose: 100,
      trends: [
        '2026-08-14 09:30,101,101,101,101,10,1000,101',
        '2026-08-14 15:00,103,104,104,103,20,2000,102',
      ],
    },
  }, 'BK1128', 123456)

  assert.equal(response.ok, true)
  assert.equal(response.mode, 'intraday')
  assert.equal(response.code, 'BK1128')
  assert.equal(response.name, 'CPO概念')
  assert.equal(response.tradingDate, '2026-08-14')
  assert.equal(response.updatedAt, 123456)
  assert.equal(response.source, '东方财富概念板块行情')
  assert.equal(response.points.length, 2)
  assert.deepEqual(response.summary, {
    latest: 104,
    pct: 4,
    high: 104,
    low: 101,
    amplitude: 3,
    volume: 30,
    amount: 3000,
    lastTime: '15:00',
  })
})

test('概念历史API仅接受日周月并返回稳定周期契约', () => {
  assert.deepEqual(conceptKlinePeriod('day'), {
    period: 'day',
    klt: 101,
    limit: 120,
  })
  assert.deepEqual(conceptKlinePeriod('week'), {
    period: 'week',
    klt: 102,
    limit: 104,
  })
  assert.deepEqual(conceptKlinePeriod('month'), {
    period: 'month',
    klt: 103,
    limit: 60,
  })
  assert.deepEqual(conceptKlinePeriod('bad'), {
    period: 'day',
    klt: 101,
    limit: 120,
  })
})

test('概念历史API响应声明周期、来源和完整K线点', () => {
  const response = conceptKlineFromPayload({
    data: {
      code: 'BK1128',
      name: 'CPO概念',
      klines: [
        '2026-08-13,100,103,104,99,1200,3000000,5,3,3,1.2',
        '2026-08-14,103,102,105,101,1600,4200000,3.88,-0.97,-1,1.45',
      ],
    },
  }, 'BK1128', 'week', 123456)

  assert.equal(response.ok, true)
  assert.equal(response.mode, 'kline')
  assert.equal(response.period, 'week')
  assert.equal(response.code, 'BK1128')
  assert.equal(response.source, '东方财富概念板块历史行情')
  assert.equal(response.updatedAt, 123456)
  assert.equal(response.points.length, 2)
  assert.equal(response.summary.lastDate, '2026-08-14')
})

test('概念历史K线为空时返回明确的真实收盘趋势格式', () => {
  const response = conceptCloseHistoryFromPayload({
    data: {
      code: 'BK1106',
      name: '创新药',
      klines: [
        '2026-08-13,10,0,0,0,0,1,0,0,0,0,1500,1',
        '2026-08-14,20,0,0,0,0,2,0,0,0,0,1538.39,2.56',
      ],
    },
  }, 'BK1106', 'day', 123456)

  assert.equal(response.ok, true)
  assert.equal(response.mode, 'kline')
  assert.equal(response.format, 'close-line')
  assert.equal(response.source, '东方财富概念板块历史收盘与资金行情')
  assert.equal(response.points.length, 2)
  assert.equal(response.updatedAt, 123456)
})

test('历史镜像少于两个交易日时自动重试并选择最长序列', async () => {
  let calls = 0
  const full = {
    data: {
      klines: ['2026-08-13,a', '2026-08-14,b'],
    },
  }
  const result = await fetchLongestKlinePayload('/path', {
    rounds: 2,
    minRows: 2,
    fetchAllImpl: async () => {
      calls++
      return calls === 1
        ? [{ data: { klines: ['2026-08-14,b'] } }]
        : [full]
    },
  })

  assert.equal(calls, 2)
  assert.equal(result, full)
})

test('概念历史成功时写缓存，上游空时读取最近成功缓存', async () => {
  const live = {
    ok: true,
    code: 'BK1106',
    period: 'day',
    points: [{ date: '2026-08-13' }, { date: '2026-08-14' }],
  }
  let stored = null
  const first = await resolveConceptHistoryResponse(live, {
    writeCache: async (_key, value) => { stored = value },
    readCache: async () => null,
  })
  const fallback = await resolveConceptHistoryResponse({
    ...live,
    points: [],
  }, {
    writeCache: async () => {},
    readCache: async () => stored,
  })

  assert.equal(first.cacheState, 'live')
  assert.equal(first.cacheStored, true)
  assert.equal(stored.points.length, 2)
  assert.equal(fallback.cacheState, 'cached')
  assert.equal(fallback.cacheStored, true)
  assert.equal(fallback.points.length, 2)
})
