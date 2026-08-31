import test from 'node:test'
import assert from 'node:assert/strict'

import {
  activatePriceReviewTrigger,
  __test as cronAlertTest,
  cloudAlertsForEvaluation,
  isCurrentAdvicePlan,
  queueAdviceReviewForPriceTrigger,
  queueAdviceReviewForVerdict,
} from '../api/cron_alert.js'
import { completeJob, enqueueJob, leaseJob } from '../api/_jobs.js'
import { projectAdviceAlerts } from '../shared/adviceAlerts.js'
import {
  TRIGGERED_REVIEW_OBSERVATION_MS,
} from '../shared/triggeredReviewDecision.js'

test('页面发现观察价已到时立即进入复核并排入紧急任务', () => {
  const now = Date.parse('2026-08-28T05:30:00.000Z')
  const data = {
    plan: [{ code: '000636', name: '风华高科' }],
    holding: [],
    closed: [],
    settings: {},
    advice: {
      '000636': {
        mode: 'buy_advice',
        advice: {
          continuity: {
            planId: 'plan-000636',
            revision: 3,
          },
        },
      },
    },
    alerts: [{
      id: 'review-000636',
      code: '000636',
      name: '风华高科',
      type: 'price',
      op: 'lte',
      value: 55.37,
      note: '回踩加仓复核',
      reviewOnly: true,
      enabled: true,
      phase: 'armed',
      judgeContext: {
        planId: 'plan-000636',
        planRevision: 3,
      },
    }],
  }

  const result = activatePriceReviewTrigger(data, {
    alertId: 'review-000636',
    code: '000636',
    quote: {
      code: '000636',
      price: 55.34,
      tradeDate: '2026-08-28',
      isLivePrice: true,
    },
  }, now)

  assert.equal(result.ok, true)
  assert.equal(result.queued, true)
  assert.equal(result.alert.phase, 'reviewing')
  assert.equal(result.alert.enabled, false)
  assert.equal(result.alert.triggeredAt, now)
  assert.equal(result.alert.decisionPrice, 55.34)
  assert.match(result.alert.triggeredMsg, /55\.34.*55\.37/)
  assert.equal(data.reviewJobs['000636'].source, 'judge')
  assert.equal(data.reviewJobs['000636'].trigger.kind, 'price-review')
  assert.equal(
    data.reviewJobs['000636'].trigger.monitoringUntilAt,
    now + TRIGGERED_REVIEW_OBSERVATION_MS,
  )
  assert.equal(data.reviewJobs['000636'].stage, 'monitoring')
  assert.match(data.reviewJobs['000636'].phase, /持续观察/)
})

test('页面即时复核拒绝未到价和非当日实时行情', () => {
  const now = Date.parse('2026-08-28T05:30:00.000Z')
  const buildData = () => ({
    plan: [{ code: '000636', name: '风华高科' }],
    holding: [],
    closed: [],
    settings: {},
    advice: {
      '000636': {
        mode: 'buy_advice',
        advice: {
          continuity: {
            planId: 'plan-000636',
            revision: 3,
          },
        },
      },
    },
    alerts: [{
      id: 'review-000636',
      code: '000636',
      name: '风华高科',
      type: 'price',
      op: 'lte',
      value: 55.37,
      reviewOnly: true,
      enabled: true,
      phase: 'armed',
      judgeContext: {
        planId: 'plan-000636',
        planRevision: 3,
      },
    }],
  })

  const notReached = buildData()
  assert.equal(activatePriceReviewTrigger(notReached, {
    alertId: 'review-000636',
    code: '000636',
    quote: {
      price: 55.38,
      tradeDate: '2026-08-28',
      isLivePrice: true,
    },
  }, now).reason, 'price-not-reached')
  assert.equal(notReached.alerts[0].phase, 'armed')
  assert.equal(notReached.reviewJobs, undefined)

  const stale = buildData()
  assert.equal(activatePriceReviewTrigger(stale, {
    alertId: 'review-000636',
    code: '000636',
    quote: {
      price: 55.34,
      tradeDate: '2026-08-27',
      isLivePrice: false,
    },
  }, now).reason, 'stale-quote')
  assert.equal(stale.alerts[0].phase, 'armed')
  assert.equal(stale.reviewJobs, undefined)
})

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
  assert.equal(data.reviewJobs['600519'].trigger.timeLimitMinutes, 2)
  assert.equal(
    data.reviewJobs['600519'].trigger.decisionDeadlineAt,
    121000,
  )
  assert.equal(data.reviewJobs['600519'].trigger.terminalRequired, true)
  assert.equal(data.reviewJobs['600519'].maxAttempts, 1)
})

test('持仓加仓复核价命中后明确评估加仓而不是普通买入', () => {
  const data = {
    holding: [{
      id: 'holding-1',
      code: '003036',
      name: '泰坦股份',
      qty: 1,
      buyAt: 100,
    }],
    closed: [],
    advice: {
      '003036': {
        mode: 'hold_advice',
        advice: {
          continuity: { planId: 'holding-plan', revision: 2 },
        },
      },
    },
  }
  const result = queueAdviceReviewForPriceTrigger(data, {
    id: 'holding-add-review',
    code: '003036',
    name: '泰坦股份',
    reviewOnly: true,
    reviewCategory: 'holding-add',
    reviewIntent: {
      mode: 'REASSESSMENT',
      plannedAction: 'WATCH',
      actionLabel: '重新评估加仓',
      directionApproved: false,
    },
    op: 'gte',
    value: 52.06,
    decisionPrice: 52.16,
    judgeContext: {
      planId: 'holding-plan',
      planRevision: 2,
    },
  }, 1000)

  assert.equal(result.queued, true)
  assert.equal(result.job.mode, 'hold_advice')
  assert.equal(result.job.trigger.reviewMode, 'REASSESSMENT')
  assert.equal(result.job.trigger.actionLabel, '重新评估加仓')
  assert.match(result.job.trigger.reason, /重新评估是否加仓/)
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
    assert.match(outcome.notification.body, /2分钟内给出明确结论/)

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

test('条件试仓与普通观望进入不同的到价复核意图', () => {
  const now = Date.parse('2026-08-27T02:00:00.000Z')
  const priceContract = {
    schemaVersion: 'advice-price-contract.v1',
    currentPrice: 100,
    validationStatus: 'VERIFIED',
    levels: [{
      key: 'watch_pullback',
      field: 'pullbackWatchPrice',
      purpose: 'REVIEW_ONLY',
      label: '回踩观察',
      price: 96,
      direction: 'LTE',
      status: 'PENDING',
      strict: true,
    }],
    allPricesStrict: true,
    issues: [],
    review: { operator: 'ANY', conditions: [], allMet: false },
  }
  const buildData = (advice) => ({
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [],
    settings: {},
    advice: {
      '600519': { mode: 'buy_advice', advice },
    },
  })
  const conditionalAdvice = {
    action: '观望',
    continuity: { planId: 'conditional-plan', revision: 2 },
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'WATCH',
      actionPolicy: {
        entryIntent: {
          state: 'CONDITIONAL_PROBE',
          action: 'PROBE',
          actionLabel: '条件试仓',
          reviewMode: 'ENTRY_CONFIRMATION',
          directionApproved: true,
          exactPriceRequired: false,
          maxPositionPct: 5,
          manualConfirmationOnly: true,
        },
      },
    },
    priceContract,
  }
  const watchAdvice = {
    action: '观望',
    continuity: { planId: 'watch-plan', revision: 1 },
    priceContract,
  }

  const conditionalData = buildData(conditionalAdvice)
  projectAdviceAlerts(conditionalData, '600519', conditionalAdvice, {
    now,
    idFactory: () => 'conditional-alert',
    requirePriceContract: true,
  })
  const conditionalAlert = {
    ...conditionalData.alerts[0],
    decisionPrice: 95.9,
  }
  const conditional = queueAdviceReviewForPriceTrigger(
    conditionalData,
    conditionalAlert,
    now,
  )

  assert.deepEqual(conditionalAlert.reviewIntent, {
    mode: 'ENTRY_CONFIRMATION',
    plannedAction: 'PROBE',
    actionLabel: '条件试仓',
    directionApproved: true,
    maxPositionPct: 5,
    manualConfirmationOnly: true,
  })
  assert.equal(
    conditional.job.trigger.reviewMode,
    'ENTRY_CONFIRMATION',
  )
  assert.equal(conditional.job.trigger.plannedAction, 'PROBE')
  assert.equal(conditional.job.trigger.maxPositionPct, 5)

  const watchData = buildData(watchAdvice)
  projectAdviceAlerts(watchData, '600519', watchAdvice, {
    now,
    idFactory: () => 'watch-alert',
    requirePriceContract: true,
  })
  const watchAlert = {
    ...watchData.alerts[0],
    decisionPrice: 95.9,
  }
  const watch = queueAdviceReviewForPriceTrigger(
    watchData,
    watchAlert,
    now,
  )

  assert.deepEqual(watchAlert.reviewIntent, {
    mode: 'REASSESSMENT',
    plannedAction: 'WATCH',
    actionLabel: '观望',
    directionApproved: false,
    maxPositionPct: null,
    manualConfirmationOnly: false,
  })
  assert.equal(watch.job.trigger.reviewMode, 'REASSESSMENT')
  assert.equal(watch.job.trigger.plannedAction, 'WATCH')
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
