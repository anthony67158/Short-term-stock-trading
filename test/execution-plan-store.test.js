import test from 'node:test'
import assert from 'node:assert/strict'

import { planStore } from '../src/planStore.js'
import { compileExecutionPlan } from '../shared/executionPlan.js'
import {
  dismissExecutionPlanInList,
  expireExecutionPlansForAccountChange,
  mergeExecutionPlans,
} from '../shared/executionPlanStore.js'

const now = Date.parse('2026-08-21T02:00:00.000Z')

function draftBuyPlan({
  code = '600000',
  decisionId = 'decision.buy-demo',
} = {}) {
  return compileExecutionPlan({
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId,
      action: 'BUY',
      actionLabel: '买入',
      actionability: 'READY',
      asOf: new Date(now).toISOString(),
      validUntil: new Date(now + 30 * 60000).toISOString(),
      quantity: { lots: 1 },
      prices: { reference: 10, stop: 9.5, target: 11 },
      costs: { estimatedNetAmount: 1005, estimatedFees: 5 },
      targetPosition: {
        state: 'READY',
        maxBuyPrice: 10,
      },
      evidenceIds: ['ev_demo'],
      strategy: {
      },
      marketRegime: { regime: 'TREND_STRONG' },
    },
    code,
    name: '浦发银行',
    accountRevision: 1,
    now,
  })
}

function draftSellPlan({
  code = '600000',
  lots = 2,
  decisionId = 'decision.sell-demo',
} = {}) {
  const generatedAt = Date.now()
  return compileExecutionPlan({
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId,
      action: 'REDUCE',
      actionLabel: '减仓',
      actionability: 'READY',
      asOf: new Date(generatedAt).toISOString(),
      validUntil: new Date(generatedAt + 30 * 60000).toISOString(),
      quantity: { lots },
      prices: { reference: 10, stop: 9.5, target: 11 },
      costs: { estimatedNetAmount: 1990, estimatedFees: 10 },
      risk: {
        modelPriceRiskPerShare: 0.5,
        modelExpectedNetR: -0.2,
      },
      evidenceIds: ['ev_demo'],
      strategy: {
      },
      marketRegime: { regime: 'RISK_OFF' },
    },
    code,
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
  planStore.confirmExecutionPlan(armed.planId, now + 3, 10)
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

test('买入计划确认时必须再次校验最新价格且缺价失败关闭', () => {
  planStore.setData({
    plan: [{ code: '600000', name: '浦发银行' }],
    holding: [],
    closed: [],
    account: { totalAssets: 100000, cash: 50000 },
    executionPlans: [],
  })
  const armed = planStore.armExecutionPlan(
    draftBuyPlan(),
    now + 1,
    9.98,
  )

  assert.throws(
    () => planStore.confirmExecutionPlan(armed.planId, now + 2),
    /最新价格/,
  )
  assert.throws(
    () => planStore.confirmExecutionPlan(
      armed.planId,
      now + 2,
      10.01,
    ),
    /超过买入上限/,
  )
  const confirmed = planStore.confirmExecutionPlan(
    armed.planId,
    now + 2,
    10,
  )
  assert.equal(confirmed.status, 'USER_CONFIRMED')
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

test('两个已完成版本合并保留较新的移除标记与原成交', () => {
  const completed = {
    ...draftSellPlan(), status: 'COMPLETED', filledLots: 2,
    fills: [{ transactionId: 'actual-fill', lots: 2 }], updatedAt: now,
  }
  const [dismissed] = dismissExecutionPlanInList([completed], completed.planId, now + 10)
  for (const pair of [[dismissed, completed], [completed, dismissed]]) {
    const [merged] = mergeExecutionPlans([pair[0]], [pair[1]])
    assert.equal(merged.dismissedAt, now + 10)
    assert.equal(merged.status, 'COMPLETED')
    assert.deepEqual(merged.fills, completed.fills)
  }
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

test('卖出计划数量超过可卖手数时先失败且账本保持原子不变', () => {
  const boughtAt = Date.now() - 2 * 24 * 3600 * 1000
  planStore.setData({
    plan: [],
    holding: [{
      id: 'hold-atomic',
      code: '600000',
      name: '浦发银行',
      qty: 3,
      buyPrice: 9,
      buyAt: boughtAt,
      buyFee: 5,
    }],
    closed: [{
      id: 'today-buy',
      type: 'BUY',
      code: '600000',
      qty: 1,
      price: 9.5,
      at: Date.now(),
    }],
    account: { totalAssets: 100000, cash: 50000 },
    executionPlans: [],
    executionAttributions: [],
  })
  const armed = planStore.armExecutionPlan(
    draftSellPlan({ lots: 3 }),
  )
  planStore.refreshExecutionPlans({
    '600000': { price: 10.1 },
  })
  planStore.confirmExecutionPlan(armed.planId)
  const before = structuredClone({
    holding: planStore.get().holding,
    closed: planStore.get().closed,
    cash: planStore.get().account.cash,
  })

  const result = planStore.recordExecutionPlanTrade(
    armed.planId,
    10.1,
    3,
  )

  assert.equal(result.ok, false)
  assert.match(result.error, /最多可记录2手/)
  assert.deepEqual(planStore.get().holding, before.holding)
  assert.deepEqual(planStore.get().closed, before.closed)
  assert.equal(planStore.get().account.cash, before.cash)
})

test('异股减风险成交不会使已确认卖出计划失效', () => {
  const boughtAt = Date.now() - 2 * 24 * 3600 * 1000
  planStore.setData({
    plan: [],
    holding: [
      {
        id: 'hold-a',
        code: '600000',
        name: '浦发银行',
        qty: 1,
        buyPrice: 9,
        buyAt: boughtAt,
      },
      {
        id: 'hold-b',
        code: '600001',
        name: '测试银行',
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
  const first = planStore.armExecutionPlan(
    draftSellPlan({
      code: '600000',
      lots: 1,
      decisionId: 'decision.sell-a',
    }),
  )
  const second = planStore.armExecutionPlan(
    draftSellPlan({
      code: '600001',
      lots: 1,
      decisionId: 'decision.sell-b',
    }),
  )
  planStore.refreshExecutionPlans({
    '600000': { price: 10.1 },
    '600001': { price: 10.1 },
  })
  planStore.confirmExecutionPlan(first.planId)
  planStore.confirmExecutionPlan(second.planId)

  const result = planStore.recordExecutionPlanTrade(
    first.planId,
    10.1,
    1,
  )
  const preserved = planStore.get().executionPlans.find(
    (plan) => plan.planId === second.planId,
  )

  assert.equal(result.ok, true)
  assert.equal(preserved.status, 'USER_CONFIRMED')
})

test('账户变化只让受影响计划失效并重绑定安全计划指纹', () => {
  const plans = [
    { ...draftSellPlan({
      code: '600001',
      decisionId: 'decision.keep-sell',
    }), status: 'USER_CONFIRMED' },
    { ...draftBuyPlan({
      code: '600002',
      decisionId: 'decision.expire-buy',
    }), status: 'USER_CONFIRMED' },
  ]
  const updated = expireExecutionPlansForAccountChange(plans, {
    changedCode: '600000',
    changedSide: 'BUY',
    accountTradeFingerprint: 'new-fingerprint',
    now,
  })

  assert.equal(updated[0].status, 'USER_CONFIRMED')
  assert.equal(
    updated[0].accountTradeFingerprint,
    'new-fingerprint',
  )
  assert.equal(updated[1].status, 'EXPIRED')
})
