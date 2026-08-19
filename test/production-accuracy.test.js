import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRODUCTION_ACCURACY_KEY,
  loadProductionAccuracy,
  normalizeProductionAccuracy,
} from '../api/_production_accuracy_store.js'

test('生产模型回测报告只公开实际命中汇总并重新计算百分比', () => {
  const normalized = normalizeProductionAccuracy({
    schemaVersion: 'production-accuracy.v1',
    mode: 'forwardUnseenBacktest',
    updatedAt: 123,
    model: {
      trainedAt: 1786593727,
      dataEndDate: '2026-08-06',
      horizonDays: 5,
      featureCount: 36,
      targetRule: 'private implementation detail',
    },
    overall: {
      total: 600,
      correct: 372,
      accuracyPct: 99,
      balancedAccuracyPct: 60.8,
    },
    strongSignals: {
      total: 240,
      correct: 161,
      accuracyPct: 1,
      coveragePct: 40,
      positiveThresholdPct: 62,
      negativeThresholdPct: 38,
    },
    nextTradeDayDirection: {
      total: 600,
      correct: 330,
      accuracyPct: 1,
    },
    nextTradeDayRange: {
      total: 600,
      covered: 480,
      coveragePct: 1,
      nominalCoveragePct: 80,
    },
    days: [
      { date: '2026-08-10', total: 300, correct: 190, accuracyPct: 1 },
      { date: '2026-08-07', total: 300, correct: 182, accuracyPct: 1 },
    ],
    sampleWindow: {
      from: '2026-08-07',
      to: '2026-08-10',
      tradingDates: 2,
    },
    rawPredictions: [{ code: '600519', probability: 0.9 }],
  })

  assert.deepEqual(normalized, {
    available: true,
    mode: 'forwardUnseenBacktest',
    updatedAt: 123,
    model: {
      trainedAt: 1786593727,
      dataEndDate: '2026-08-06',
      horizonDays: 5,
      featureCount: 36,
    },
    overall: {
      total: 600,
      correct: 372,
      accuracyPct: 62,
      balancedAccuracyPct: 60.8,
    },
    strongSignals: {
      total: 240,
      correct: 161,
      accuracyPct: 67.1,
      coveragePct: 40,
      positiveThresholdPct: 62,
      negativeThresholdPct: 38,
    },
    nextTradeDayDirection: {
      total: 600,
      correct: 330,
      accuracyPct: 55,
    },
    nextTradeDayRange: {
      total: 600,
      covered: 480,
      coveragePct: 80,
      nominalCoveragePct: 80,
    },
    days: [
      { date: '2026-08-10', total: 300, correct: 190, accuracyPct: 63.3 },
      { date: '2026-08-07', total: 300, correct: 182, accuracyPct: 60.7 },
    ],
    historyDays: [
      {
        date: '2026-08-10',
        total: 300,
        correct: 190,
        accuracyPct: 63.3,
        modelDataEndDate: '2026-08-06',
        modelTrainedAt: 1786593727,
      },
      {
        date: '2026-08-07',
        total: 300,
        correct: 182,
        accuracyPct: 60.7,
        modelDataEndDate: '2026-08-06',
        modelTrainedAt: 1786593727,
      },
    ],
    sampleWindow: {
      from: '2026-08-07',
      to: '2026-08-10',
      tradingDates: 2,
    },
  })
  assert.equal(JSON.stringify(normalized).includes('600519'), false)
  assert.equal(JSON.stringify(normalized).includes('private implementation detail'), false)
})

test('生产模型回测从稳定OSS对象读取，缺失时返回待积累状态', async () => {
  let readKey = ''
  const loaded = await loadProductionAccuracy({
    read: async (key) => {
      readKey = key
      return {
        schemaVersion: 'production-accuracy.v1',
        overall: { total: 2, correct: 1, balancedAccuracyPct: 50 },
      }
    },
  })
  assert.equal(readKey, PRODUCTION_ACCURACY_KEY)
  assert.equal(loaded.available, true)
  assert.equal(loaded.overall.accuracyPct, 50)

  const missing = await loadProductionAccuracy({
    read: async () => null,
  })
  assert.equal(missing.available, false)
  assert.equal(missing.overall.total, 0)
  assert.equal(missing.nextTradeDayDirection.total, 0)
  assert.equal(missing.nextTradeDayRange.total, 0)
})

test('生产模型回测保留全部日记录而不是只返回最近三十日', () => {
  const days = Array.from({ length: 35 }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    total: 10,
    correct: index % 10,
  }))

  const normalized = normalizeProductionAccuracy({
    schemaVersion: 'production-accuracy.v1',
    overall: { total: 350, correct: 175 },
    days,
  })

  assert.equal(normalized.days.length, 35)
  assert.equal(normalized.days[0].date, '2026-07-35')
  assert.equal(normalized.days.at(-1).date, '2026-07-01')
})
