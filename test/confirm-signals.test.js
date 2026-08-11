import test from 'node:test'
import assert from 'node:assert/strict'

import { deterministicJudge, intradayPrimitives, judgeConfirmation } from '../api/_confirm.js'

test('分时原语包含VWAP连续性、窗口回撤和反弹幅度', () => {
  const trends = Array.from({ length: 10 }, (_, index) => ({
    time: `10:${String(index).padStart(2, '0')}`,
    price: [10, 10.1, 10.2, 10.3, 10.4, 10.35, 10.3, 10.25, 10.2, 10.15][index],
    volume: index < 5 ? 100 : 180,
    avg: 10.2,
  }))

  const prim = intradayPrimitives(trends, 10)

  assert.equal(prim.aboveVwapCount3, 2)
  assert.equal(prim.drawdownFromHighPct < 0, true)
  assert.equal(prim.bounceFromLowPct > 0, true)
  assert.equal(prim.volSurge, true)
})

test('买点下方持续走弱时客观判定为失效', () => {
  const result = deterministicJudge('buy', {
    keyDistancePct: -1.5,
    aboveVwap: false,
    mom5Pct: -0.4,
    higherLows: false,
  }, null)

  assert.equal(result.decision, 'invalid')
})

test('止盈触价后回撤并跌破VWAP达到客观确认门槛', () => {
  const result = deterministicJudge('sell', {
    lowerHighs: true,
    aboveVwap: false,
    mom5Pct: -0.25,
    drawdownFromHighPct: -0.4,
    sinceTouchPct: -0.2,
    volSurge: false,
  }, null)

  assert.equal(result.decision, 'confirm')
  assert.equal(result.score >= 1.5, true)
})

test('最新军师已转为减仓时旧加仓点直接失效', async () => {
  const result = await judgeConfirmation({
    alert: {
      code: '600000',
      actKind: 'add',
      note: '补仓点',
      value: 10,
    },
    advice: {
      action: '减仓',
      actionPlan: '反弹到10.5元减仓1手',
      addPrice: 10,
    },
  })

  assert.equal(result.decision, 'invalid')
  assert.equal(result.actionIntent, 'add')
  assert.equal(result.policy, 'advice-mismatch')
  assert.match(result.reason, /不再支持加仓/)
})
