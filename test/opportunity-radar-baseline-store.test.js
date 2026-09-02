import test from 'node:test'
import assert from 'node:assert/strict'

import {
  refreshOpportunityRadarBaseline,
} from '../api/_opportunity_radar_baseline.js'
import {
  OPPORTUNITY_RADAR_BASELINE_PATH,
  createOpportunityRadarBaselineStore,
} from '../api/_opportunity_radar_baseline_store.js'

function memoryStorage() {
  const objects = new Map()
  return {
    objects,
    hasStorage: () => true,
    async put(path, body) {
      objects.set(path, JSON.parse(body))
      return { pathname: path }
    },
    async readJson(path) {
      return objects.get(path) || null
    },
  }
}

test('机会雷达最新基线保存到固定OSS对象并可更新', async () => {
  const storage = memoryStorage()
  const store = createOpportunityRadarBaselineStore(storage)
  const first = {
    schemaVersion: 'opportunity-radar-baseline.v1',
    generatedAt: 100,
    overall: { samples: 1 },
  }
  const second = {
    ...first,
    generatedAt: 200,
    overall: { samples: 2 },
  }

  await store.saveBaseline(first)
  await store.saveBaseline(second)

  assert.deepEqual(storage.objects.get(
    OPPORTUNITY_RADAR_BASELINE_PATH,
  ), second)
  assert.deepEqual(await store.readBaseline(), second)
})

test('基线刷新从成熟结果范围生成并保存分桶报告', async () => {
  let requestedRange = null
  let saved = null
  const baseline = await refreshOpportunityRadarBaseline({
    outcomeStore: {
      async listOutcomeRange(range) {
        requestedRange = range
        return [{
          decisionId: 'formula:2026-09-01:close:1505:600001',
          formulaId: 'FORMULA_A',
          maturity: 'MATURED',
          outcome: 'TAKE_PROFIT',
          fillStatus: 'FILLED',
          metrics: {
            netR: 1,
            netPnl: 100,
            netReturnPct: 1,
            mfePct: 1.5,
            maePct: -0.5,
          },
          context: {
            marketState: 'RISK_ALLOWED',
            sectorPhase: 'ACCUMULATION',
            timeBucket: 'CLOSE_NEXT_SESSION',
            liquidityBucket: 'GOOD',
            displayed: true,
          },
        }]
      },
    },
    baselineStore: {
      async saveBaseline(value) {
        saved = value
      },
    },
    now: Date.parse('2026-09-03T09:10:00.000Z'),
    lookbackDays: 30,
  })

  assert.deepEqual(requestedRange, {
    from: '2026-08-04',
    to: '2026-09-03',
  })
  assert.equal(baseline.overall.samples, 1)
  assert.equal(
    baseline.groups.formula[0].key,
    'FORMULA_A',
  )
  assert.deepEqual(saved, baseline)
})
