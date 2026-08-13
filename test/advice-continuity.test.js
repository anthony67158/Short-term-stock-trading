import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAdviceCacheEntry,
  compactAdvicePlan,
  reconcileAdviceContinuity,
} from '../shared/adviceContinuity.js'
import { buildJudgeAdviceContext } from '../shared/judgeAdviceContext.js'

const previous = {
  at: 1000,
  advice: {
    action: '持有',
    title: '趋势未坏，继续持有',
    actionPlan: '守住9.80元继续持有',
    addPrice: 9.9,
    reducePrice: 10.8,
    stopPrice: 9.8,
    targetPrice: 10.8,
    invalidation: '收盘跌破9.80元',
    continuity: {
      planId: 'plan-600000',
      revision: 2,
      thesisVersion: 1,
    },
  },
}

test('没有客观失效证据时相反建议不能覆盖当前主计划', () => {
  const result = reconcileAdviceContinuity({
    code: '600000',
    previous,
    next: {
      action: '减仓',
      title: '短线转弱，建议减仓',
      actionPlan: '现价减仓1手',
      reducePrice: 10.1,
      stopPrice: 9.7,
      targetPrice: 10.3,
    },
    evidence: {
      currentPrice: 10.1,
      resonanceScore: 2,
      hasNegNews: false,
    },
    now: 2000,
  })

  assert.equal(result.advice.action, '持有')
  assert.equal(result.advice.continuity.changeType, 'blocked')
  assert.equal(result.advice.continuity.proposedAction, '减仓')
  assert.equal(result.advice.continuity.planId, 'plan-600000')
  assert.equal(result.advice.continuity.thesisVersion, 1)
})

test('触及上一版目标位后允许从持有切换为减仓', () => {
  const result = reconcileAdviceContinuity({
    code: '600000',
    previous,
    next: {
      action: '减仓',
      title: '目标位兑现',
      actionPlan: '10.82元附近减仓1手',
      reducePrice: 10.82,
      stopPrice: 10.2,
      targetPrice: 11,
    },
    evidence: { currentPrice: 10.82 },
    now: 2000,
  })

  assert.equal(result.advice.action, '减仓')
  assert.equal(result.advice.continuity.changeType, 'reverse')
  assert.equal(result.advice.continuity.thesisVersion, 2)
  assert.match(result.advice.continuity.changeReason, /目标/)
})

test('同方向刷新只调整价格带并延续同一主计划', () => {
  const result = reconcileAdviceContinuity({
    code: '600000',
    previous: {
      ...previous,
      advice: { ...previous.advice, action: '加仓' },
    },
    next: {
      action: '加仓',
      title: '回踩仍可加仓',
      actionPlan: '回踩10.05元企稳加仓1手',
      addPrice: 10.05,
      reducePrice: 10.9,
      stopPrice: 9.75,
      targetPrice: 10.9,
    },
    evidence: { currentPrice: 10.12 },
    now: 2000,
  })

  assert.equal(result.advice.action, '加仓')
  assert.equal(result.advice.continuity.changeType, 'adjust')
  assert.equal(result.advice.continuity.planId, 'plan-600000')
  assert.equal(result.advice.continuity.revision, 3)
  assert.ok(result.advice.continuity.zones.add.low < 10.05)
  assert.ok(result.advice.continuity.zones.add.high > 10.05)
})

test('Judge上下文携带主计划版本和动态价格带', () => {
  const advice = reconcileAdviceContinuity({
    code: '600000',
    previous,
    next: {
      action: '持有',
      addPrice: 9.95,
      reducePrice: 10.85,
      stopPrice: 9.8,
      targetPrice: 10.85,
    },
    evidence: { currentPrice: 10.2 },
    now: 2000,
  }).advice
  const context = buildJudgeAdviceContext(advice)

  assert.equal(context.planId, 'plan-600000')
  assert.equal(context.planRevision, 3)
  assert.equal(context.thesisVersion, 1)
  assert.ok(context.addZone.low < context.addZone.high)
  assert.ok(context.reduceZone.low < context.reduceZone.high)
})

test('上一版主计划只提取连续决策需要的白名单字段', () => {
  const compact = compactAdvicePlan({
    ...previous,
    news: [{ title: '不应传入' }],
    advice: {
      ...previous.advice,
      reasoning: '很长的内部推理',
    },
  })

  assert.equal(compact.action, '持有')
  assert.equal(compact.planId, 'plan-600000')
  assert.equal(compact.reasoning, undefined)
  assert.equal(compact.news, undefined)
})

test('每次刷新保留精简的计划修订历史而不是只剩最后一版', () => {
  const entry = buildAdviceCacheEntry(previous, {
    advice: {
      action: '持有',
      continuity: {
        planId: 'plan-600000',
        revision: 3,
        thesisVersion: 1,
      },
    },
  }, 2000)

  assert.equal(entry.at, 2000)
  assert.equal(entry.trail.length, 1)
  assert.equal(entry.trail[0].action, '持有')
  assert.equal(entry.trail[0].revision, 2)
  assert.equal(entry.trail[0].reasoning, undefined)
})

test('自动定时复核锁定核心动作和价位，避免同方向建议频繁漂移', () => {
  const result = reconcileAdviceContinuity({
    code: '600000',
    previous,
    next: {
      action: '持有',
      title: '短线震荡持有',
      actionPlan: '回踩10.18元企稳后继续持有',
      opQty: '持有2手',
      addPrice: 10.18,
      reducePrice: 10.86,
      stopPrice: 9.72,
      reason: '盘口轻微变化',
    },
    stabilityMode: 'scheduled',
    now: 2000,
  })

  assert.equal(result.advice.action, previous.advice.action)
  assert.equal(result.advice.actionPlan, previous.advice.actionPlan)
  assert.equal(result.advice.addPrice, previous.advice.addPrice)
  assert.equal(result.advice.reducePrice, previous.advice.reducePrice)
  assert.equal(result.advice.stopPrice, previous.advice.stopPrice)
  assert.equal(result.advice.continuity.changeType, 'maintain')
  assert.match(result.advice.continuity.changeReason, /自动复核未发现执行事件/)
})
