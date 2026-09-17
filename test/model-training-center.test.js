import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  collectModelTraining,
  listLearningTrainingRuns,
} from '../api/model_training.js'
import {
  normalizeLearningTrainingReport,
  normalizeLegacyTrainingReport,
} from '../shared/modelTraining.js'
import { createModelTrainingStore } from '../src/modelTrainingStore.js'

const learningReport = {
  schemaVersion: 'learning-training-run.v1',
  generatedAt: '2026-09-17T17:18:00+00:00',
  sourceViewHash: 'a'.repeat(64),
  seeds: [17, 41, 97],
  productionPointerChanged: false,
  stockPick: {
    eligible: false,
    status: 'SKIPPED_INSUFFICIENT_MATURED_DATA',
    reasons: ['stock_pick_samples_below_60'],
    metrics: { samples: 12, dates: 3 },
    seedMetrics: [],
    training: {
      algorithm: 'LightGBM LGBMRanker',
      objective: 'lambdarank',
      features: ['rankingScore', 'expectedNetR'],
      label: 'T+5双边费后收益同日排序',
      labelVersion: 'stock-pick-t5-fee-v2',
      data: {
        samples: 12,
        dates: 3,
        startDate: '2026-09-10',
        endDate: '2026-09-17',
        trainSamples: 0,
        testSamples: 12,
      },
      gate: { minimumSamples: 60, minimumDates: 12 },
    },
    artifacts: [],
  },
  position: {
    eligible: true,
    status: 'CHALLENGER_PASSED',
    reasons: [],
    metrics: {
      samples: 38,
      dates: 11,
      baselineMaeR: 0.3,
      challengerMaeR: 0.2,
      maximumSeedMaeR: 0.25,
    },
    seedMetrics: [
      { seed: 17, maeR: 0.18 },
      { seed: 41, maeR: 0.2 },
      { seed: 97, maeR: 0.22 },
    ],
    training: {
      algorithm: 'LightGBM LGBMRegressor',
      objective: 'huber',
      features: ['actionCode', 'expectedNetR'],
      label: '人工实际执行费后 realizedNetR',
      labelVersion: 'position-actual-net-r.v1',
      data: { samples: 38, dates: 11 },
      gate: { minimumSamples: 30, minimumDates: 10 },
    },
    artifacts: ['position-challenger.pkl'],
  },
}

test('增量学习报告拆成选股与持仓两条完整模型记录', () => {
  const runs = normalizeLearningTrainingReport(learningReport, {
    pathname:
      'learning/v1/training-runs/2026-09-17/b8eedb/report.json',
  })

  assert.equal(runs.length, 2)
  assert.equal(runs[0].modelId, 'stock-pick-ranking')
  assert.equal(runs[0].status, 'skipped')
  assert.equal(runs[0].data.samples, 12)
  assert.equal(runs[0].labelVersion, 'stock-pick-t5-fee-v2')
  assert.deepEqual(runs[0].features, ['rankingScore', 'expectedNetR'])
  assert.equal(runs[1].modelId, 'position-decision')
  assert.equal(runs[1].status, 'passed')
  assert.equal(runs[1].productionChanged, false)
  assert.equal(runs[1].seedMetrics[2].maeR, 0.22)
  assert.deepEqual(runs[1].artifacts, ['position-challenger.pkl'])
})

test('旧训练汇报保留生产对照、候选指标和门禁原因', () => {
  const run = normalizeLegacyTrainingReport({
    schemaVersion: 'quant-retrain-report.v3',
    at: 1789674000000,
    model: 'opportunity',
    decision: 'reject',
    details: {
      facts: [
        { label: '训练截止', value: '2026-09-16' },
        { label: '候选版本', value: 'opportunity-v7' },
        { label: '模型组合', value: 'LightGBM + CatBoost' },
      ],
      metrics: [{
        label: 'Top5费后净R',
        unit: 'r',
        champion: 0.3,
        challenger: 0.24,
      }],
      blockers: ['净R下界未大于0'],
    },
    meta: { runId: 82, nSamples: 73004, blindN: 2000 },
  }, 'quantreport/opportunity-82.json')

  assert.equal(run.modelId, 'opportunity-decision')
  assert.equal(run.status, 'rejected')
  assert.equal(run.version, 'opportunity-v7')
  assert.equal(run.algorithm, 'LightGBM + CatBoost')
  assert.equal(run.comparisonMetrics[0].champion, 0.3)
  assert.deepEqual(run.reasons, ['净R下界未大于0'])
})

test('聚合接口读取所有报告并按训练时间倒序归档', async () => {
  const records = new Map([
    [
      'learning/v1/training-runs/2026-09-17/b8eedb/report.json',
      learningReport,
    ],
    [
      'quantreport/opportunity-82.json',
      {
        at: Date.parse('2026-09-17T16:00:00Z'),
        model: 'opportunity',
        decision: 'promote',
        details: {
          facts: [{ label: '候选版本', value: 'opportunity-v6' }],
        },
        meta: { runId: 82 },
      },
    ],
    [
      'opportunitymodel/training-status.json',
      {
        generatedAt: Date.parse('2026-09-17T16:05:00Z'),
        trainingGeneratedAt:
          Date.parse('2026-09-17T16:00:00Z') / 1000,
        activeModel: {
          modelVersion: 'opportunity-v6',
          usagePolicy: 'DIRECT',
        },
      },
    ],
  ])
  const storage = {
    async list({ prefix }) {
      return {
        blobs: [...records.keys()]
          .filter((pathname) => pathname.startsWith(prefix))
          .map((pathname) => ({
            pathname,
            uploadedAt: pathname.includes('learning/')
              ? '2026-09-17T17:20:00Z'
              : '2026-09-17T16:00:00Z',
          })),
      }
    },
    async readJson(blob) {
      return records.get(blob.pathname || blob) || null
    },
  }

  const learning = await listLearningTrainingRuns(10, storage)
  assert.equal(learning.length, 2)

  const result = await collectModelTraining({ limit: 10, storage })
  assert.equal(result.schemaVersion, 'model-training-center.v1')
  assert.equal(result.runs.length, 3)
  assert.equal(result.runs[0].source, 'daily-learning')
  assert.equal(result.models.find(
    (model) => model.id === 'opportunity-decision',
  ).activeVersion, 'opportunity-v6')
  assert.deepEqual(result.warnings, [])
})

test('模型设置包含统一训练中心入口且不读取原始样本', () => {
  const component = readFileSync(
    new URL('../src/components/LLMConfig.jsx', import.meta.url),
    'utf8',
  )
  const endpoint = readFileSync(
    new URL('../api/model_training.js', import.meta.url),
    'utf8',
  )
  assert.match(component, /训练中心/)
  assert.match(endpoint, /learning\/v1\/training-runs\//)
  assert.doesNotMatch(endpoint, /learning\/v1\/views\//)
  assert.doesNotMatch(endpoint, /accountHash|apiKey|rawFeatures/)
})

test('训练中心状态库保留加载错误并支持强制重试', async () => {
  let attempts = 0
  const store = createModelTrainingStore({
    fetcher: async () => {
      attempts += 1
      if (attempts === 1) {
        return {
          ok: false,
          json: async () => ({ ok: false, error: 'temporary' }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          models: [{ id: 'stock-pick-ranking' }],
          runs: [{ id: 'run-1' }],
          warnings: [],
        }),
      }
    },
  })

  await store.load()
  assert.equal(store.get().error, 'temporary')
  assert.equal(store.get().loaded, false)
  await store.load({ force: true })
  assert.equal(store.get().loaded, true)
  assert.equal(store.get().runs[0].id, 'run-1')
})
