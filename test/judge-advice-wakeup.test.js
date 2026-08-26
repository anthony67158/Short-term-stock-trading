import test from 'node:test'
import assert from 'node:assert/strict'

import {
  __test as cronAlertTest,
  cloudAlertsForEvaluation,
  isCurrentAdvicePlan,
  queueAdviceReviewForPriceTrigger,
  queueAdviceReviewForVerdict,
} from '../api/cron_alert.js'
import { completeJob, enqueueJob, leaseJob } from '../api/_jobs.js'
import { projectAdviceAlerts } from '../shared/adviceAlerts.js'

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

test('观察价命中直接排队复核而不调用Judge确认交易', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    advice: {
      '600519': {
        mode: 'buy_advice',
        advice: {
          continuity: { planId: 'plan-watch', revision: 3 },
        },
      },
    },
  }
  const alert = {
    id: 'watch-review-1',
    code: '600519',
    name: '贵州茅台',
    reviewOnly: true,
    op: 'gte',
    value: 145.24,
    decisionPrice: 145.3,
    judgeContext: { planId: 'plan-watch', planRevision: 3 },
  }

  const result = queueAdviceReviewForPriceTrigger(
    data,
    alert,
    1000,
  )

  assert.equal(result.queued, true)
  assert.equal(result.created, true)
  assert.equal(data.reviewJobs['600519'].source, 'judge')
  assert.equal(data.reviewJobs['600519'].trigger.kind, 'price-review')
  assert.equal(data.reviewJobs['600519'].trigger.price, 145.3)
})

test('回踩与突破观察价都闭环触发提醒并排队自动复核', () => {
  const now = Date.parse('2026-08-27T02:00:00.000Z')
  const cases = [
    {
      key: 'watch_pullback',
      label: '回踩观察',
      price: 96,
      direction: 'LTE',
      quote: 95.9,
      op: 'lte',
      symbol: '≤',
    },
    {
      key: 'watch_breakout',
      label: '突破观察',
      price: 105,
      direction: 'GTE',
      quote: 105.1,
      op: 'gte',
      symbol: '≥',
    },
  ]

  for (const item of cases) {
    const advice = {
      action: '观望',
      continuity: { planId: `plan-${item.key}`, revision: 2 },
      priceContract: {
        schemaVersion: 'advice-price-contract.v1',
        currentPrice: 100,
        validationStatus: 'VERIFIED',
        levels: [{
          key: item.key,
          field: item.key === 'watch_pullback'
            ? 'pullbackWatchPrice'
            : 'breakoutWatchPrice',
          purpose: 'REVIEW_ONLY',
          label: item.label,
          price: item.price,
          direction: item.direction,
          status: 'PENDING',
          strict: true,
        }],
        allPricesStrict: true,
        issues: [],
        review: { operator: 'ANY', conditions: [], allMet: false },
      },
    }
    const data = {
      plan: [{ code: '600519', name: '贵州茅台' }],
      holding: [],
      alerts: [],
      settings: {},
      advice: {
        '600519': { mode: 'buy_advice', advice },
      },
    }

    projectAdviceAlerts(data, '600519', advice, {
      now,
      idFactory: () => `alert-${item.key}`,
      requirePriceContract: true,
    })

    const alert = data.alerts[0]
    assert.equal(alert.reviewOnly, true)
    assert.equal(alert.reviewKey, item.key)
    assert.equal(alert.op, item.op)
    assert.equal(
      cronAlertTest.reviewPriceTriggerOutcome(
        alert,
        { price: 100, tradeDate: '2026-08-27' },
        now,
      ),
      null,
    )

    const outcome = cronAlertTest.reviewPriceTriggerOutcome(
      alert,
      {
        price: item.quote,
        tradeDate: '2026-08-27',
      },
      now,
    )

    assert.ok(outcome)
    assert.equal(outcome.alert.phase, 'reviewing')
    assert.equal(outcome.alert.enabled, false)
    assert.equal(outcome.wakeup.kind, 'price-review')
    assert.match(outcome.notification.title, /观察条件已到/)
    assert.match(
      outcome.notification.body,
      new RegExp(`${item.label}${item.symbol}${item.price}`),
    )
    assert.match(outcome.notification.body, /正在自动复核/)

    const queued = queueAdviceReviewForPriceTrigger(
      data,
      outcome.alert,
      now,
    )
    assert.equal(queued.queued, true)
    assert.equal(queued.created, true)
    assert.equal(
      data.reviewJobs['600519'].trigger.kind,
      'price-review',
    )
  }
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
