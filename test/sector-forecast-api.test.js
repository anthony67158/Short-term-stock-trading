import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SECTOR_FORECAST_SETTINGS,
  createSectorForecastStore,
  dueSectorForecastSession,
  normalizeSectorForecastSettings,
} from '../api/_sector_forecast_store.js'
import {
  buildSectorForecastSnapshot,
  sectorProbabilityScore,
  selectSectorForecastUniverse,
} from '../api/_sector_forecast_data.js'
import {
  enrichSectorForecastSnapshot,
} from '../api/_sector_forecast_llm.js'
import {
  fetchSectorQuantPredictions,
} from '../api/_sector_quant.js'
import {
  getReasoning,
  ROLES,
} from '../api/_llm_config.js'
import {
  default as sectorForecastHandler,
  generateSectorForecastSnapshot,
  mergeOvernightEvidence,
  runDueSectorForecast,
  runSectorForecastGeneration,
} from '../api/sector_forecast.js'

function memoryStorage(initial = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  )
  return {
    values,
    hasStorage: () => true,
    async readJson(path) {
      const value = values.get(path)
      return value == null ? null : JSON.parse(value)
    },
    async put(path, body, options = {}) {
      if (options.forbidOverwrite && values.has(path)) {
        const error = new Error('object already exists')
        error.status = 409
        throw error
      }
      values.set(path, String(body))
      return { pathname: path }
    },
    async del(path) {
      values.delete(path)
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      return {
        blobs: [...values.keys()]
          .filter((path) => path.startsWith(prefix))
          .slice(0, limit)
          .map((pathname) => ({ pathname })),
      }
    },
  }
}

test('板块前瞻默认自动运行并严格限制收盘与盘前时间范围', () => {
  assert.deepEqual(DEFAULT_SECTOR_FORECAST_SETTINGS, {
    autoEnabled: true,
    closeTime: '15:10',
    overnightEnabled: true,
    overnightTime: '08:50',
  })
  assert.deepEqual(normalizeSectorForecastSettings({
    autoEnabled: false,
    closeTime: '16:20',
    overnightEnabled: false,
    overnightTime: '07:30',
  }), {
    autoEnabled: false,
    closeTime: '16:20',
    overnightEnabled: false,
    overnightTime: '07:30',
  })
  assert.throws(
    () => normalizeSectorForecastSettings({ closeTime: '14:59' }),
    /收盘任务时间/,
  )
  assert.throws(
    () => normalizeSectorForecastSettings({ overnightTime: '09:30' }),
    /盘前任务时间/,
  )
})

test('到期判断使用北京时间且开关关闭后不产生付费任务', () => {
  const closeNow = Date.parse('2026-08-20T07:10:00.000Z')
  const overnightNow = Date.parse('2026-08-20T00:50:00.000Z')

  assert.equal(
    dueSectorForecastSession(closeNow, DEFAULT_SECTOR_FORECAST_SETTINGS, {}),
    'close',
  )
  assert.equal(
    dueSectorForecastSession(overnightNow, DEFAULT_SECTOR_FORECAST_SETTINGS, {}),
    'overnight',
  )
  assert.equal(
    dueSectorForecastSession(closeNow, {
      ...DEFAULT_SECTOR_FORECAST_SETTINGS,
      autoEnabled: false,
    }, {}),
    null,
  )
  assert.equal(
    dueSectorForecastSession(overnightNow, {
      ...DEFAULT_SECTOR_FORECAST_SETTINGS,
      overnightEnabled: false,
    }, {}),
    null,
  )
  assert.equal(
    dueSectorForecastSession(closeNow, DEFAULT_SECTOR_FORECAST_SETTINGS, {
      completed: { '2026-08-20:close': true },
    }),
    null,
  )
})

test('市场级快照与设置使用独立OSS前缀并可读取历史摘要', async () => {
  const storage = memoryStorage()
  const store = createSectorForecastStore(storage)
  const snapshot = {
    schemaVersion: 'sector-forecast.v1',
    signalDate: '2026-08-20',
    session: 'close',
    generatedAt: 1787209800000,
    sectors: [{ code: 'BK1000', rank: 1 }],
  }

  await store.saveSettings({ closeTime: '15:30' }, 100)
  await store.saveSnapshot(snapshot)

  assert.equal((await store.readSettings()).closeTime, '15:30')
  assert.deepEqual(await store.readLatest(), snapshot)
  assert.deepEqual(await store.readHistory(5), [{
    signalDate: '2026-08-20',
    session: 'close',
    generatedAt: 1787209800000,
    sectorCount: 1,
  }])
  assert.ok(
    [...storage.values.keys()].every((path) =>
      path.startsWith('market/sector-forecast/')
    ),
  )
})

test('盘前证据复核只更新解释和证据不得改变确定性排名', () => {
  const base = {
    signalDate: '2026-08-19',
    session: 'close',
    sectors: [{
      code: 'BK1000',
      rank: 1,
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
      forecast: {
        next: { score: 78 },
        week: { score: 74 },
      },
      explanation: { whyNow: '收盘版', evidence: [] },
    }],
  }
  const refreshed = mergeOvernightEvidence(base, [{
    code: 'BK1000',
    rank: 99,
    phase: 'RETREAT',
    actionability: 'AVOID',
    whyNow: '隔夜新增催化',
    evidence: [{ title: '政策更新', source: '公开检索' }],
  }], 200)

  assert.equal(refreshed.session, 'overnight')
  assert.equal(refreshed.baseSession, 'close')
  assert.equal(refreshed.evidenceUpdatedAt, 200)
  assert.equal(refreshed.sectors[0].rank, 1)
  assert.equal(refreshed.sectors[0].phase, 'ACCUMULATION')
  assert.equal(refreshed.sectors[0].actionability, 'LAYOUT')
  assert.equal(refreshed.sectors[0].forecast.next.score, 78)
  assert.equal(refreshed.sectors[0].explanation.whyNow, '隔夜新增催化')
})

test('同进程同场次并发生成合并为一次并持久化完成标记', async () => {
  const storage = memoryStorage()
  const store = createSectorForecastStore(storage)
  let generated = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const generate = async () => {
    generated += 1
    await gate
    return {
      schemaVersion: 'sector-forecast.v1',
      signalDate: '2026-08-20',
      session: 'close',
      generatedAt: 300,
      sectors: [{ code: 'BK1000', rank: 1 }],
    }
  }

  const first = runSectorForecastGeneration({
    store,
    session: 'close',
    signalDate: '2026-08-20',
    generate,
    now: () => 300,
  })
  const second = runSectorForecastGeneration({
    store,
    session: 'close',
    signalDate: '2026-08-20',
    generate,
    now: () => 300,
  })
  release()

  const [left, right] = await Promise.all([first, second])
  assert.equal(generated, 1)
  assert.deepEqual(left.snapshot, right.snapshot)
  assert.equal((await store.readTask()).completed['2026-08-20:close'], true)
})

test('同场次OSS原子锁阻止跨FC实例重复生成且失败可释放', async () => {
  const storage = memoryStorage()
  const firstStore = createSectorForecastStore(storage)
  const secondStore = createSectorForecastStore(storage)

  const first = await firstStore.claimRun(
    '2026-08-20:close',
    1787209800000,
  )
  const second = await secondStore.claimRun(
    '2026-08-20:close',
    1787209800000,
  )

  assert.equal(first.acquired, true)
  assert.equal(second.acquired, false)
  await firstStore.releaseRun(first)
  assert.equal(
    (await secondStore.claimRun(
      '2026-08-20:close',
      1787209800000,
    )).acquired,
    true,
  )
})

test('候选初筛保留资金强但价格未启动的潜伏板块', () => {
  const selected = selectSectorForecastUniverse([
    {
      code: 'BK1000',
      name: '潜伏方向',
      pct: 0.2,
      mainInflow: 900e6,
      mainRatio: 8,
      amount: 30e9,
    },
    {
      code: 'BK1001',
      name: '当日热点',
      pct: 8.5,
      mainInflow: 1000e6,
      mainRatio: 8.5,
      amount: 35e9,
    },
    {
      code: 'BK1002',
      name: '弱势方向',
      pct: -3,
      mainInflow: -500e6,
      mainRatio: -6,
      amount: 10e9,
    },
  ], 2)

  assert.deepEqual(
    selected.map((item) => item.code),
    ['BK1000', 'BK1001'],
  )
})

test('快照以真实成分股计算扩散并输出双周期确定性排名', () => {
  const sectors = [{
    code: 'BK1000',
    name: '机器人',
    price: 103,
    pct: 0.4,
    mainInflow: 620e6,
    mainRatio: 6.5,
    amount: 32e9,
    leadCode: '600001',
    leadName: '龙头股份',
    leadPct: 2.5,
  }]
  const history = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-08-${String(7 + index).padStart(2, '0')}`,
    close: 100 + index * 0.3,
    pct: 0.3,
    mainInflow: (50 + index * 60) * 1e6,
    mainRatio: 0.8 + index * 0.6,
  }))
  const members = [
    {
      code: '600001',
      name: '龙头股份',
      price: 20,
      pct: 3,
      mainInflow: 80e6,
      mainRatio: 6,
      amount: 1.2e9,
      turnover: 5,
      volRatio: 1.4,
      amplitude: 6,
      isLimitUp: false,
    },
    {
      code: '000002',
      name: '趋势中军',
      price: 15,
      pct: 1,
      mainInflow: 50e6,
      mainRatio: 4,
      amount: 2e9,
      turnover: 3,
      volRatio: 1.1,
      amplitude: 4,
      isLimitUp: false,
    },
    {
      code: '300003',
      name: '分歧成员',
      price: 10,
      pct: -1,
      mainInflow: -10e6,
      mainRatio: -2,
      amount: 0.9e9,
      turnover: 6,
      volRatio: 1,
      amplitude: 5,
      isLimitUp: false,
    },
  ]

  const snapshot = buildSectorForecastSnapshot({
    signalDate: '2026-08-20',
    generatedAt: 100,
    sectors,
    histories: new Map([['BK1000', history]]),
    members: new Map([['BK1000', members]]),
  })

  assert.equal(snapshot.schemaVersion, 'sector-forecast.v1')
  assert.equal(snapshot.sectors[0].rank, 1)
  assert.equal(snapshot.sectors[0].breadth.memberCount, 3)
  assert.equal(snapshot.sectors[0].breadth.upPct, 66.67)
  assert.ok(snapshot.sectors[0].stocks.length >= 1)
  assert.ok(
    snapshot.sectors[0].stocks.every((item) =>
      members.some((member) => member.code === item.code)
    ),
  )
  assert.ok(snapshot.sectors[0].forecast.next.score >= 0)
  assert.ok(snapshot.sectors[0].forecast.week.score >= 0)
})

test('LightGBM横截面概率按20%基准校准并约束布局动作', () => {
  assert.equal(sectorProbabilityScore(20), 50)
  assert.equal(sectorProbabilityScore(35), 87.5)
  assert.equal(sectorProbabilityScore(10), 25)

  const sectors = ['BK1000', 'BK1001'].map((code) => ({
    code,
    name: code,
    price: 103,
    pct: 0.4,
    mainInflow: 620e6,
    mainRatio: 6.5,
    amount: 32e9,
    leadCode: '600001',
    leadName: '龙头股份',
    leadPct: 2.5,
  }))
  const history = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-08-${String(7 + index).padStart(2, '0')}`,
    close: 100 + index * 0.3,
    pct: 0.3,
    mainInflow: (50 + index * 60) * 1e6,
    mainRatio: 0.8 + index * 0.6,
  }))
  const memberRows = [{
    code: '600001',
    name: '龙头股份',
    price: 20,
    pct: 3,
    mainInflow: 80e6,
    mainRatio: 6,
    amount: 1.2e9,
  }]
  const snapshot = buildSectorForecastSnapshot({
    signalDate: '2026-08-20',
    sectors,
    histories: new Map(sectors.map((item) => [item.code, history])),
    members: new Map(sectors.map((item) => [item.code, memberRows])),
    quantPredictions: new Map([
      ['BK1000', { nextProbability: 35, weekProbability: 34 }],
      ['BK1001', { nextProbability: 10, weekProbability: 12 }],
    ]),
  })

  assert.equal(snapshot.sectors[0].code, 'BK1000')
  assert.ok(
    snapshot.sectors[0].forecast.next.score
      > snapshot.sectors[1].forecast.next.score,
  )
  assert.notEqual(snapshot.sectors[1].actionability, 'LAYOUT')
})

test('sector角色默认使用gpt-5.6-terra并开启深度思考', () => {
  assert.equal(ROLES.sector.def, 'gpt-5.6-terra')
  assert.equal(ROLES.sector.label, '板块前瞻')
  assert.equal(getReasoning('sector'), true)
})

test('板块解释只做一次合并检索且模型不能覆盖确定性排名', async () => {
  let searches = 0
  const snapshot = {
    schemaVersion: 'sector-forecast.v1',
    signalDate: '2026-08-20',
    session: 'close',
    sectors: [{
      code: 'BK1000',
      name: '机器人',
      rank: 1,
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
      forecast: {
        next: { score: 78 },
        week: { score: 74 },
      },
      reasons: ['资金连续改善'],
      risks: [],
      explanation: {},
    }, {
      code: 'BK1001',
      name: '算力',
      rank: 2,
      phase: 'STARTUP',
      actionability: 'WAIT_PULLBACK',
      forecast: {
        next: { score: 70 },
        week: { score: 72 },
      },
      reasons: ['成分股扩散'],
      risks: ['位置偏高'],
      explanation: {},
    }],
  }
  const enriched = await enrichSectorForecastSnapshot(snapshot, {
    search: async () => {
      searches += 1
      return {
        enabled: true,
        status: 'network',
        billed: true,
        items: [{
          title: '机器人产业政策更新',
          summary: '政策仍需后续公告确认',
          src: '公开检索',
          date: '2026-08-20',
          url: 'https://example.com/news',
        }],
      }
    },
    callModel: async () => ({
      sectors: [{
        code: 'BK1000',
        rank: 99,
        phase: 'RETREAT',
        actionability: 'AVOID',
        whyNow: '资金改善叠加政策催化。',
        catalysts: ['产业政策'],
        risks: ['订单兑现不及预期'],
        invalidation: '资金连续两日流出',
      }],
    }),
  })

  assert.equal(searches, 1)
  assert.equal(enriched.sectors[0].rank, 1)
  assert.equal(enriched.sectors[0].phase, 'ACCUMULATION')
  assert.equal(enriched.sectors[0].actionability, 'LAYOUT')
  assert.equal(enriched.sectors[0].explanation.whyNow, '资金改善叠加政策催化。')
  assert.equal(
    enriched.sectors[0].explanation.evidence[0].pendingVerification,
    true,
  )
  assert.equal(enriched.sectors[1].explanation.evidence.length, 0)
  assert.equal(enriched.search.billed, true)
})

test('检索和模型失败时仍保留确定性榜单及降级解释', async () => {
  const snapshot = {
    schemaVersion: 'sector-forecast.v1',
    signalDate: '2026-08-20',
    session: 'close',
    sectors: [{
      code: 'BK1000',
      name: '机器人',
      rank: 1,
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
      forecast: {
        next: { score: 78 },
        week: { score: 74 },
      },
      reasons: ['资金连续改善'],
      risks: ['市场风险偏好转弱'],
      explanation: {},
    }],
  }
  const enriched = await enrichSectorForecastSnapshot(snapshot, {
    search: async () => {
      throw new Error('search unavailable')
    },
    callModel: async () => {
      throw new Error('model unavailable')
    },
  })

  assert.equal(enriched.sectors[0].rank, 1)
  assert.match(enriched.sectors[0].explanation.whyNow, /资金连续改善/)
  assert.deepEqual(
    enriched.sectors[0].explanation.risks,
    ['市场风险偏好转弱'],
  )
  assert.equal(enriched.explanationStatus, 'degraded')
})

test('板块量化只调用独立sector-predict并规范化双头概率', async () => {
  let request = null
  const predictions = await fetchSectorQuantPredictions({
    signalDate: '2026-08-20',
    sectors: [{
      code: 'BK1000',
      factors: { flowPersistence: 80, currentPct: 0.5 },
    }],
  }, {
    env: {
      QUANT_URL: 'https://quant.example.com/',
      QUANT_KEY: 'secret',
    },
    fetchImpl: async (url, init) => {
      request = { url, init }
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            predictions: [{
              code: 'BK1000',
              nextProbability: 0.82,
              weekProbability: 74,
              drawdownEstimate: -3.2,
            }],
          }
        },
      }
    },
  })

  assert.equal(request.url, 'https://quant.example.com/sector-predict')
  assert.equal(request.init.headers['X-API-Key'], 'secret')
  assert.equal(predictions.get('BK1000').nextProbability, 82)
  assert.equal(predictions.get('BK1000').weekProbability, 74)
})

test('盘前生成只复用收盘快照并且不重新采集或量化排名', async () => {
  let collected = 0
  let quantified = 0
  const base = {
    schemaVersion: 'sector-forecast.v1',
    signalDate: '2026-08-19',
    session: 'close',
    generatedAt: 100,
    sectors: [{
      code: 'BK1000',
      rank: 1,
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
      forecast: { next: { score: 78 }, week: { score: 74 } },
      explanation: {},
    }],
  }
  const result = await generateSectorForecastSnapshot({
    signalDate: '2026-08-19',
    session: 'overnight',
  }, {
    store: { readLatest: async () => base },
    collect: async () => { collected += 1 },
    fetchQuant: async () => { quantified += 1 },
    enrich: async (snapshot) => ({
      ...snapshot,
      explanationStatus: 'complete',
      search: { billed: true },
      theories: [],
      sectors: snapshot.sectors.map((item) => ({
        ...item,
        rank: 99,
        explanation: { whyNow: '隔夜证据更新', evidence: [] },
      })),
    }),
    now: () => 200,
  })

  assert.equal(collected, 0)
  assert.equal(quantified, 0)
  assert.equal(result.signalDate, '2026-08-19')
  assert.equal(result.sectors[0].rank, 1)
  assert.equal(result.sectors[0].forecast.next.score, 78)
  assert.equal(result.sectors[0].explanation.whyNow, '隔夜证据更新')
})

test('自动开关关闭时run_due不会进入生成函数', async () => {
  let generated = 0
  const result = await runDueSectorForecast(
    Date.parse('2026-08-20T07:10:00.000Z'),
    {
      store: {
        readSettings: async () => ({
          ...DEFAULT_SECTOR_FORECAST_SETTINGS,
          autoEnabled: false,
        }),
        readTask: async () => ({ completed: {} }),
      },
      generate: async () => { generated += 1 },
    },
  )

  assert.equal(result.skipped, true)
  assert.equal(generated, 0)
})

test('匿名读取板块前瞻不会泄露全局快照', async () => {
  const req = {
    method: 'GET',
    headers: {},
    query: { action: 'latest' },
  }
  const res = {
    statusCode: 200,
    body: '',
    setHeader() {},
    status(code) { this.statusCode = code; return this },
    send(body) { this.body = String(body); return this },
  }

  await sectorForecastHandler(req, res)

  assert.equal(res.statusCode, 401)
  assert.equal(JSON.parse(res.body).ok, false)
})
