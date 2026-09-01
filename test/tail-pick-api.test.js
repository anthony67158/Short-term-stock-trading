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
  rankTailPickNearCandidates,
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

test('实时预筛保留严格公式和接近公式的共同候选', () => {
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
    true,
  )
  assert.equal(
    passesTailPickRealtimePrefilter(
      mapTailPickMarketRow(marketRow({ f8: 3.99 })),
      '2026-08-28',
    ),
    false,
  )
  assert.equal(
    passesTailPickRealtimePrefilter(
      mapTailPickMarketRow(marketRow({
        f15: 10.1,
        f16: 9.5,
        f17: 9.55,
        f2: 10.05,
      })),
      '2026-08-28',
    ),
    true,
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

test('严格公式结果只保留一只首选并把其余候补交给用户判断', () => {
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
    {
      ...base,
      code: '600003',
      name: '丙',
      stockGate: {
        passed: false,
        gain20: 38,
        blockers: ['近20日位置偏高'],
      },
    },
  ], {
    timestamp: beijingTimestamp('2026-08-28T14:51:00'),
  })

  assert.equal(result.decision, 'OBSERVE_ONLY')
  assert.equal(result.primaryCode, '600001')
  assert.equal(result.candidates[0].execution.role, 'PRIMARY')
  assert.equal(result.candidates[1].execution.role, 'ALTERNATE')
  assert.match(result.candidates[1].execution.action, /自行判断/)
  assert.equal(result.candidates.length, 3)
  assert.match(
    result.candidates[2].decisionWarnings.join('；'),
    /近20日位置偏高/,
  )
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

test('接近公式池完整返回并按接近度排序', () => {
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    code: `60000${index}`,
    name: `测试${index}`,
    nearMatch: {
      matched: true,
      matchRate: index === 6 ? 92.9 : 85.7,
      failedRules: index === 6
        ? [{ key: 'AB4', label: '上影线形态' }]
        : [
            { key: 'HSL', label: '换手率大于5%' },
            { key: 'AB4', label: '上影线形态' },
          ],
    },
    stockGate: {
      passed: true,
      gain20: 8,
      evidence: [],
    },
    intraday: { passed: true, price: 10, vwap: 9.96 },
    quote: { price: 10, amount: 100_000_000 + index },
    sectorOpportunity: { matched: true },
    fund: {
      mainNetYi: 0.1,
      retailNetYi: -0.05,
      main5dYi: 0.2,
      historyDayCount: 5,
    },
  }))

  const result = rankTailPickNearCandidates(candidates)

  assert.equal(result.length, 7)
  assert.equal(result[0].code, '600006')
  assert.equal(result[0].execution.role, 'NEAR')
  assert.equal(result[0].execution.maxPositionPct, 0)
  assert.match(result[0].execution.action, /自行判断/)
})

test('接近公式结果全部进入证据补充而不是提前截断', () => {
  const source = readProjectFile('api/_tail_pick_data.js')
  assert.doesNotMatch(source, /nearFormulaMatches\.slice/)
})

test('大盘环境风险只作提示，仍完整扫描并返回公式结果', async () => {
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
    scanCandidates: async () => {
      scanCalls++
      return {
        universe: {
          inspectedCount: 5500,
          formulaMatchCount: 0,
          nearFormulaCount: 1,
        },
        candidates: [],
        nearCandidates: [{
          code: '600001',
          name: '接近公式样本',
          formula: { matched: false, signals: [] },
          nearMatch: {
            matched: true,
            passedCount: 13,
            totalRuleCount: 14,
            matchRate: 92.9,
            failedRules: [{ key: 'AB4', label: '上影线形态' }],
          },
          stockGate: { passed: true, evidence: [], blockers: [] },
          intraday: { passed: true, price: 10, vwap: 9.96 },
          quote: { price: 10, amount: 100_000_000 },
          sectorOpportunity: { matched: true },
          fund: {
            mainNetYi: 0.1,
            retailNetYi: -0.05,
            main5dYi: 0.3,
            historyDayCount: 5,
          },
        }],
      }
    },
  })

  assert.equal(scanCalls, 1)
  assert.equal(result.result.decision, 'NO_TRADE')
  assert.equal(result.result.nearCandidates.length, 1)
  assert.deepEqual(result.marketGate.blockers, ['大盘跌破60日线'])
  assert.equal(savedRun.result.nearCandidates.length, 1)
  assert.equal(tasks.at(-1).status, 'DONE')
})

test('严格公式为空时仍返回独立接近观察池且不生成仓位', async () => {
  let saved = null
  const store = {
    readTask: async () => null,
    claimRun: async () => ({ acquired: true }),
    releaseRun: async () => true,
    saveManualRun: async (value) => { saved = value },
    saveTask: async () => {},
  }
  const nearCandidate = {
    code: '600001',
    name: '接近公式样本',
    formula: { matched: false, signals: [] },
    nearMatch: {
      matched: true,
      passedCount: 13,
      totalRuleCount: 14,
      matchRate: 92.9,
      failedRules: [{ key: 'AB4', label: '上影线形态' }],
    },
    stockGate: {
      passed: false,
      gain20: 8,
      evidence: ['近20日位置正常'],
      blockers: ['尾盘分时检查未通过'],
    },
    intraday: { passed: true, price: 10, vwap: 9.96 },
    quote: { price: 10, amount: 100_000_000 },
    sectorOpportunity: { matched: true },
    fund: {
      mainNetYi: 0.1,
      retailNetYi: -0.05,
      main5dYi: 0.3,
      historyDayCount: 5,
    },
  }

  const result = await runTailPickScan({
    store,
    mode: 'manual',
    now: () => beijingTimestamp('2026-08-26T14:51:00'),
    collectMarketContext: async () => ({
      marketGate: {
        allowed: true,
        maxPositionPct: 5,
        blockers: [],
      },
    }),
    scanCandidates: async () => ({
      universe: {
        inspectedCount: 5500,
        formulaMatchCount: 0,
        nearFormulaCount: 1,
      },
      candidates: [],
      nearCandidates: [nearCandidate],
    }),
  })

  assert.equal(result.result.decision, 'NO_TRADE')
  assert.equal(result.result.candidates.length, 0)
  assert.equal(result.result.nearCandidates.length, 1)
  assert.equal(
    result.result.nearCandidates[0].execution.maxPositionPct,
    0,
  )
  assert.deepEqual(
    result.result.nearCandidates[0].decisionWarnings,
    ['尾盘分时检查未通过'],
  )
  assert.match(result.result.reason, /接近公式.*计算结果/)
  assert.deepEqual(saved, result)
})

test('接近公式候选保留纪律与资金失败项供用户判断', () => {
  const base = {
    code: '600001',
    nearMatch: {
      matched: true,
      matchRate: 92.9,
      failedRules: [{ key: 'AB4', label: '上影线形态' }],
    },
    stockGate: { passed: true, gain20: 8 },
    intraday: { passed: true },
    quote: { amount: 100_000_000 },
    sectorOpportunity: { matched: true },
    fund: {
      mainNetYi: 0.1,
      retailNetYi: -0.05,
      main5dYi: 0.3,
      historyDayCount: 5,
    },
  }

  assert.equal(rankTailPickNearCandidates([base]).length, 1)
  const weakStructure = rankTailPickNearCandidates([{
    ...base,
    stockGate: { passed: false, gain20: 8 },
  }])
  assert.equal(weakStructure.length, 1)
  assert.match(
    weakStructure[0].decisionWarnings.join('；'),
    /个股纪律检查未通过/,
  )
  const weakFund = rankTailPickNearCandidates([{
    ...base,
    fund: {
      mainNetYi: -0.1,
      retailNetYi: 0.1,
      main5dYi: -0.2,
      historyDayCount: 5,
    },
  }])
  assert.equal(weakFund.length, 1)
  assert.match(
    weakFund[0].decisionWarnings.join('；'),
    /主力净流出且小单净流入|近期主力资金净流出/,
  )
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
  assert.deepEqual(state.displayResult, manual)
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
