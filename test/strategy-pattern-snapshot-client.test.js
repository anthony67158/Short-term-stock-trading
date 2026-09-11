import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchStrategyPatternSnapshot,
  normalizeStrategyPatternSnapshot,
  resetStrategyPatternSnapshotCache,
} from '../api/_strategy_pattern_snapshot.js'

test('normalizes bounded strategy pattern scores by stock code', () => {
  const snapshot = normalizeStrategyPatternSnapshot({
    schemaVersion: 'strategy-pattern-snapshot.v1',
    asOfDate: '20260910',
    generatedAt: 123,
    stocks: {
      600001: {
        historyCoverage: 1,
        platformBreakout: 120,
        supportPullback: -10,
        volumePriceSurge: 80,
        lowerShadowReversal: 70,
        lowVolTrend: 60,
      },
      invalid: { platformBreakout: 90 },
    },
  })

  assert.equal(snapshot.stocks.size, 1)
  assert.equal(snapshot.stocks.get('600001').platformBreakout, 100)
  assert.equal(snapshot.stocks.get('600001').supportPullback, 0)
})

test('snapshot fetch fails open and caches a valid response', async () => {
  resetStrategyPatternSnapshotCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return {
      ok: true,
      json: async () => ({
        schemaVersion: 'strategy-pattern-snapshot.v1',
        asOfDate: '20260910',
        generatedAt: 123,
        stocks: {
          600001: {
            historyCoverage: 1,
            platformBreakout: 90,
          },
        },
      }),
    }
  }
  const options = {
    env: { QUANT_URL: 'https://quant.example', QUANT_KEY: 'secret' },
    fetchImpl,
    now: 1_000,
  }

  const first = await fetchStrategyPatternSnapshot(options)
  const second = await fetchStrategyPatternSnapshot({
    ...options,
    now: 2_000,
  })

  assert.equal(first.stocks.get('600001').platformBreakout, 90)
  assert.equal(second, first)
  assert.equal(calls, 1)
})

test('snapshot fetch returns null when the quant service is unavailable', async () => {
  resetStrategyPatternSnapshotCache()
  const result = await fetchStrategyPatternSnapshot({
    env: { QUANT_URL: 'https://quant.example' },
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  assert.equal(result, null)
})
