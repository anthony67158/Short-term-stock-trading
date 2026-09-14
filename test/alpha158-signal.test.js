import test from 'node:test'
import assert from 'node:assert/strict'

import {
  alpha158SignalFor,
  buildJointOpportunityRanking,
  normalizeAlpha158Snapshot,
} from '../shared/alpha158Signal.js'

function snapshot(overrides = {}) {
  return normalizeAlpha158Snapshot({
    schemaVersion: 'alpha158-ranking-snapshot.v1',
    state: 'ACTIVE',
    productionEligible: true,
    asOfDate: '20260911',
    generatedAt: Date.parse('2026-09-11T16:00:00+08:00'),
    modelVersion: 'alpha158.20260911',
    reliabilityWeight: 0.2,
    metrics: {
      recentRankIc: 0.03,
      overallRankIc: 0.02,
      recentIc: 0.04,
      overallIc: 0.03,
    },
    stocks: {
      600001: {
        rawScore: 0.12,
        percentile: 0.9,
        rank: 10,
      },
      300001: {
        rawScore: 0.2,
        percentile: 0.95,
        rank: 5,
      },
    },
    ...overrides,
  })
}

test('Alpha158快照只接受主板股票并限制融合权重', () => {
  const value = snapshot({ reliabilityWeight: 0.8 })

  assert.equal(value.stocks.size, 1)
  assert.equal(value.stocks.has('300001'), false)
  assert.equal(value.reliabilityWeight, 0.25)
})

test('Alpha158失效或过期时联合排序逐项退回V3', () => {
  const signal = alpha158SignalFor(snapshot(), '600001', {
    expectedDate: '20260921',
  })
  const ranking = buildJointOpportunityRanking({
    opportunityScore: {
      state: 'READY',
      usagePolicy: 'DIRECT',
      rankingScore: 0.6,
    },
    alpha158Signal: signal,
  })

  assert.equal(signal.state, 'UNAVAILABLE')
  assert.equal(signal.reason, 'SNAPSHOT_STALE')
  assert.equal(ranking.state, 'V3_ONLY')
  assert.equal(ranking.jointScore, 0.6)
  assert.equal(ranking.alpha158Weight, 0)
})

test('有效Alpha158以受限连续权重参与V3联合排序', () => {
  const signal = alpha158SignalFor(snapshot(), '600001', {
    expectedDate: '20260914',
  })
  const ranking = buildJointOpportunityRanking({
    opportunityScore: {
      state: 'READY',
      usagePolicy: 'DIRECT',
      rankingScore: 0.6,
    },
    alpha158Signal: signal,
  })

  assert.equal(signal.state, 'ACTIVE')
  assert.equal(ranking.state, 'BLENDED')
  assert.equal(ranking.v3Score, 0.6)
  assert.equal(ranking.alpha158Score, 0.9)
  assert.equal(ranking.alpha158Weight, 0.2)
  assert.equal(ranking.jointScore, 0.66)
})

test('非DIRECT的V3结果不能借Alpha158升级排序资格', () => {
  const signal = alpha158SignalFor(snapshot(), '600001', {
    expectedDate: '20260914',
  })
  const ranking = buildJointOpportunityRanking({
    opportunityScore: {
      state: 'READY',
      usagePolicy: 'QUALIFIED',
      rankingScore: 0.6,
    },
    alpha158Signal: signal,
  })

  assert.equal(ranking.state, 'V3_ONLY')
  assert.equal(ranking.jointScore, 0.6)
  assert.equal(ranking.alpha158Weight, 0)
})
