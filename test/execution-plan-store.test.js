import test from 'node:test'
import assert from 'node:assert/strict'

import { planStore } from '../src/planStore.js'
import { compileExecutionPlan } from '../shared/executionPlan.js'
import {
  dismissExecutionPlanInList,
  mergeExecutionPlans,
} from '../shared/executionPlanStore.js'

const now = Date.parse('2026-08-21T02:00:00.000Z')

function draftBuyPlan() {
  return compileExecutionPlan({
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: 'decision.buy-demo',
      action: 'BUY',
      actionLabel: '买入',
      actionability: 'READY',
      asOf: new Date(now).toISOString(),
      validUntil: new Date(now + 30 * 60000).toISOString(),
      quantity: { lots: 1 },
      prices: { reference: 10, stop: 9.5, target: 11 },
      costs: { estimatedNetAmount: 1005, estimatedFees: 5 },
      evidenceIds: ['ev_demo'],
      strategy: {
      },
      marketRegime: { regime: 'TREND_STRONG' },
    },
    code: '600000',
    name: '浦发银行',
    accountRevision: 1,
    now,
  })
}

function draftSellPlan() {
  const generatedAt = Date.now()
  return compileExecutionPlan({
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: 'decision.sell-demo',
      action: 'REDUCE',
      actionLabel: '减仓',
      actionability: 'READY',
      asOf: new Date(generatedAt).toISOString(),
      validUntil: new Date(generatedAt + 30 * 60000).toISOString(),
      quantity: { lots: 2 },
      prices: { reference: 10, stop: 9.5, target: 11 },
      costs: { estimatedNetAmount: 1990, estimatedFees: 10 },
      evidenceIds: ['ev_demo'],
      strategy: {
      },
      marketRegime: { regime: 'RISK_OFF' },
    },
    code: '600000',
    name: '浦发银行',
    accountRevision: 1,
    now: generatedAt,
  })
}

test('人工执行队列从建议草案到真实成交完整闭环', () => {
  planStore.setData({
    plan: [{ code: '600000', name: '浦发银行' }],
    holding: [],
    closed: [],
    account: { totalAssets: 100000, cash: 50000 },
    executionPlans: [],
    executionAttributions: [],
  })

  const armed = planStore.armExecutionPlan(draftBuyPlan(), now + 1)
  planStore.refreshExecutionPlans({
    '600000': { price: 9.98 },
  }, now + 2)
  const alerted = planStore.get().executionPlans.find(
    (plan) => plan.planId === armed.planId,
  )
  planStore.confirmExecutionPlan(armed.planId, now + 3)
  const trade = planStore.recordExecutionPlanTrade(
    armed.planId,
    10.02,
    1,
    now + 4,
  )
  const completed = planStore.get().executionPlans.find(
    (plan) => plan.planId === armed.planId,
  )

  assert.equal(alerted.status, 'ALERTED')
  assert.equal(trade.ok, true)
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(completed.fills.length, 1)
  assert.equal(planStore.get().holding[0].qty, 1)
  assert.equal(planStore.get().executionAttributions[0].status, 'COMPLETED')
  assert.equal(
    planStore.get().executionAttributions[0].learningEligible,
    false,
  )
})

test('加入队列时当前价已满足条件会立即进入已到价', () => {
  planStore.setData({
    plan: [{ code: '600000', name: '浦发银行' }],
    holding: [],
    closed: [],
    account: { totalAssets: 100000, cash: 50000 },
    executionPlans: [],
    executionAttributions: [],
  })

  const armed = planStore.armExecutionPlan(
    draftBuyPlan(),
    now + 1,
    9.98,
  )

  assert.equal(armed.status, 'ALERTED')
  assert.equal(planStore.get().executionPlans[0].status, 'ALERTED')
})

test('执行计划取消后不能再确认或录入成交', () => {
  planStore.setData({
    plan: [{ code: '600000', name: '浦发银行' }],
    holding: [],
    closed: [],
    account: { totalAssets: 100000, cash: 50000 },
    executionPlans: [],
  })
  const armed = planStore.armExecutionPlan(draftBuyPlan(), now + 1)
  planStore.cancelExecutionPlan(armed.planId, now + 2)

  assert.throws(
    () => planStore.confirmExecutionPlan(armed.planId, now + 3),
    /不允许|尚未到价/,
  )
  assert.deepEqual(
    planStore.recordExecutionPlanTrade(
      armed.planId,
      10,
      1,
      now + 4,
    ),
    { ok: false, error: '执行计划尚未确认或已结束' },
  )
})

test('移除执行计划使用同步标记且不会被旧设备数据恢复', () => {
  const armed = {
    ...draftSellPlan(),
    status: 'ARMED',
    updatedAt: now + 1,
  }
  const [dismissed] = dismissExecutionPlanInList(
    [armed],
    armed.planId,
    now + 2,
  )
  const [merged] = mergeExecutionPlans([dismissed], [armed])

  assert.equal(dismissed.status, 'CANCELED')
  assert.equal(dismissed.dismissedAt, now + 2)
  assert.equal(merged.dismissedAt, now + 2)
})

test('跨多笔持仓完成卖出计划时按全部成交汇总费后收益', () => {
  const boughtAt = Date.now() - 2 * 24 * 3600 * 1000
  planStore.setData({
    plan: [],
    holding: [
      {
        id: 'hold-1',
        code: '600000',
        name: '浦发银行',
        qty: 1,
        buyPrice: 8,
        buyAt: boughtAt,
      },
      {
        id: 'hold-2',
        code: '600000',
        name: '浦发银行',
        qty: 1,
        buyPrice: 9,
        buyAt: boughtAt,
      },
    ],
    closed: [],
    account: { totalAssets: 100000, cash: 50000 },
    executionPlans: [],
    executionAttributions: [],
  })

  const armed = planStore.armExecutionPlan(draftSellPlan())
  planStore.refreshExecutionPlans({
    '600000': { price: 10.1 },
  })
  planStore.confirmExecutionPlan(armed.planId)
  const result = planStore.recordExecutionPlanTrade(
    armed.planId,
    10.1,
    2,
  )
  const realizedPnl = planStore.get().closed
    .filter((trade) => trade.type === 'SELL')
    .reduce((sum, trade) => sum + Number(trade.realizedPnl || 0), 0)
  const attribution = planStore.get().executionAttributions[0]

  assert.equal(result.ok, true)
  assert.equal(attribution.status, 'COMPLETED')
  assert.equal(attribution.learningEligible, true)
  assert.equal(attribution.netPnl, realizedPnl)
  assert.equal(attribution.entryPrice, 8.5)
  assert.ok(attribution.holdingDurationMinutes > 0)
  assert.equal(attribution.mfePct, null)
  assert.equal(attribution.maePct, null)
})
