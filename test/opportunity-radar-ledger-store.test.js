import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPPORTUNITY_RADAR_LEDGER_PREFIX,
  createOpportunityRadarLedgerStore,
} from '../api/_opportunity_radar_ledger_store.js'

function batch(overrides = {}) {
  return {
    schemaVersion: 'opportunity-radar-ledger.v1',
    runId: '2026-09-02:intraday:0600',
    tradeDate: '2026-09-02',
    mode: 'INTRADAY',
    slot: '0600',
    generatedAt: 1_788_320_000_000,
    summary: { total: 1 },
    events: [{ code: '600001' }],
    ...overrides,
  }
}

function memoryStorage() {
  const objects = new Map()
  return {
    objects,
    hasStorage: () => true,
    put: async (path, body, options) => {
      if (options?.forbidOverwrite && objects.has(path)) {
        const error = new Error('exists')
        error.status = 409
        throw error
      }
      objects.set(path, JSON.parse(body))
      return { pathname: path }
    },
    readJson: async (path) => objects.get(path) || null,
  }
}

test('机会雷达账本按运行批次写入不可变OSS对象', async () => {
  const storage = memoryStorage()
  const store = createOpportunityRadarLedgerStore(storage)
  const value = batch()

  await store.saveBatch(value)

  const path =
    `${OPPORTUNITY_RADAR_LEDGER_PREFIX}events/2026-09-02/`
    + 'intraday-0600.json'
  assert.deepEqual(storage.objects.get(path), value)
  assert.deepEqual(await store.readBatch({
    tradeDate: '2026-09-02',
    mode: 'intraday',
    slot: '0600',
  }), value)
})

test('相同运行批次重复保存返回原对象且禁止历史改写', async () => {
  const storage = memoryStorage()
  const store = createOpportunityRadarLedgerStore(storage)
  const original = batch()

  await store.saveBatch(original)
  const replayed = await store.saveBatch(batch({
    summary: { total: 99 },
  }))

  assert.deepEqual(replayed, original)
})
