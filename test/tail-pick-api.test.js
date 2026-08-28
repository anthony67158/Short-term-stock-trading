import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchTailPickRealtimePool,
  mapTailPickMarketRow,
  parseTailPickIndexCandles,
  passesTailPickRealtimePrefilter,
} from '../api/_tail_pick_data.js'
import {
  createTailPickStore,
} from '../api/_tail_pick_store.js'
import {
  projectTailPickLiveStatus,
  readTailPickState,
  runTailPickScan,
} from '../api/tail_pick.js'
import {
  rankTailPickCandidates,
} from '../shared/tailPickRanking.js'

function beijingTimestamp(text) {
  return new Date(`${text}+08:00`).getTime()
}

function marketRow(patch = {}) {
  return {
    f12: '600001',
    f14: '测试股份',
    f2: 9.82,
    f3: 3.37,
    f5: 2000,
    f6: 120_000_000,
    f8: 6,
    f15: 10,
    f16: 9.5,
    f17: 9.55,
    f18: 9.5,
    f62: 20_000_000,
    f184: 8,
    f124: 1787909400,
    ...patch,
  }
}

test('实时预筛只保留可能满足原公式的股票', () => {
  const accepted = mapTailPickMarketRow(marketRow())
  assert.equal(passesTailPickRealtimePrefilter(accepted), true)
  assert.equal(
    passesTailPickRealtimePrefilter(
      mapTailPickMarketRow(marketRow({ f8: 4.9 })),
    ),
    false,
  )
  assert.equal(
    passesTailPickRealtimePrefilter(
      mapTailPickMarketRow(marketRow({ f14: 'ST测试' })),
    ),
    false,
  )
})

test('按涨幅倒序读取市场页面并在2.4%边界停止', async () => {
  const pages = [
    { data: { total: 250, diff: [marketRow()] } },
    {
      data: {
        total: 250,
        diff: [
          marketRow({ f12: '600002', f3: 2.5 }),
          marketRow({ f12: '600003', f3: 2.4 }),
        ],
      },
    },
  ]
  let calls = 0
  const result = await fetchTailPickRealtimePool({
    fetchPage: async (page) => {
      calls++
      return pages[page - 1]
    },
  })

  assert.equal(calls, 2)
  assert.equal(result.inspectedCount, 3)
  assert.deepEqual(
    result.list.map((item) => item.code),
    ['600001', '600002'],
  )
})

test('指数K线按东财字段顺序解析', () => {
  const candles = parseTailPickIndexCandles([
    ['2026-08-28', '10', '10.2', '10.3', '9.9', '12345'],
  ])
  assert.deepEqual(candles[0], {
    date: '2026-08-28',
    open: 10,
    close: 10.2,
    high: 10.3,
    low: 9.9,
    volume: 12345,
  })
})

test('排序最多输出一只首选并保持候补不可买', () => {
  const base = {
    formula: { matched: true, signals: [] },
    stockGate: { passed: true, gain20: 8, evidence: [] },
    intraday: { passed: true, price: 10, vwap: 9.96 },
    quote: { price: 10, low: 9.5, amount: 100_000_000 },
    sectorOpportunity: {
      sector: { nextScore: 70 },
      stock: { score: 68 },
    },
    fund: {
      mainNetYi: 0.2,
      retailNetYi: -0.1,
      main5dYi: 0.6,
      historyDayCount: 5,
    },
  }
  const result = rankTailPickCandidates([
    { ...base, code: '600001', name: '甲' },
    {
      ...base,
      code: '600002',
      name: '乙',
      sectorOpportunity: {
        sector: { nextScore: 60 },
        stock: { score: 55 },
      },
    },
  ], {
    timestamp: beijingTimestamp('2026-08-28T14:51:00'),
  })

  assert.equal(result.decision, 'OBSERVE_ONLY')
  assert.equal(result.primaryCode, '600001')
  assert.equal(result.candidates[0].execution.role, 'PRIMARY')
  assert.equal(result.candidates[1].execution.role, 'ALTERNATE')
  assert.match(result.candidates[1].execution.action, /不买/)
})

test('扫描任务在大盘闸门失败时直接保存不开仓结果', async () => {
  let savedRun = null
  let scanCalls = 0
  const tasks = []
  const store = {
    readRun: async () => null,
    claimRun: async () => ({ acquired: true }),
    releaseRun: async () => true,
    saveRun: async (value) => { savedRun = value },
    saveTask: async (value) => { tasks.push(value) },
  }
  const result = await runTailPickScan({
    store,
    now: () => beijingTimestamp('2026-08-27T14:51:00'),
    collectMarketContext: async () => ({
      marketGate: {
        allowed: false,
        label: '今日不开仓',
        reasons: [],
        blockers: ['大盘跌破60日线'],
      },
    }),
    scanCandidates: async () => { scanCalls++; return null },
  })

  assert.equal(scanCalls, 0)
  assert.equal(result.result.decision, 'NO_TRADE')
  assert.equal(savedRun.result.reason, '大盘跌破60日线')
  assert.equal(tasks.at(-1).status, 'DONE')
})

test('存储适配器对同一交易日读取同一正式结果', async () => {
  const objects = new Map()
  const storage = {
    hasStorage: () => true,
    put: async (path, body) => { objects.set(path, JSON.parse(body)) },
    readJson: async (path) => objects.get(path) || null,
    del: async (path) => { objects.delete(path) },
  }
  const store = createTailPickStore(storage)
  const result = {
    session: { tradeDate: '2026-08-28' },
    result: { decision: 'NO_TRADE' },
  }
  await store.saveRun(result)

  assert.deepEqual(await store.readRun('2026-08-28'), result)
  assert.deepEqual(await store.readLatest(), result)
  const state = await readTailPickState({
    store,
    timestamp: beijingTimestamp('2026-08-28T14:56:00'),
  })
  assert.deepEqual(state.currentResult, result)
  assert.equal(state.session.label, '查看尾盘结果')
})

test('14:55后旧执行指令统一失效，不能继续追买', async () => {
  const result = await projectTailPickLiveStatus({
    session: { tradeDate: '2026-08-28' },
    result: {
      candidates: [{
        code: '600001',
        execution: { action: '原执行指令' },
      }],
    },
  }, {
    timestamp: beijingTimestamp('2026-08-28T14:55:00'),
  })

  assert.equal(
    result.result.candidates[0].liveStatus,
    'WINDOW_CLOSED',
  )
  assert.match(
    result.result.candidates[0].execution.action,
    /不再买入/,
  )
})

test('运行窗口内分时跌破纪律后立即改为放弃买入', async () => {
  const result = await projectTailPickLiveStatus({
    session: { tradeDate: '2026-08-28' },
    result: {
      candidates: [{
        code: '600001',
        execution: { action: '原执行指令' },
      }],
    },
  }, {
    timestamp: beijingTimestamp('2026-08-28T14:52:00'),
    fetchTrends: async () => ({
      trends: Array.from({ length: 10 }, (_, index) => ({
        time: `14:${String(43 + index).padStart(2, '0')}`,
        price: index === 9 ? 9.7 : 10,
        avg: 9.9,
        volume: index === 9 ? 1000 : 100,
      })),
    }),
  })

  assert.equal(result.result.candidates[0].liveStatus, 'ABANDON')
  assert.match(
    result.result.candidates[0].execution.action,
    /放弃买入/,
  )
})
