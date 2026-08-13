import test from 'node:test'
import assert from 'node:assert/strict'
import { planStore } from '../src/planStore.js'
import { summarizeAdviceOutcomes } from '../shared/adviceOutcome.js'

test('持有建议不因盘中插针跌破止损而误判失败', () => {
  planStore.setData({
    plan: [],
    holding: [],
    closed: [],
    adviceLog: [{
      id: 'hold-1',
      code: '600000',
      mode: 'hold_advice',
      action: '持有',
      at: new Date('2026-08-01T15:00:00+08:00').getTime(),
      priceAtAdvice: 10,
      stop: 9.5,
      verified: false,
      hit: null,
    }],
  })

  planStore.verifyAdvice({
    '600000': [
      { date: '2026-08-03', open: 10, high: 10.1, low: 9.4, close: 9.9 },
      { date: '2026-08-04', open: 9.9, high: 10.2, low: 9.8, close: 10 },
      { date: '2026-08-05', open: 10, high: 10.3, low: 9.9, close: 10.1 },
    ],
  })

  const record = planStore.get().adviceLog[0]
  assert.equal(record.verified, true)
  assert.equal(record.hit, true)
  assert.match(record.verifyNote, /收盘/)
  assert.equal(planStore.adviceStats().winRate, 100)
})

test('旧口径已核验的持有建议会先退出统计并按当前口径重算', () => {
  planStore.setData({
    plan: [],
    holding: [],
    closed: [],
    adviceLog: [{
      id: 'legacy-hold-1',
      code: '600001',
      mode: 'hold_advice',
      action: '继续持有',
      at: new Date('2026-08-01T15:00:00+08:00').getTime(),
      priceAtAdvice: 10,
      stop: 9.5,
      target: 10.8,
      verified: true,
      hit: false,
      resultPct: 1.3,
    }],
  })

  const staleStats = planStore.adviceStats()
  assert.equal(staleStats.total, 0)
  assert.equal(staleStats.pending, 1)

  planStore.verifyAdvice({
    '600001': [
      { date: '2026-08-03', open: 10, high: 10.2, low: 9.8, close: 10.1 },
      { date: '2026-08-04', open: 10.1, high: 10.3, low: 10, close: 10.2 },
      { date: '2026-08-05', open: 10.2, high: 10.4, low: 10.1, close: 10.3 },
    ],
  })

  const record = planStore.get().adviceLog[0]
  assert.equal(record.verified, true)
  assert.equal(record.hit, true)
  assert.equal(Number.isInteger(record.outcomePolicyVersion), true)
  assert.match(record.verifyNote, /持有期末收盘/)
  assert.equal(planStore.adviceStats().winRate, 100)
})

test('K线未覆盖建议后的首个交易日时不使用近期行情误重算', () => {
  planStore.setData({
    plan: [],
    holding: [],
    closed: [],
    adviceLog: [{
      id: 'legacy-too-old',
      code: '600002',
      mode: 'hold_advice',
      action: '继续持有',
      at: new Date('2026-08-01T15:00:00+08:00').getTime(),
      priceAtAdvice: 10,
      stop: 9.5,
      verified: true,
      hit: false,
      resultPct: -1,
    }],
  })

  planStore.verifyAdvice({
    '600002': [
      { date: '2026-08-20', open: 10, high: 10.2, low: 9.9, close: 10.1 },
      { date: '2026-08-21', open: 10.1, high: 10.3, low: 10, close: 10.2 },
      { date: '2026-08-24', open: 10.2, high: 10.4, low: 10.1, close: 10.3 },
    ],
  })

  const record = planStore.get().adviceLog[0]
  assert.equal(record.outcomePolicyVersion, undefined)
  assert.equal(planStore.adviceStats().total, 0)
  assert.equal(planStore.adviceStats().pending, 1)
})

test('军师战绩按独立决策回合统计而不是重复刷新次数', () => {
  const day1 = new Date('2026-08-10T10:00:00+08:00').getTime()
  const day2 = new Date('2026-08-11T10:00:00+08:00').getTime()
  const records = [
    {
      id: 'refresh-1',
      code: '600000',
      mode: 'hold_advice',
      action: '持有',
      at: day1,
      verified: true,
      hit: false,
      resultPct: -3,
      outcomePolicyVersion: 2,
    },
    {
      id: 'refresh-2',
      code: '600000',
      mode: 'hold_advice',
      action: '继续持有',
      at: day1 + 30 * 60 * 1000,
      verified: true,
      hit: false,
      resultPct: -3,
      outcomePolicyVersion: 2,
    },
    {
      id: 'next-day',
      code: '600000',
      mode: 'hold_advice',
      action: '持有',
      at: day2,
      verified: true,
      hit: true,
      resultPct: 1,
      outcomePolicyVersion: 2,
    },
  ]

  const stats = summarizeAdviceOutcomes(records)

  assert.equal(stats.total, 2)
  assert.equal(stats.hit, 1)
  assert.equal(stats.winRate, 50)
  assert.equal(stats.raw.total, 3)
  assert.equal(stats.duplicateRefreshes, 1)
})
