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

test('漂移历史按时间追加并受最大长度约束', async () => {
  const storage = memoryStorage()
  const store = createOpportunityRadarBaselineStore(storage)

  for (let index = 0; index < 70; index += 1) {
    await store.appendDriftHistory({
      generatedAt: 1000 + index,
      overall: { samples: index, winRatePct: 50 },
    }, { limit: 60 })
  }
  const history = await store.readDriftHistory()
  // 只保留最近 60 期
  assert.equal(history.length, 60)
  // 末尾是最新一期
  assert.equal(history.at(-1).generatedAt, 1069)
  // 头部是被裁剪后的最早一期
  assert.equal(history[0].generatedAt, 1010)
  // 历史只保留精简字段，不含完整分桶
  assert.equal('groups' in history[0], false)
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
  assert.deepEqual(saved, {
    schemaVersion: baseline.schemaVersion,
    generatedAt: baseline.generatedAt,
    range: baseline.range,
    overall: baseline.overall,
    groups: baseline.groups,
  })
})

test('基线刷新追加漂移历史并返回漂移信号', async () => {
  const storage = memoryStorage()
  const store = createOpportunityRadarBaselineStore(storage)
  // 预置一期历史，制造样本充足但期望净R转负的漂移
  await store.appendDriftHistory({
    schemaVersion: 'opportunity-radar-baseline.v1',
    generatedAt: Date.parse('2026-09-02T09:10:00.000Z'),
    overall: {
      samples: 60,
      completedTrades: 40,
      winRatePct: 58,
      expectedNetRGivenFill: 0.25,
      sampleSufficient: true,
    },
  })

  const result = await refreshOpportunityRadarBaseline({
    outcomeStore: {
      async listOutcomeRange() {
        // 40 笔全亏，制造 sampleSufficient 且期望净R 明显为负
        return Array.from({ length: 40 }, (_, index) => ({
          decisionId: `formula:2026-09-03:close:1505:${600001 + index}`,
          formulaId: 'FORMULA_A',
          maturity: 'MATURED',
          outcome: 'STOP_LOSS',
          fillStatus: 'FILLED',
          metrics: {
            netR: -1,
            netPnl: -100,
            netReturnPct: -1,
            mfePct: 0.2,
            maePct: -1.5,
          },
          context: {
            marketState: 'RISK_ALLOWED',
            sectorPhase: 'ACCUMULATION',
            timeBucket: 'CLOSE_NEXT_SESSION',
            liquidityBucket: 'GOOD',
            displayed: true,
          },
        }))
      },
    },
    baselineStore: store,
    now: Date.parse('2026-09-03T09:10:00.000Z'),
    lookbackDays: 30,
  })

  assert.ok(result.drift)
  assert.equal(result.drift.schemaVersion, 'opportunity-drift.v1')
  // 两期都样本充足且期望净R由正转负 → 检出漂移
  assert.equal(result.drift.state, 'DRIFT_DETECTED')
  assert.ok(
    result.drift.alerts.some(
      (a) => a.metric === 'expectedNetRGivenFill',
    ),
  )
  // 历史序列已保存两期
  const history = await store.readDriftHistory()
  assert.equal(history.length, 2)
})

