import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateV21Accuracy,
  settleV21Prediction,
} from '../shared/v21Accuracy.js'

function bars() {
  return [
    ['2026-08-12 10:30:00', 10, 10.01, 9.99, 10],
    ['2026-08-12 10:35:00', 10, 10.02, 9.99, 10],
    ['2026-08-12 10:40:00', 10, 10.05, 9.99, 10.04],
    ['2026-08-12 10:45:00', 10.04, 10.05, 10.02, 10.03],
    ['2026-08-12 10:50:00', 10.03, 10.04, 10.01, 10.02],
    ['2026-08-12 10:55:00', 10.02, 10.03, 10.00, 10.01],
    ['2026-08-12 11:00:00', 10.01, 10.02, 9.99, 10],
    ['2026-08-12 14:55:00', 10, 10.01, 9.94, 9.95],
    ['2026-08-12 15:00:00', 9.95, 9.96, 9.93, 9.94],
  ].map(([tradeTime, open, high, low, close]) => ({
    tradeTime, open, high, low, close, volume: 1000,
  }))
}

test('V2.1两个预测头按各自真实路径独立结算', () => {
  const settled = settleV21Prediction({
    code: '600519.SH',
    asOf: '2026-08-12 10:30:00',
    session: 'morning',
    heads: {
      next30m: {
        predictedClass: 'TAKE_PROFIT',
        targetDefinition: { takeProfitPct: 0.45, stopLossPct: 0.30 },
      },
      sessionClose: {
        predictedClass: 'TIMEOUT',
        targetDefinition: { takeProfitPct: 0.80, stopLossPct: 0.50 },
      },
    },
  }, bars())

  assert.equal(settled.heads.next30m.actualClass, 'TAKE_PROFIT')
  assert.equal(settled.heads.next30m.correct, true)
  assert.equal(settled.heads.sessionClose.actualClass, 'STOP_LOSS')
  assert.equal(settled.heads.sessionClose.correct, false)
})

test('V2.1正确率按预测头和盘中时段分开汇总', () => {
  const summary = aggregateV21Accuracy([
    {
      date: '2026-08-12',
      session: 'morning',
      heads: {
        next30m: { correct: true },
        sessionClose: { correct: false },
      },
    },
    {
      date: '2026-08-12',
      session: 'noon',
      heads: {
        next30m: { correct: true },
        sessionClose: { correct: true },
      },
    },
  ], 123)

  assert.deepEqual(summary.heads.next30m, {
    total: 2,
    correct: 2,
    accuracyPct: 100,
  })
  assert.deepEqual(summary.heads.sessionClose, {
    total: 2,
    correct: 1,
    accuracyPct: 50,
  })
  assert.equal(summary.sessions.morning.heads.sessionClose.accuracyPct, 0)
  assert.equal(summary.sessions.noon.heads.sessionClose.accuracyPct, 100)
  assert.equal(summary.updatedAt, 123)
})
