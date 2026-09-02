import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPPORTUNITY_RADAR_OUTCOME_PREFIX,
  createOpportunityRadarOutcomeStore,
} from '../api/_opportunity_radar_outcome_store.js'

function outcome(overrides = {}) {
  return {
    schemaVersion: 'opportunity-outcome.v1',
    decisionId: 'formula:2026-09-02:close:1505:600001',
    tradeDate: '2026-09-02',
    mode: 'CLOSE',
    slot: '1505',
    code: '600001',
    maturity: 'MATURED',
    outcome: 'TAKE_PROFIT',
    fillStatus: 'FILLED',
    exitStatus: 'TARGET_FILLED',
    ...overrides,
  }
}

function memoryStorage() {
  const objects = new Map()
  return {
    objects,
    hasStorage: () => true,
    async put(path, body, options) {
      if (options?.forbidOverwrite && objects.has(path)) {
        const error = new Error('exists')
        error.status = 409
        throw error
      }
      objects.set(path, JSON.parse(body))
      return { pathname: path }
    },
    async readJson(path) {
      return objects.get(path) || null
    },
    async list({ prefix, limit = 1000 }) {
      return {
        blobs: [...objects.keys()]
          .filter((path) => path.startsWith(prefix))
          .slice(0, limit)
          .map((pathname) => ({ pathname })),
      }
    },
  }
}

test('成熟结果按运行批次和股票写入不可变OSS对象', async () => {
  const storage = memoryStorage()
  const store = createOpportunityRadarOutcomeStore(storage)
  const value = outcome()

  await store.saveOutcome(value)

  const path = `${OPPORTUNITY_RADAR_OUTCOME_PREFIX}2026-09-02/`
    + 'close-1505/600001.json'
  assert.deepEqual(storage.objects.get(path), value)
  assert.deepEqual(await store.readOutcome(value), value)
})

test('重复结算返回首份结果且拒绝改写历史', async () => {
  const storage = memoryStorage()
  const store = createOpportunityRadarOutcomeStore(storage)
  const original = outcome()

  await store.saveOutcome(original)
  const replayed = await store.saveOutcome(outcome({
    outcome: 'STOP_LOSS',
  }))

  assert.deepEqual(replayed, original)
  assert.deepEqual(await store.listOutcomes(original), [original])
})

test('未成熟结果不能写入最终结果目录', async () => {
  const store = createOpportunityRadarOutcomeStore(memoryStorage())

  await assert.rejects(
    store.saveOutcome(outcome({
      maturity: 'PENDING',
      outcome: 'OPEN',
    })),
    /只持久化成熟结果/,
  )
})
