import test from 'node:test'
import assert from 'node:assert/strict'

import {
  attachEvidenceSnapshot,
  addEvidenceSnapshot,
  createCanonicalEvidenceSnapshot,
  createEvidenceSourceTracker,
  evidencePersistenceFields,
  evidenceSnapshotsFromData,
  mergeEvidenceSnapshotIndexes,
  resolveEvidenceAccountRevision,
  sourceTextVersion,
} from '../shared/evidenceSnapshot.js'

const payload = {
  code: '600001',
  name: '证据样本',
  holdCost: 10,
  holdQty: 3,
  sellableTodayQty: 2,
  account: {
    cash: 5000,
    totalAssets: 20000,
    position: 75,
    stockWeight: 25,
    cashReservePct: 25,
  },
  todayQuote: {
    live: true,
    asOfLabel: '2026-08-13',
    phase: '盘中',
    price: 11,
    pct: 2.3,
    prevClose: 10.75,
  },
  market: {
    up: 3000,
    down: 1800,
    limitUp: 52,
    limitDown: 8,
    indices: [{ name: '上证指数', pct: 0.6 }],
  },
  marketEnv: { score: 68, level: '强势', weak: false },
  quant: {
    score: 72,
    bias: '偏多',
    asOf: '2026-08-13T02:30:00.000Z',
    selectedModelVersion: 'v2',
    runtimeModelVersion: 'v2.1-intraday',
    forecast: { upProb: 61, expRet: 2.2, direction: '上涨' },
  },
  tech: { rsi: 58, maTrend: '多头' },
  intraday: { now: 11, vwap: 10.8, rhythm: '尾段拉升' },
  stockFund: { mainNetYi: 1.2, asOfDate: '2026-08-13' },
  newsHeadlines: ['公司发布公告'],
  newsDigest: ['不应复制进快照的长新闻正文'],
  aiSearchEvidence: ['[豆包搜索待核验][2026-08-13]白酒行业需求平稳'],
  dailyReport: { day: '2026-08-13', sessionCn: '盘中' },
  resonance: { score: 5, max: 6, hits: ['量化看涨'] },
  trustScore: { score: 76, band: '较可信' },
}

test('统一证据快照包含稳定版本、来源、账户与量化上下文', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'hold_advice',
    payload,
    accountRevision: 12,
    promptVersion: 'advisor-test',
    now: Date.parse('2026-08-13T02:31:00.000Z'),
  })

  assert.equal(snapshot.schemaVersion, 'canonical-evidence.v1')
  assert.match(snapshot.snapshotId, /^ev_/)
  assert.equal(snapshot.asOf, '2026-08-13T02:31:00.000Z')
  assert.equal(snapshot.security.code, '600001')
  assert.equal(snapshot.account.revision, 12)
  assert.equal(snapshot.account.sellableTodayQty, 2)
  assert.equal(snapshot.quant.selectedModelVersion, 'v2')
  assert.equal(snapshot.quant.runtimeModelVersion, 'v2.1-intraday')
  assert.equal(snapshot.sourceVersion.prompt, 'advisor-test')
  assert.equal(snapshot.sources.quote.state, 'LIVE')
  assert.equal(snapshot.freshness.status, 'LIVE')
  assert.equal(snapshot.evidence.news.headlines[0], '公司发布公告')
  assert.match(snapshot.evidence.news.aiSearch[0], /豆包搜索待核验/)
  assert.equal(JSON.stringify(snapshot).includes('不应复制进快照的长新闻正文'), false)
})

test('证据快照固化策略审核状态供自动复核比较', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'buy_advice',
    payload: {
      ...payload,
      strategyGate: {
        strategyId: 'market-quant-resonance',
        specVersion: 'strategy-v1',
        productionEligible: false,
        decision: 'reject',
        blockerCodes: ['BACKTEST_REQUIRED'],
      },
    },
    now: Date.parse('2026-08-13T02:31:00.000Z'),
  })

  assert.deepEqual(snapshot.policy.strategyGate, {
    strategyId: 'market-quant-resonance',
    specVersion: 'strategy-v1',
    productionEligible: false,
    decision: 'reject',
    blockerCodes: ['BACKTEST_REQUIRED'],
  })
})

test('午间休市保留上午完整行情并标记为上午收盘快照', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'hold_advice',
    payload: {
      ...payload,
      todayQuote: {
        ...payload.todayQuote,
        phase: '午间休市',
        asOfLabel: '2026-08-13(周四)',
      },
    },
    now: Date.parse('2026-08-13T04:00:00.000Z'),
  })

  assert.equal(snapshot.sources.quote.state, 'SESSION_CLOSE')
  assert.equal(snapshot.sources.market.state, 'SESSION_CLOSE')
  assert.equal(snapshot.sources.technical.state, 'SESSION_CLOSE')
  assert.equal(snapshot.sources.quote.basisLabel, '今日上午收盘快照')
  assert.equal(snapshot.freshness.status, 'SESSION_CLOSE')
  assert.equal(snapshot.freshness.missingSources.includes('quote'), false)
  assert.equal(snapshot.freshness.missingSources.includes('market'), false)
  assert.equal(snapshot.freshness.missingSources.includes('quant'), false)
})

test('盘后使用当日完整数据而不是把非实时行情判为缺失', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'hold_advice',
    payload: {
      ...payload,
      todayQuote: {
        ...payload.todayQuote,
        live: false,
        phase: '盘后(已收盘)',
        asOfLabel: '2026-08-13(周四)',
      },
    },
    now: Date.parse('2026-08-13T08:30:00.000Z'),
  })

  assert.equal(snapshot.sources.quote.state, 'DAY_CLOSE')
  assert.equal(snapshot.sources.market.state, 'DAY_CLOSE')
  assert.equal(snapshot.sources.quote.basisLabel, '今日完整收盘数据')
  assert.equal(snapshot.freshness.status, 'DAY_CLOSE')
  assert.deepEqual(snapshot.freshness.missingRequiredSources, [])
})

test('周末使用最近交易日完整数据而不是把历史快照判为缺失', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'buy_advice',
    payload: {
      ...payload,
      todayQuote: {
        ...payload.todayQuote,
        live: false,
        phase: '休市(周末)',
        asOfLabel: '2026-08-21(周五)',
      },
    },
    now: Date.parse('2026-08-23T02:00:00.000Z'),
  })

  assert.equal(snapshot.sources.quote.state, 'PREVIOUS_CLOSE')
  assert.equal(snapshot.sources.market.state, 'PREVIOUS_CLOSE')
  assert.equal(snapshot.sources.technical.state, 'PREVIOUS_CLOSE')
  assert.equal(snapshot.sources.quote.basisLabel, '最近交易日完整数据')
  assert.equal(snapshot.sources.quote.dataAsOf, '2026-08-21(周五)')
  assert.equal(snapshot.freshness.status, 'PREVIOUS_CLOSE')
  assert.deepEqual(snapshot.freshness.missingRequiredSources, [])
})

test('只有没有任何有效收盘或历史快照时才标记行情缺失', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'buy_advice',
    payload: {
      code: '600004',
      account: { cash: 5000, totalAssets: 20000 },
      marketPhase: '休市(周末)',
    },
    now: Date.parse('2026-08-23T02:00:00.000Z'),
  })

  assert.equal(snapshot.sources.quote.state, 'MISSING')
  assert.equal(snapshot.sources.quote.basisLabel, null)
  assert.ok(snapshot.freshness.missingSources.includes('quote'))
})

test('缺失关键数据时明确标记PARTIAL和缺失来源', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'buy_advice',
    payload: { code: '600002', name: '缺失样本', account: {} },
    accountRevision: 12,
    sourceTrace: [
      {
        key: 'market',
        label: '大盘情绪',
        status: 'ERROR',
        errorCode: 'HTTP_401',
      },
      {
        key: 'quote',
        label: '今日实时行情',
        status: 'ERROR',
        errorCode: 'HTTP_401',
      },
      {
        key: 'dailyCandles',
        label: '个股K线',
        status: 'ERROR',
        errorCode: 'HTTP_401',
      },
      {
        key: 'quant',
        label: '量化预测',
        status: 'SKIPPED',
        errorCode: 'INSUFFICIENT_CANDLES',
      },
    ],
    now: Date.parse('2026-08-13T08:00:00.000Z'),
  })

  assert.equal(snapshot.freshness.status, 'PARTIAL')
  assert.ok(snapshot.freshness.missingSources.includes('quote'))
  assert.ok(snapshot.freshness.missingSources.includes('market'))
  assert.ok(snapshot.freshness.missingSources.includes('quant'))
  assert.deepEqual(
    snapshot.freshness.missingRequiredSources,
    ['account', 'quote', 'market', 'quant'],
  )
  assert.match(
    snapshot.freshness.missingDetails
      .find((item) => item.source === 'quote').reason,
    /HTTP 401/,
  )
  assert.match(
    snapshot.freshness.missingDetails
      .find((item) => item.source === 'quant').reason,
    /K线.*不足/,
  )
  assert.ok(
    snapshot.freshness.missingDetails
      .every((item) => item.impact && item.recovery),
  )
  assert.equal(snapshot.sources.account.available, false)
  assert.equal(snapshot.account.revision, 12)
})

test('采集追踪优先保留安全错误码而不是泛化错误类型', async () => {
  const tracker = createEvidenceSourceTracker()
  const error = Object.assign(new Error('HTTP 401'), {
    name: 'HTTPError',
    code: 'HTTP_401',
  })

  await assert.rejects(
    tracker.track('quote', '今日实时行情', Promise.reject(error)),
  )

  assert.equal(tracker.snapshot()[0].errorCode, 'HTTP_401')
})

test('接口成功但载荷未写入时明确归因为证据组装失败', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'buy_advice',
    payload: {
      code: '600003',
      account: { cash: 5000, totalAssets: 20000 },
      market: { up: 1, down: 1 },
      quant: { score: 50 },
    },
    sourceTrace: [{
      key: 'quote',
      label: '今日实时行情',
      status: 'OK',
      errorCode: null,
    }],
  })

  assert.match(
    snapshot.freshness.missingDetails
      .find((item) => item.source === 'quote').reason,
    /组装/,
  )
})

test('响应只在meta保存完整快照并给建议附轻量引用', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'hold_advice',
    payload,
    accountRevision: 12,
    now: Date.parse('2026-08-13T02:31:00.000Z'),
  })
  const response = attachEvidenceSnapshot({
    ok: true,
    result: { action: '持有' },
    meta: { trustScore: { score: 76 } },
  }, snapshot)

  assert.equal(response.meta.evidenceSnapshot, snapshot)
  assert.equal(response.result.evidenceSnapshotRef.snapshotId, snapshot.snapshotId)
  assert.equal(response.result.evidenceSnapshotRef.accountRevision, 12)
  assert.equal(response.result.evidenceSnapshotRef.quantModelVersion, 'v2.1-intraday')
  assert.equal(response.result.evidenceSnapshot, undefined)
})

test('账号revision优先采用服务端鉴权账号，内部任务回退载荷值', () => {
  assert.equal(resolveEvidenceAccountRevision(
    { accountRevision: 7 },
    { clientRevision: 9 },
  ), 9)
  assert.equal(resolveEvidenceAccountRevision(
    { accountRevision: 7 },
    null,
  ), 7)
  assert.equal(resolveEvidenceAccountRevision({}, null), null)
})

test('决策日志只投影轻量快照引用且兼容旧建议', () => {
  const reference = {
    snapshotId: 'ev_test',
    schemaVersion: 'canonical-evidence.v1',
    asOf: '2026-08-13T02:31:00.000Z',
  }
  assert.deepEqual(evidencePersistenceFields({
    evidenceSnapshotRef: reference,
  }), {
    evidenceSnapshotId: 'ev_test',
    evidenceSnapshotRef: reference,
  })
  assert.deepEqual(evidencePersistenceFields({ action: '持有' }), {})
})

test('Prompt来源版本由实际内容稳定生成并随内容变化', () => {
  assert.equal(sourceTextVersion('advisor', '同一内容'), sourceTextVersion('advisor', '同一内容'))
  assert.notEqual(sourceTextVersion('advisor', '版本一'), sourceTextVersion('advisor', '版本二'))
  assert.match(sourceTextVersion('advisor', '内容'), /^advisor\.[a-z0-9]+$/)
})

test('数据源遥测记录成功空值异常跳过和真实耗时', async () => {
  let now = 1000
  const tracker = createEvidenceSourceTracker({ clock: () => now })

  let resolveSuccess
  const successPromise = new Promise((resolve) => {
    resolveSuccess = resolve
  })
  const trackedSuccess = tracker.track('market', '大盘情绪', successPromise, {
    isAvailable: (value) => value.list.length > 0,
    dataAsOf: (value) => value.asOf,
  })
  now = 1025
  resolveSuccess({ asOf: '2026-08-13', list: [1] })
  const success = await trackedSuccess
  let resolveEmpty
  const trackedEmpty = tracker.track('news', '消息面', new Promise((resolve) => {
    resolveEmpty = resolve
  }), {
    isAvailable: (value) => value.length > 0,
  })
  now = 1050
  resolveEmpty([])
  await trackedEmpty
  let rejectQuant
  const trackedError = tracker.track('quant', '量化', new Promise((resolve, reject) => {
    rejectQuant = reject
  }))
  now = 1080
  rejectQuant(new Error('timeout'))
  await assert.rejects(trackedError, /timeout/)
  tracker.skip('industryNews', '行业新闻', 'NO_INDUSTRY')

  assert.deepEqual(success, { asOf: '2026-08-13', list: [1] })
  assert.deepEqual(
    tracker.snapshot().map((item) => ({
      key: item.key,
      status: item.status,
      durationMs: item.durationMs,
      dataAsOf: item.dataAsOf,
      errorCode: item.errorCode,
    })),
    [
      { key: 'market', status: 'OK', durationMs: 25, dataAsOf: '2026-08-13', errorCode: null },
      { key: 'news', status: 'EMPTY', durationMs: 25, dataAsOf: null, errorCode: null },
      { key: 'quant', status: 'ERROR', durationMs: 30, dataAsOf: null, errorCode: 'Error' },
      { key: 'industryNews', status: 'SKIPPED', durationMs: 0, dataAsOf: null, errorCode: 'NO_INDUSTRY' },
    ],
  )
})

test('证据快照携带采集遥测且只保留安全错误类型', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'hold_advice',
    payload,
    accountRevision: 12,
    now: Date.parse('2026-08-13T02:31:00.000Z'),
    sourceTrace: [{
      key: 'quote',
      label: '今日实时行情',
      status: 'OK',
      startedAt: '2026-08-13T02:30:59.900Z',
      finishedAt: '2026-08-13T02:31:00.000Z',
      durationMs: 100,
      dataAsOf: '2026-08-13',
      errorCode: null,
    }],
  })

  assert.equal(snapshot.collection.sources[0].durationMs, 100)
  assert.equal(snapshot.collection.sourceDurationMs, 100)
  assert.equal(snapshot.collection.wallClockMs, 100)
  assert.deepEqual(snapshot.collection.failedSources, [])
})

test('账号快照索引按ID去重并只保留最近80条', () => {
  const data = {}
  for (let index = 0; index < 85; index++) {
    addEvidenceSnapshot(data, {
      schemaVersion: 'canonical-evidence.v1',
      snapshotId: `ev_${index}`,
      asOf: new Date(1000 + index).toISOString(),
    })
  }

  assert.equal(Object.keys(data.evidenceSnapshots).length, 80)
  assert.equal(data.evidenceSnapshots.ev_0, undefined)
  assert.equal(data.evidenceSnapshots.ev_84.snapshotId, 'ev_84')
})

test('快照索引合并保留两端较新的有界全集', () => {
  const merged = mergeEvidenceSnapshotIndexes(
    {
      ev_server: { snapshotId: 'ev_server', asOf: '2026-08-13T02:00:00.000Z' },
      ev_same: { snapshotId: 'ev_same', asOf: '2026-08-13T02:01:00.000Z', mode: 'old' },
    },
    {
      ev_client: { snapshotId: 'ev_client', asOf: '2026-08-13T02:02:00.000Z' },
      ev_same: { snapshotId: 'ev_same', asOf: '2026-08-13T02:03:00.000Z', mode: 'new' },
    },
  )

  assert.deepEqual(Object.keys(merged).sort(), ['ev_client', 'ev_same', 'ev_server'])
  assert.equal(merged.ev_same.mode, 'new')
})

test('账号持久化可从军师建议与复盘记录提取完整快照', () => {
  const extracted = evidenceSnapshotsFromData({
    advice: {
      '600001': {
        meta: {
          evidenceSnapshot: {
            snapshotId: 'ev_advice',
            asOf: '2026-08-13T02:00:00.000Z',
          },
        },
      },
    },
    reviews: {
      '300001': {
        meta: {
          evidenceSnapshot: {
            snapshotId: 'ev_review',
            asOf: '2026-08-13T03:00:00.000Z',
          },
        },
      },
    },
  })

  assert.deepEqual(Object.keys(extracted).sort(), ['ev_advice', 'ev_review'])
})
