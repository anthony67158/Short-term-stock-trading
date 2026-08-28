import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

const readProjectFile = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

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

function marketRows(startCode, count, patchForIndex = () => ({})) {
  return Array.from({ length: count }, (_, index) =>
    marketRow({
      f12: String(startCode + index).padStart(6, '0'),
      f3: 0,
      ...patchForIndex(index),
    })
  )
}

test('实时预筛只保留可能满足原公式的股票', () => {
  const accepted = mapTailPickMarketRow(marketRow())
  assert.equal(
    passesTailPickRealtimePrefilter(accepted, '2026-08-28'),
    true,
  )
  assert.equal(
    passesTailPickRealtimePrefilter(
      mapTailPickMarketRow(marketRow({ f8: 4.9 })),
      '2026-08-28',
    ),
    false,
  )
  assert.equal(
    passesTailPickRealtimePrefilter(
      mapTailPickMarketRow(marketRow({ f14: 'ST测试' })),
      '2026-08-28',
    ),
    false,
  )
  assert.equal(
    passesTailPickRealtimePrefilter(
      mapTailPickMarketRow(marketRow({ f124: null })),
      '2026-08-28',
    ),
    false,
  )
})

test('FC在14:50自动运行正式扫描并于14:52仅作失败重试', () => {
  const schedule = readProjectFile('s.yaml')
  const server = readProjectFile('server.js')
  assert.match(schedule, /triggerName: tail-pick-1450-timer/)
  assert.match(
    schedule,
    /cronExpression: "CRON_TZ=Asia\/Shanghai 0 50,52 14 \* \* 1-5"/,
  )
  assert.match(server, /tailPickTimerBody/)
  assert.match(server, /\? 'tail_pick'/)
})

test('按代码稳定分页读取完整股票池后再执行公式预筛', async () => {
  const pages = [
    {
      data: {
        total: 201,
        diff: marketRows(
          600001,
          100,
          (index) => index === 0 ? { f3: 3 } : {},
        ),
      },
    },
    {
      data: {
        total: 201,
        diff: marketRows(
          600101,
          100,
          (index) => index === 0 ? { f3: 2.5 } : {},
        ),
      },
    },
    {
      data: {
        total: 201,
        diff: marketRows(600201, 1),
      },
    },
  ]
  let calls = 0
  const result = await fetchTailPickRealtimePool({
    now: beijingTimestamp('2026-08-28T14:50:00'),
    fetchPage: async (page) => {
      calls++
      return pages[page - 1]
    },
  })

  assert.equal(calls, 3)
  assert.equal(result.total, 201)
  assert.equal(result.pagesRead, 3)
  assert.equal(result.inspectedCount, 201)
  assert.deepEqual(
    result.list.map((item) => item.code),
    ['600001', '600101'],
  )
})

test('任一分页数量不足时拒绝伪装成全量股票池', async () => {
  await assert.rejects(
    fetchTailPickRealtimePool({
      now: beijingTimestamp('2026-08-28T14:50:00'),
      fetchPage: async (page) => ({
        data: {
          total: 201,
          diff: page === 1
            ? marketRows(600001, 100)
            : page === 2
              ? marketRows(600101, 99)
              : marketRows(600201, 1),
        },
      }),
    }),
    /第2页不完整/,
  )
})

test('指数K线按腾讯字段顺序解析', () => {
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

test('结构性震荡档把首选总仓位从5%收紧到3%', () => {
  const candidate = {
    code: '600001',
    name: '测试股份',
    formula: { matched: true, signals: [] },
    stockGate: { passed: true, gain20: 8, evidence: [] },
    intraday: { passed: true, price: 10, vwap: 9.96 },
    quote: { price: 10, low: 9.5, amount: 100_000_000 },
    sectorOpportunity: {
      sector: { nextScore: 70 },
      stock: { score: 68 },
    },
  }
  const result = rankTailPickCandidates([candidate], {
    timestamp: beijingTimestamp('2026-08-28T14:51:00'),
    maxPositionPct: 3,
  })

  assert.equal(result.candidates[0].execution.maxPositionPct, 3)
  assert.match(result.candidates[0].execution.firstLeg, /最多2%/)
  assert.match(result.candidates[0].execution.secondLeg, /最多1%/)
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
    mode: 'scheduled',
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

test('手动试算可在14:50前运行且不会写入正式结果', async () => {
  let formalWrites = 0
  let manualResult = null
  const store = {
    readRun: async () => null,
    claimRun: async () => ({ acquired: true }),
    releaseRun: async () => true,
    saveRun: async () => { formalWrites++ },
    saveManualRun: async (value) => { manualResult = value },
    saveTask: async () => {},
  }
  const result = await runTailPickScan({
    store,
    mode: 'manual',
    now: () => beijingTimestamp('2026-08-28T10:30:00'),
    collectMarketContext: async () => ({
      marketGate: {
        allowed: false,
        label: '今日不开仓',
        reasons: [],
        blockers: ['手动试算环境不通过'],
      },
    }),
  })

  assert.equal(formalWrites, 0)
  assert.equal(manualResult.session.mode, 'manual')
  assert.equal(manualResult.session.isFormal, false)
  assert.equal(result.result.decision, 'NO_TRADE')
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
    session: {
      tradeDate: '2026-08-28',
      dataAsOf: beijingTimestamp('2026-08-28T14:50:00'),
    },
    result: { decision: 'NO_TRADE' },
  }
  await store.saveRun(result)
  const manual = {
    session: {
      tradeDate: '2026-08-28',
      mode: 'manual',
      dataAsOf: beijingTimestamp('2026-08-28T16:00:00'),
    },
    result: { decision: 'NO_TRADE' },
  }
  await store.saveManualRun(manual)

  assert.deepEqual(await store.readRun('2026-08-28'), result)
  assert.deepEqual(await store.readLatest(), result)
  assert.deepEqual(await store.readManualLatest(), manual)
  const state = await readTailPickState({
    store,
    timestamp: beijingTimestamp('2026-08-28T14:56:00'),
  })
  assert.deepEqual(state.currentResult, result)
  assert.equal(state.session.label, '手动复盘')
  assert.deepEqual(state.displayResult, result)
})

test('手动与定时扫描共用跨实例活动锁且旧owner不能释放新锁', async () => {
  const objects = new Map()
  const storage = {
    hasStorage: () => true,
    put: async (path, body, options = {}) => {
      if (options.forbidOverwrite && objects.has(path)) {
        const error = new Error('exists')
        error.status = 409
        throw error
      }
      objects.set(path, JSON.parse(body))
    },
    readJson: async (path) => objects.get(path) || null,
    del: async (path) => { objects.delete(path) },
  }
  const store = createTailPickStore(storage)
  const first = await store.claimRun(
    '2026-08-28',
    beijingTimestamp('2026-08-28T14:50:00'),
    'manual',
  )
  const blocked = await store.claimRun(
    '2026-08-28',
    beijingTimestamp('2026-08-28T14:50:30'),
    'scheduled',
  )

  assert.equal(first.acquired, true)
  assert.equal(blocked.acquired, false)
  assert.equal(
    await store.releaseRun({ ...first, owner: 'wrong-owner' }),
    false,
  )
  assert.equal(await store.releaseRun(first), true)
  assert.equal((await store.claimRun(
    '2026-08-28',
    beijingTimestamp('2026-08-28T14:52:00'),
    'scheduled',
  )).acquired, true)
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
