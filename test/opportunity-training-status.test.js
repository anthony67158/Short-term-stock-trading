import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createOpportunityTrainingStatusStore,
  normalizeOpportunityTrainingStatus,
  OPPORTUNITY_COLLECTION_STATUS_PATH,
  OPPORTUNITY_TRAINING_STATUS_PATH,
} from '../api/_opportunity_training_status.js'

const workbench = readFileSync(
  new URL('../src/components/AdaptiveWorkbench.jsx', import.meta.url),
  'utf8',
)

test('V3状态明确展示样本缺口与直接建仓资格', () => {
  const status = normalizeOpportunityTrainingStatus({
    generatedAt: 123,
    state: 'NOT_READY',
    readiness: {
      samples: 240,
      filled_samples: 80,
      dates: 12,
      blockers: ['成熟候选少于1000'],
    },
  }, {
    generatedAt: 120,
    settlement: {
      batches: 6,
      candidates: 288,
      evaluated: 120,
      deferred: 168,
      matured: 42,
      pending: 78,
    },
  })

  assert.equal(status.productionEligible, false)
  assert.deepEqual(status.readiness.remaining, {
    samples: 760,
    filledSamples: 220,
    dates: 48,
  })
  assert.equal(status.collection.matured, 42)
  assert.equal(status.directEntry.eligible, false)
  assert.match(status.directEntry.reason, /成熟候选/)
})

test('生产模型状态允许V3直接建仓', () => {
  const status = normalizeOpportunityTrainingStatus({
    state: 'PRODUCTION_READY',
    activeModel: {
      modelVersion: 'opportunity-score.20260909.production',
      productionEligible: true,
    },
    readiness: {
      samples: 1800,
      filledSamples: 720,
      dates: 82,
    },
  })

  assert.equal(status.productionEligible, true)
  assert.equal(status.directEntry.eligible, true)
  assert.match(status.directEntry.reason, /晋级闸门/)
})

test('未晋级模型的直接使用清单覆盖旧拒绝报告', () => {
  const status = normalizeOpportunityTrainingStatus(
    { state: 'REJECTED', productionEligible: false }, null,
    { runId: 'opportunity-score.direct', usagePolicy: 'DIRECT', productionEligible: false },
  )
  assert.equal(status.state, 'DIRECT_ACTIVE')
  assert.equal(status.enabled, true)
  assert.equal(status.directEntry.eligible, true)
  assert.equal(status.productionEligible, false)
  assert.match(status.directEntry.reason, /不等待训练或晋级/)
})

test('状态存储合并训练状态与最新结算进度', async () => {
  const objects = new Map([
    [OPPORTUNITY_TRAINING_STATUS_PATH, {
      state: 'REJECTED',
      readiness: {
        samples: 360,
        filledSamples: 120,
        dates: 15,
      },
    }],
  ])
  const storage = {
    hasStorage: () => true,
    async readJson(path) {
      return objects.get(path) || null
    },
    async put(path, body) {
      objects.set(path, JSON.parse(body))
    },
  }
  const store = createOpportunityTrainingStatusStore(storage)
  await store.saveCollectionStatus({
    generatedAt: 456,
    settlement: { matured: 18, pending: 42 },
  })
  const status = await store.readStatus()

  assert.equal(
    objects.get(OPPORTUNITY_COLLECTION_STATUS_PATH).generatedAt,
    456,
  )
  assert.equal(status.readiness.samples, 360)
  assert.equal(status.collection.matured, 18)
})

test('作战台同时展示总样本、成交样本和独立交易日门槛', () => {
  assert.match(workbench, /V3成熟样本/)
  assert.match(workbench, /成交样本/)
  assert.match(
    workbench,
    /trainingStatus\.readiness\.filledSamples/,
  )
  assert.match(workbench, /trainingStatus\.readiness\.dates/)
})
