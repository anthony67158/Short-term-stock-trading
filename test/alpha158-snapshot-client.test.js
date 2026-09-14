import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchAlpha158Snapshot,
  resetAlpha158SnapshotCache,
} from '../api/_alpha158_snapshot.js'

test('主服务只缓存合同有效的Alpha158快照', async () => {
  resetAlpha158SnapshotCache()
  let calls = 0
  const fetchImpl = async (url, options) => {
    calls += 1
    assert.equal(url, 'https://quant/alpha158-snapshot')
    assert.equal(options.headers['X-API-Key'], 'key')
    return {
      ok: true,
      json: async () => ({
        schemaVersion: 'alpha158-ranking-snapshot.v1',
        state: 'ACTIVE',
        productionEligible: true,
        asOfDate: '20260911',
        generatedAt: 100,
        modelVersion: 'alpha158.test',
        reliabilityWeight: 0.2,
        metrics: {
          recentRankIc: 0.03,
          overallRankIc: 0.02,
        },
        stocks: {
          600001: {
            rawScore: 0.12,
            percentile: 0.9,
            rank: 1,
          },
        },
      }),
    }
  }

  const first = await fetchAlpha158Snapshot({
    env: { QUANT_URL: 'https://quant', QUANT_KEY: 'key' },
    fetchImpl,
    now: 1000,
  })
  const second = await fetchAlpha158Snapshot({
    env: { QUANT_URL: 'https://quant', QUANT_KEY: 'key' },
    fetchImpl,
    now: 2000,
  })

  assert.equal(first.state, 'ACTIVE')
  assert.equal(first.stocks.get('600001').percentile, 0.9)
  assert.equal(second, first)
  assert.equal(calls, 1)
  resetAlpha158SnapshotCache()
})

test('主服务面对非法或失败快照时安全降级', async () => {
  resetAlpha158SnapshotCache()
  const invalid = await fetchAlpha158Snapshot({
    env: { QUANT_URL: 'https://quant' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 'bad' }),
    }),
    now: 1000,
  })
  const failed = await fetchAlpha158Snapshot({
    env: { QUANT_URL: 'https://quant' },
    fetchImpl: async () => {
      throw new Error('offline')
    },
    now: 2000,
  })

  assert.equal(invalid, null)
  assert.equal(failed, null)
  resetAlpha158SnapshotCache()
})
