import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileExecutionPlan,
  recordExecutionFill,
  refreshExecutionPlan,
  transitionExecutionPlan,
} from '../shared/executionPlan.js'

const now = Date.parse('2026-08-21T02:00:00.000Z')

function decision(overrides = {}) {
  return {
    schemaVersion: 'decision-plan.v2',
    decisionId: 'decision.demo',
    action: 'REDUCE',
    actionLabel: '减仓',
    actionability: 'READY',
    asOf: new Date(now).toISOString(),
    validUntil: new Date(now + 30 * 60000).toISOString(),
    quantity: { lots: 4 },
    prices: {
      reference: 10,
      stop: 9.5,
      target: 11,
    },
    costs: {
      estimatedFees: 8,
      estimatedNetAmount: 3992,
    },
    trigger: '反弹到10元且承接转弱',
    invalidation: '放量站稳11元',
    evidenceIds: ['ev_demo'],
    ...overrides,
  }
}

test('execution-plan.v1绑定决策、账户版本、证据和有效期', () => {
  const plan = compileExecutionPlan({
    decisionPlan: decision(),
    code: '600000',
    name: '浦发银行',
    accountRevision: 7,
    adv20: 200_000_000,
    now,
  })

  assert.equal(plan.schemaVersion, 'execution-plan.v1')
  assert.equal(plan.decisionId, 'decision.demo')
  assert.equal(plan.accountRevision, 7)
  assert.equal(plan.evidenceAsOf, new Date(now).toISOString())
  assert.equal(plan.status, 'DRAFT')
  assert.equal(plan.canArm, true)
  assert.equal(plan.side, 'SELL')
  assert.equal(plan.targetLots, 4)
  assert.equal(plan.remainingLots, 4)
  assert.equal(plan.reservedCash, 0)
  assert.equal(plan.pendingSellLots, 4)
})

test('执行方式按金额、流动性和数据质量选择且分批合计不超目标', () => {
  const sliced = compileExecutionPlan({
    decisionPlan: decision({
      action: 'BUY',
      actionLabel: '买入',
      quantity: { lots: 4 },
      costs: { estimatedNetAmount: 400_000, estimatedFees: 20 },
    }),
    code: '600000',
    accountRevision: 1,
    adv20: 5_000_000,
    urgency: 'NORMAL',
    now,
  })
  const vwap = compileExecutionPlan({
    decisionPlan: decision({
      action: 'BUY',
      actionLabel: '买入',
      quantity: { lots: 6 },
      costs: { estimatedNetAmount: 600_000, estimatedFees: 30 },
    }),
    code: '600000',
    accountRevision: 1,
    adv20: 8_000_000,
    volumeCurve: [0.12, 0.18, 0.22, 0.2, 0.16, 0.12],
    now,
  })

  assert.equal(sliced.executionMethod.type, 'SLICED_LIMIT')
  assert.equal(
    sliced.slices.reduce((sum, item) => sum + item.lots, 0),
    sliced.targetLots,
  )
  assert.ok(sliced.slices.length >= 2 && sliced.slices.length <= 4)
  assert.equal(vwap.executionMethod.type, 'VWAP_REFERENCE')
  assert.equal(vwap.executionMethod.volumeCurveReliable, true)
})

test('没有可靠分钟量曲线时绝不冒充VWAP', () => {
  const plan = compileExecutionPlan({
    decisionPlan: decision({
      action: 'BUY',
      actionLabel: '买入',
      quantity: { lots: 8 },
      costs: { estimatedNetAmount: 800_000, estimatedFees: 40 },
    }),
    code: '600000',
    accountRevision: 1,
    adv20: 10_000_000,
    volumeCurve: null,
    urgency: 'LOW',
    now,
  })

  assert.notEqual(plan.executionMethod.type, 'VWAP_REFERENCE')
  assert.equal(plan.executionMethod.volumeCurveReliable, false)
})

test('只有真实人工成交才能推进部分完成和完成状态', () => {
  const draft = compileExecutionPlan({
    decisionPlan: decision(),
    code: '600000',
    accountRevision: 7,
    now,
  })
  const armed = transitionExecutionPlan(draft, 'ARM', { now: now + 1 })
  const alerted = transitionExecutionPlan(armed, 'PRICE_TRIGGERED', {
    now: now + 2,
    price: 10.1,
  })
  const confirmed = transitionExecutionPlan(alerted, 'USER_CONFIRM', {
    now: now + 3,
  })
  const partial = recordExecutionFill(confirmed, {
    fillId: 'fill-1',
    lots: 1,
    price: 10.08,
    fee: 5,
    at: now + 4,
    manuallyRecorded: true,
  })
  const completed = recordExecutionFill(partial, {
    fillId: 'fill-2',
    lots: 3,
    price: 10.12,
    fee: 5,
    at: now + 5,
    manuallyRecorded: true,
  })

  assert.equal(armed.status, 'ARMED')
  assert.equal(alerted.status, 'ALERTED')
  assert.equal(confirmed.status, 'USER_CONFIRMED')
  assert.equal(partial.status, 'PARTIALLY_RECORDED')
  assert.equal(partial.remainingLots, 3)
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(completed.remainingLots, 0)
  assert.throws(
    () => recordExecutionFill(confirmed, {
      fillId: 'fake',
      lots: 1,
      price: 10,
      at: now + 4,
      manuallyRecorded: false,
    }),
    /人工成交/,
  )
})

test('账户版本变化或有效期届满会使旧计划过期', () => {
  const draft = compileExecutionPlan({
    decisionPlan: decision(),
    code: '600000',
    accountRevision: 7,
    now,
  })
  const armed = transitionExecutionPlan(draft, 'ARM', { now: now + 1 })

  assert.equal(refreshExecutionPlan(armed, {
    accountRevision: 8,
    now: now + 2,
  }).status, 'EXPIRED')
  assert.equal(refreshExecutionPlan(armed, {
    accountRevision: 7,
    now: now + 31 * 60000,
  }).status, 'EXPIRED')
})

test('研究级或被阻断建议不能进入人工执行队列', () => {
  const plan = compileExecutionPlan({
    decisionPlan: decision({
      action: 'BUY',
      actionability: 'RESEARCH_ONLY',
    }),
    code: '600000',
    accountRevision: 1,
    now,
  })

  assert.equal(plan.canArm, false)
  assert.throws(
    () => transitionExecutionPlan(plan, 'ARM', { now: now + 1 }),
    /不可进入执行队列/,
  )
})

test('止损退出按向下触发而普通减仓按向上触发', () => {
  const exitDraft = compileExecutionPlan({
    decisionPlan: decision({
      action: 'EXIT',
      actionLabel: '清仓',
      prices: { reference: 9.5, stop: 9.5, target: 11 },
      quantity: { lots: 2 },
    }),
    code: '600000',
    accountRevision: 1,
    now,
  })
  const exitArmed = transitionExecutionPlan(
    exitDraft,
    'ARM',
    { now: now + 1 },
  )
  const reduceArmed = transitionExecutionPlan(
    compileExecutionPlan({
      decisionPlan: decision(),
      code: '600000',
      accountRevision: 1,
      now,
    }),
    'ARM',
    { now: now + 1 },
  )

  assert.equal(refreshExecutionPlan(exitArmed, {
    price: 9.4,
    now: now + 2,
  }).status, 'ALERTED')
  assert.equal(refreshExecutionPlan(reduceArmed, {
    price: 9.4,
    now: now + 2,
  }).status, 'ARMED')
})

test('跌破型减仓在现价高于触发线时不能误报已到价', () => {
  const draft = compileExecutionPlan({
    decisionPlan: decision({
      prices: { reference: 31.82, stop: 31.82, target: 36 },
      trigger: '触及31.82元且30至60分钟不能收回，卖出1手',
    }),
    code: '002436',
    name: '兴森科技',
    accountRevision: 1,
    now,
  })
  const armed = transitionExecutionPlan(
    draft,
    'ARM',
    { now: now + 1 },
  )

  assert.equal(draft.triggerDirection, 'LTE')
  assert.equal(refreshExecutionPlan(armed, {
    price: 33.24,
    now: now + 2,
  }).status, 'ARMED')
  assert.equal(refreshExecutionPlan(armed, {
    price: 31.82,
    now: now + 3,
  }).status, 'ALERTED')

  const legacyAlerted = {
    ...armed,
    status: 'ALERTED',
    triggerDirection: undefined,
    transitions: [
      ...armed.transitions,
      {
        from: 'ARMED',
        to: 'ALERTED',
        event: 'PRICE_TRIGGERED',
        at: now + 1,
      },
    ],
  }
  assert.equal(refreshExecutionPlan(legacyAlerted, {
    price: 33.24,
    now: now + 4,
  }).status, 'ARMED')

  assert.equal(refreshExecutionPlan(legacyAlerted, {
    price: null,
    now: now + 5,
  }).status, 'ALERTED')
})
