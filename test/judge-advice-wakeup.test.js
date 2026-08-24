import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cloudAlertsForEvaluation,
  isCurrentAdvicePlan,
  queueAdviceReviewForVerdict,
} from '../api/cron_alert.js'
import { completeJob, enqueueJob, leaseJob } from '../api/_jobs.js'

test('Judge确认同一军师计划后只推进确定性执行状态不重复调用军师', () => {
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

  assert.equal(result.queued, false)
  assert.equal(result.reason, 'deterministic-event')
  assert.equal(result.eventDecision.runLlm, false)
  assert.equal(data.jobs, undefined)
  assert.equal(data.executionEventState.history.length, 1)
})

test('Judge判定计划失效时才排入一次军师复核', () => {
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
    id: 'alert-invalid',
    code: '600000',
    name: '浦发银行',
    actKind: 'reduce',
    judgeContext: { planId: 'plan-600000', planRevision: 2 },
  }
  const first = queueAdviceReviewForVerdict(
    data,
    alert,
    { decision: 'invalid', reason: '原计划已失效' },
    1000,
  )
  const replay = queueAdviceReviewForVerdict(
    data,
    alert,
    { decision: 'invalid', reason: '原计划已失效' },
    1001,
  )

  assert.equal(first.queued, true)
  assert.equal(first.created, true)
  assert.equal(replay.queued, false)
  assert.equal(replay.reason, 'duplicate-event')
  assert.equal(data.reviewJobs['600000'].source, 'judge')
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

test('单股关闭持续复核后云端不再评估军师派生预警但保留手工预警', () => {
  const active = cloudAlertsForEvaluation([
    { id: 'auto', code: '600000', candCode: '600000', enabled: true },
    { id: 'manual', code: '600000', type: 'pct', enabled: true },
  ], {
    'advReview.disabledCodes': ['600000'],
  })

  assert.deepEqual(active.map((alert) => alert.id), ['manual'])
})

test('军师生成期间到达的Judge事件进入独立复核队列', () => {
  const data = {
    holding: [{ id: 'h1', code: '600000', qty: 2 }],
    advice: {
      '600000': {
        mode: 'hold_advice',
        advice: { continuity: { planId: 'plan-1', revision: 1 } },
      },
    },
  }
  enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'ondemand',
  }, 1000)
  leaseJob(data, '600000', 1100)

  const review = queueAdviceReviewForVerdict(data, {
    id: 'during-run',
    code: '600000',
    judgeContext: { planId: 'plan-1', planRevision: 1 },
  }, {
    decision: 'invalid',
    reason: '原逻辑失效',
  }, 1200)
  completeJob(data, '600000', 1300, { role: 'advisor' })

  assert.equal(review.created, true)
  assert.equal(review.deferred, false)
  assert.equal(data.jobs['600000'].status, 'done')
  assert.equal(data.reviewJobs['600000'].status, 'queued')
  assert.equal(data.reviewJobs['600000'].source, 'judge')
  assert.equal(data.reviewJobs['600000'].trigger.decision, 'invalid')
  assert.equal(data.reviewJobs['600000'].at, 1200)
})

test('单股关闭持续复核后执行确认不再唤醒军师', () => {
  const data = {
    settings: { 'advReview.disabledCodes': ['600000'] },
    holding: [{ id: 'h1', code: '600000', qty: 2 }],
    advice: {
      '600000': {
        advice: { continuity: { planId: 'plan-1' } },
      },
    },
  }

  const result = queueAdviceReviewForVerdict(data, {
    id: 'a1',
    code: '600000',
    judgeContext: { planId: 'plan-1' },
  }, { decision: 'confirm' }, 1000)

  assert.deepEqual(result, { queued: false, reason: 'review-disabled' })
  assert.equal(data.jobs, undefined)
})
