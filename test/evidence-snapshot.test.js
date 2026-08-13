import test from 'node:test'
import assert from 'node:assert/strict'

import {
  attachEvidenceSnapshot,
  createCanonicalEvidenceSnapshot,
  evidencePersistenceFields,
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
  assert.equal(JSON.stringify(snapshot).includes('不应复制进快照的长新闻正文'), false)
})

test('缺失关键数据时明确标记PARTIAL和缺失来源', () => {
  const snapshot = createCanonicalEvidenceSnapshot({
    mode: 'buy_advice',
    payload: { code: '600002', name: '缺失样本', account: {} },
    accountRevision: 12,
    now: Date.parse('2026-08-13T08:00:00.000Z'),
  })

  assert.equal(snapshot.freshness.status, 'PARTIAL')
  assert.ok(snapshot.freshness.missingSources.includes('quote'))
  assert.ok(snapshot.freshness.missingSources.includes('market'))
  assert.ok(snapshot.freshness.missingSources.includes('quant'))
  assert.equal(snapshot.sources.account.available, false)
  assert.equal(snapshot.account.revision, 12)
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
