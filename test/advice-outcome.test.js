import test from 'node:test'
import assert from 'node:assert/strict'
import { planStore } from '../src/planStore.js'

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
