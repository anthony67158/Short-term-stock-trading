import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cloudAlertsForEvaluation,
  isCurrentAdvicePlan,
  queueAdviceReviewForVerdict,
} from '../api/cron_alert.js'
import { completeJob, leaseJob } from '../api/_jobs.js'

test('Judge确认同一军师计划后立即排入事件复核', () => {
  const data = {
    holding: [{ id: 'h1', code: '600000', qty: 2 }],
    advice: {
      '600000': {
        mode: 'hold_advice',
        advice: {
          continuity: { planId: 'plan-600000', revision: 2 },
        },
      },
    },
  }
  const alert = {
    id: 'alert-1',
    code: '600000',
    name: '浦发银行',
    actKind: 'reduce',
    judgeContext: { planId: 'plan-600000', planRevision: 2 },
  }

  const result = queueAdviceReviewForVerdict(data, alert, {
    decision: 'confirm',
    confidence: 88,
    reason: '放量冲高回落',
    side: 'sell',
  }, 1000)

  assert.equal(result.queued, true)
  assert.equal(data.jobs['600000'].source, 'judge')
  assert.equal(data.jobs['600000'].mode, 'hold_advice')
  assert.deepEqual(data.jobs['600000'].trigger, {
    kind: 'judge',
    decision: 'confirm',
    alertId: 'alert-1',
    planId: 'plan-600000',
    planRevision: 2,
    side: 'sell',
    confidence: 88,
    reason: '放量冲高回落',
    price: null,
    at: 1000,
  })
})

test('旧计划的Judge结果不得唤醒或改写当前军师建议', () => {
  const data = {
    plan: [{ code: '600000', name: '浦发银行' }],
    advice: {
      '600000': {
        mode: 'buy_advice',
        advice: {
          continuity: { planId: 'new-plan', revision: 3 },
        },
      },
    },
  }

  const result = queueAdviceReviewForVerdict(data, {
    id: 'stale-alert',
    code: '600000',
    judgeContext: { planId: 'old-plan', planRevision: 1 },
  }, {
    decision: 'confirm',
  }, 2000)

  assert.deepEqual(result, { queued: false, reason: 'stale-plan' })
  assert.equal(data.jobs, undefined)
})

test('Judge执行前拒绝与当前军师planId不一致的旧预警', () => {
  assert.equal(isCurrentAdvicePlan({
    judgeContext: { planId: 'old-plan' },
  }, {
    advice: { continuity: { planId: 'new-plan' } },
  }), false)
  assert.equal(isCurrentAdvicePlan({
    judgeContext: { planId: 'same-plan' },
  }, {
    advice: { continuity: { planId: 'same-plan' } },
  }), true)
  assert.equal(isCurrentAdvicePlan({}, {}), true)
})

test('云端闭环不依赖WebPush订阅，始终评估启用中的预警', () => {
  const active = cloudAlertsForEvaluation([
    { id: 'armed', enabled: true, triggeredAt: null },
    { id: 'done', enabled: false, triggeredAt: 100 },
  ])

  assert.deepEqual(active.map((alert) => alert.id), ['armed'])
})

test('军师生成期间到达的Judge事件在当前任务完成后自动续跑', () => {
  const data = {
    holding: [{ id: 'h1', code: '600000', qty: 2 }],
    advice: {
      '600000': {
        mode: 'hold_advice',
        advice: { continuity: { planId: 'plan-1', revision: 1 } },
      },
    },
  }
  queueAdviceReviewForVerdict(data, {
    id: 'initial',
    code: '600000',
    judgeContext: { planId: 'plan-1', planRevision: 1 },
  }, { decision: 'confirm' }, 1000)
  leaseJob(data, '600000', 1100)

  const deferred = queueAdviceReviewForVerdict(data, {
    id: 'during-run',
    code: '600000',
    judgeContext: { planId: 'plan-1', planRevision: 1 },
  }, {
    decision: 'invalid',
    reason: '原逻辑失效',
  }, 1200)
  completeJob(data, '600000', 1300)

  assert.equal(deferred.deferred, true)
  assert.equal(data.jobs['600000'].status, 'queued')
  assert.equal(data.jobs['600000'].source, 'judge')
  assert.equal(data.jobs['600000'].trigger.decision, 'invalid')
  assert.equal(data.jobs['600000'].at, 1200)
})
