import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compareEvidenceSnapshots,
  findSnapshotLinkedRecords,
  replayEvidenceSnapshot,
} from '../shared/evidenceReplay.js'

function snapshot(overrides = {}) {
  return {
    schemaVersion: 'canonical-evidence.v1',
    snapshotId: 'ev_base',
    asOf: '2026-08-13T02:30:00.000Z',
    mode: 'hold_advice',
    security: { code: '600001', name: '回放样本' },
    marketTime: {
      phase: '盘中',
      dataDayLabel: '2026-08-13',
      isLive: true,
    },
    account: {
      revision: 8,
      holdCost: 10,
      holdQty: 3,
      sellableTodayQty: 2,
      cash: 2000,
      totalAssets: 20000,
      position: 90,
      stockWeight: 30,
      cashReservePct: 10,
    },
    quant: {
      selectedModelVersion: 'v2.1',
      runtimeModelVersion: 'v2',
      asOf: '2026-08-13T02:29:00.000Z',
    },
    sourceVersion: {
      schema: 'canonical-evidence.v1',
      collector: 'ai-collector.v1',
      prompt: 'advisor.abc',
      quant: 'v2',
      accountRevision: 8,
    },
    sources: {
      account: { available: true, state: 'CAPTURED' },
      quote: { available: true, state: 'LIVE' },
      market: { available: true, state: 'AVAILABLE' },
      quant: { available: true, state: 'AVAILABLE' },
    },
    freshness: { status: 'LIVE', missingSources: [] },
    collection: {
      sources: [
        { key: 'quote', status: 'OK', durationMs: 100 },
        { key: 'news', status: 'ERROR', durationMs: 500, errorCode: 'HTTPError' },
      ],
      sourceDurationMs: 600,
      wallClockMs: 500,
      failedSources: ['news'],
      emptySources: [],
    },
    evidence: {
      quote: {
        live: true,
        price: 11,
        pct: -2.5,
        prevClose: 11.28,
        limitUpPrice: 12.41,
        limitDownPrice: 10.15,
      },
      market: {
        environment: { score: 40, level: '弱势', weak: true },
      },
      quant: {
        score: 72,
        bias: '偏多',
        forecast: { upProb: 61, expRet: 2.2, direction: '上涨' },
        highConfSignal: { fired: false },
      },
      decisionSignals: {
        resonance: { score: 4, max: 6 },
        trustScore: { score: 70, band: '一般' },
      },
    },
    ...overrides,
  }
}

test('确定性回放重建账户约束、T+1、市场和量化事实', () => {
  const replay = replayEvidenceSnapshot(snapshot())

  assert.equal(replay.schemaVersion, 'evidence-replay.v1')
  assert.equal(replay.snapshotId, 'ev_base')
  assert.equal(replay.replayable, true)
  assert.equal(replay.account.t1LockedQty, 1)
  assert.equal(replay.constraints.totalPositionHigh, true)
  assert.equal(replay.constraints.stockConcentrated, true)
  assert.equal(replay.market.weak, true)
  assert.equal(replay.quant.didFallback, true)
  assert.deepEqual(replay.quality.failedSources, ['news'])
  assert.match(replay.fingerprint, /^replay\./)
})

test('相同快照重复回放得到完全相同指纹且不依赖当前时间', () => {
  const first = replayEvidenceSnapshot(snapshot())
  const second = replayEvidenceSnapshot(structuredClone(snapshot()))

  assert.deepEqual(second, first)
})

test('快照缺失持仓事实时保留未知而不是伪造零仓位', () => {
  const incomplete = snapshot({
    account: { revision: 8 },
  })
  const replay = replayEvidenceSnapshot(incomplete)

  assert.equal(replay.account.holdQty, null)
  assert.equal(replay.account.sellableTodayQty, null)
  assert.equal(replay.account.t1LockedQty, null)
  assert.equal(replay.constraints.noSellableShares, null)
  assert.equal(replay.constraints.t1Locked, null)
})

test('差异引擎只报告白名单事实变化并标记高风险变化', () => {
  const before = snapshot()
  const after = snapshot({
    snapshotId: 'ev_after',
    asOf: '2026-08-13T03:00:00.000Z',
    account: {
      ...snapshot().account,
      revision: 9,
      sellableTodayQty: 0,
      cashReservePct: 5,
    },
    quant: {
      ...snapshot().quant,
      runtimeModelVersion: 'v2.1',
    },
    evidence: {
      ...snapshot().evidence,
      quote: {
        ...snapshot().evidence.quote,
        price: 10.4,
        pct: -7.8,
      },
    },
  })

  const comparison = compareEvidenceSnapshots(before, after)

  assert.equal(comparison.comparable, true)
  assert.equal(comparison.fromSnapshotId, 'ev_base')
  assert.equal(comparison.toSnapshotId, 'ev_after')
  assert.ok(comparison.changes.some((item) =>
    item.path === 'account.sellableTodayQty'
    && item.severity === 'HIGH'
  ))
  assert.ok(comparison.changes.some((item) =>
    item.path === 'quant.runtimeModelVersion'
  ))
  assert.equal(comparison.summary.hasMaterialChange, true)
})

test('来源集合顺序变化不产生虚假差异', () => {
  const before = snapshot({
    freshness: { status: 'PARTIAL', missingSources: ['quant', 'news'] },
    collection: {
      ...snapshot().collection,
      failedSources: ['news', 'quant'],
    },
  })
  const after = snapshot({
    snapshotId: 'ev_reordered',
    freshness: { status: 'PARTIAL', missingSources: ['news', 'quant'] },
    collection: {
      ...snapshot().collection,
      failedSources: ['quant', 'news'],
    },
  })

  const comparison = compareEvidenceSnapshots(before, after)

  assert.equal(comparison.changes.some((item) =>
    item.path === 'quality.missingSources'
    || item.path === 'quality.failedSources'
  ), false)
})

test('不同股票快照明确标记不可直接对比', () => {
  const other = snapshot({
    snapshotId: 'ev_other',
    security: { code: '300001', name: '另一股票' },
  })
  const comparison = compareEvidenceSnapshots(snapshot(), other)

  assert.equal(comparison.comparable, false)
  assert.equal(comparison.reason, 'SECURITY_MISMATCH')
  assert.equal(comparison.changes.length, 0)
})

test('不同快照Schema明确标记不可直接对比', () => {
  const future = snapshot({
    snapshotId: 'ev_future',
    schemaVersion: 'canonical-evidence.v2',
  })
  const comparison = compareEvidenceSnapshots(snapshot(), future)

  assert.equal(comparison.comparable, false)
  assert.equal(comparison.reason, 'SCHEMA_MISMATCH')
  assert.equal(comparison.changes.length, 0)
})

test('按snapshotId关联原建议、复盘和决策事件', () => {
  const linked = findSnapshotLinkedRecords({
    advice: {
      '600001': {
        mode: 'hold_advice',
        at: 100,
        advice: {
          action: '持有',
          evidenceSnapshotRef: { snapshotId: 'ev_base' },
        },
      },
    },
    reviews: {
      '600001': {
        at: 120,
        result: {
          stance: '谨慎持有',
          evidenceSnapshotRef: { snapshotId: 'ev_base' },
        },
      },
    },
    decisionLog: [
      {
        id: 'd1',
        kind: 'recommendation',
        action: '持有',
        at: 110,
        evidenceSnapshotId: 'ev_base',
      },
      {
        id: 'd2',
        kind: 'recommendation',
        at: 130,
        evidenceSnapshotId: 'ev_other',
      },
    ],
  }, 'ev_base')

  assert.equal(linked.advice.length, 1)
  assert.equal(linked.reviews.length, 1)
  assert.deepEqual(linked.decisionEvents.map((item) => item.id), ['d1'])
})
