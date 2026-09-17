import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LEARNING_EVENT_KIND,
  buildLearningEvent,
  learningAccountHash,
  learningEventPath,
} from '../shared/learningEvent.js'
import {
  createLearningStore,
} from '../api/_learning_store.js'

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
    },
    async readJson(path) {
      return objects.get(path) || null
    },
    async list({ prefix, limit }) {
      return {
        blobs: [...objects.keys()]
          .filter((path) => path.startsWith(prefix))
          .sort()
          .slice(0, limit)
          .map((pathname) => ({ pathname })),
      }
    },
  }
}

function prediction(overrides = {}) {
  return buildLearningEvent({
    kind: LEARNING_EVENT_KIND.STOCK_PICK_PREDICTION,
    sourceId: 'stock-pick:2026-09-17:run-1',
    tradeDate: '2026-09-17',
    occurredAt: Date.parse('2026-09-17T07:10:00Z'),
    payload: {
      modelVersion: 'ranking-v1',
      candidates: [{ code: '600000', score: 0.81 }],
    },
    ...overrides,
  })
}

test('学习事件使用稳定内容哈希且账户只保存不可逆摘要', () => {
  const first = prediction({ accountScope: 'account@example' })
  const second = prediction({ accountScope: 'account@example' })

  assert.equal(first.contentHash, second.contentHash)
  assert.equal(first.accountHash, learningAccountHash('account@example'))
  assert.equal(JSON.stringify(first).includes('account@example'), false)
  assert.match(
    learningEventPath(first),
    /^learning\/v1\/stock-pick-prediction\/2026-09-17\//,
  )
})

test('同一事件允许幂等重放但禁止用不同内容覆盖', async () => {
  const storage = memoryStorage()
  const store = createLearningStore(storage)
  const original = prediction()

  await store.saveEvent(original)
  assert.deepEqual(await store.saveEvent(prediction()), original)

  await assert.rejects(
    store.saveEvent(prediction({
      payload: {
        modelVersion: 'ranking-v2',
        candidates: [{ code: '600000', score: 0.92 }],
      },
    })),
    /LEARNING_EVENT_IMMUTABLE_CONFLICT/,
  )
  assert.deepEqual(await store.readEvent(original), original)
})

test('学习事件可以按类型和交易日枚举', async () => {
  const store = createLearningStore(memoryStorage())
  await store.saveEvent(prediction())
  await store.saveEvent(prediction({
    sourceId: 'stock-pick:2026-09-18:run-2',
    tradeDate: '2026-09-18',
  }))

  const events = await store.listEvents({
    kind: LEARNING_EVENT_KIND.STOCK_PICK_PREDICTION,
    tradeDate: '2026-09-17',
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].tradeDate, '2026-09-17')
})
