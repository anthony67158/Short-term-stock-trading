import test from 'node:test'
import assert from 'node:assert/strict'
import {
  actualBarrierClass,
  aggregateV2Accuracy,
  mergeV2Accuracy,
  nextTradingSession,
} from '../shared/v2Accuracy.js'
import { listV2PredictionKeys } from '../api/_v2_accuracy_store.js'

const bar = (tradeTime, open, high, low, close = open) => ({
  tradeTime, open, high, low, close, volume: 1000,
})

test('下一交易日标签使用首根开盘并按止损优先判三重障碍', () => {
  const bars = [
    bar('2026-08-10 15:00:00', 10, 10, 10),
    bar('2026-08-11 09:35:00', 10, 10.05, 9.95),
    bar('2026-08-11 09:40:00', 10, 10.12, 9.95),
  ]
  const session = nextTradingSession(bars, '2026-08-10')
  assert.equal(session.length, 2)
  assert.equal(actualBarrierClass(session), 'TAKE_PROFIT')

  const bothHit = [
    bar('2026-08-11 09:35:00', 10, 10.2, 9.9),
  ]
  assert.equal(actualBarrierClass(bothHit), 'STOP_LOSS')
})

test('同股同信号日只保留最新预测并按日汇总正确率', () => {
  const predictions = [
    {
      requestId: 'old',
      code: '600519.SH',
      asOf: '2026-08-10 15:00:00',
      recordedAt: 100,
      predictedClass: 'STOP_LOSS',
      actualClass: 'TAKE_PROFIT',
    },
    {
      requestId: 'latest',
      code: '600519.SH',
      asOf: '2026-08-10 15:00:00',
      recordedAt: 200,
      predictedClass: 'TAKE_PROFIT',
      actualClass: 'TAKE_PROFIT',
    },
    {
      requestId: 'second',
      code: '000001.SZ',
      asOf: '2026-08-10 15:00:00',
      recordedAt: 150,
      predictedClass: 'TIMEOUT',
      actualClass: 'STOP_LOSS',
    },
  ]
  const result = aggregateV2Accuracy(predictions)

  assert.equal(result.overall.total, 2)
  assert.equal(result.overall.correct, 1)
  assert.equal(result.overall.accuracyPct, 50)
  assert.deepEqual(result.days, [{
    date: '2026-08-10',
    total: 2,
    correct: 1,
    accuracyPct: 50,
  }])
})

test('冒烟请求和未产生真实标签的记录不计入正确率', () => {
  const result = aggregateV2Accuracy([
    {
      requestId: 'shadow_eas_smoke_1',
      code: '600519.SH',
      asOf: '2026-08-10 15:00:00',
      predictedClass: 'TAKE_PROFIT',
      actualClass: 'TAKE_PROFIT',
    },
    {
      requestId: 'real',
      code: '000001.SZ',
      asOf: '2026-08-10 15:00:00',
      predictedClass: 'TIMEOUT',
    },
  ])
  assert.equal(result.overall.total, 0)
})

test('增量刷新保留旧日期并用新结算结果覆盖同一天', () => {
  const existing = {
    updatedAt: 100,
    overall: { total: 3, correct: 2, accuracyPct: 66.7 },
    days: [
      { date: '2026-08-01', total: 1, correct: 1, accuracyPct: 100 },
      { date: '2026-08-10', total: 2, correct: 1, accuracyPct: 50 },
    ],
  }
  const fresh = {
    updatedAt: 200,
    overall: { total: 3, correct: 3, accuracyPct: 100 },
    days: [
      { date: '2026-08-10', total: 3, correct: 3, accuracyPct: 100 },
    ],
  }

  const merged = mergeV2Accuracy(existing, fresh, 300)

  assert.deepEqual(merged.days, [
    { date: '2026-08-10', total: 3, correct: 3, accuracyPct: 100 },
    { date: '2026-08-01', total: 1, correct: 1, accuracyPct: 100 },
  ])
  assert.deepEqual(merged.overall, {
    total: 4,
    correct: 4,
    accuracyPct: 100,
  })
  assert.equal(merged.updatedAt, 300)
})

test('按日期分页读取预测记录不受全局5000条上限截断', async () => {
  const total = 6001
  const client = {
    async list({ prefix, marker, 'max-keys': pageSize }) {
      assert.equal(prefix, 'shadow/predictions/2026-08-10/')
      const start = Number(marker || 0)
      const end = Math.min(total, start + pageSize)
      return {
        objects: Array.from(
          { length: end - start },
          (_, index) => ({ name: `${prefix}${start + index}.json` }),
        ),
        nextMarker: end < total ? String(end) : null,
      }
    },
  }

  const keys = await listV2PredictionKeys(client, {
    from: '2026-08-10',
    to: '2026-08-10',
  })

  assert.equal(keys.length, total)
  assert.equal(keys.at(-1), 'shadow/predictions/2026-08-10/6000.json')
})
