import test from 'node:test'
import assert from 'node:assert/strict'

import {
  advisorAdmission,
  completeJob,
  enqueueJob,
  jobsToProgress,
  leaseJob,
  resourcePatchForJobProgress,
  reviewJobsOf,
  selectStartableJobs,
} from '../api/_jobs.js'
import {
  mergeAdviceRuntimeState,
  mergeAdviceRuntimeUpdate,
} from '../api/account.js'
import {
  reviewRoleCapacities,
  reviewResultStillCurrent,
} from '../api/cron_advice.js'

test('同一股票的主建议与复核使用独立任务槽位', () => {
  const data = {}
  const advisor = enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'ondemand',
    batchId: 'manual-1',
    batchRequest: true,
  }, 1000)
  leaseJob(data, '600000', 1100, 'advisor')

  const review = enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'judge',
    trigger: { at: 1200, planRevision: 2 },
    idempotencyKey: 'judge:a1:p1:2:invalid',
  }, 1200)

  assert.equal(advisor.created, true)
  assert.equal(review.created, true)
  assert.equal(data.jobs['600000'].status, 'running')
  assert.equal(data.jobs['600000'].pendingTrigger, undefined)
  assert.equal(data.reviewJobs['600000'].status, 'queued')
  assert.equal(data.reviewJobs['600000'].role, 'review')
})

test('旧版混合任务表会把自动复核迁移到review队列', () => {
  const data = {
    jobs: {
      '600000': {
        id: 'legacy-review',
        code: '600000',
        mode: 'hold_advice',
        source: 'auto',
        status: 'queued',
        at: 1000,
      },
      '000001': {
        id: 'legacy-advisor',
        code: '000001',
        mode: 'buy_advice',
        source: 'ondemand',
        status: 'queued',
        at: 1000,
      },
    },
  }

  const reviews = reviewJobsOf(data)

  assert.equal(data.jobs['600000'], undefined)
  assert.equal(reviews['600000'].role, 'review')
  assert.equal(data.jobs['000001'].role, 'advisor')
})

test('主批次进度不被后台复核重新拉回运行中', () => {
  const data = {
    activeAdviceBatchId: 'manual-1',
    advice: {
      '600000': {
        mode: 'buy_advice',
        at: 2000,
        advice: {
          action: '观望',
          title: '等待回踩确认',
          actionPlan: '回踩10元附近且量能企稳再评估',
          invalidation: '跌破9.8元后取消关注',
          quantNote: '量化中性',
          fundNote: '资金未形成共振',
        },
      },
    },
    jobs: {
      '600000': {
        id: 'advisor-1',
        code: '600000',
        name: '主建议股票',
        role: 'advisor',
        source: 'ondemand',
        batchId: 'manual-1',
        status: 'done',
        at: 1000,
        finishedAt: 2000,
        progressAt: 2000,
      },
    },
    reviewJobs: {
      '600000': {
        id: 'review-1',
        code: '600000',
        name: '复核股票',
        role: 'review',
        source: 'auto',
        batchId: '',
        status: 'running',
        at: 2100,
        progressAt: 2200,
        leaseUntil: 9000,
      },
    },
  }

  const progress = jobsToProgress(data, 2500, 2)

  assert.equal(progress.running, false)
  assert.equal(progress.total, 1)
  assert.deepEqual(progress.items.map((item) => item.code), ['600000'])
  assert.equal(progress.reviewRunning, true)
  assert.deepEqual(
    progress.reviews.map((item) => [item.code, item.status, item.role]),
    [['600000', 'running', 'review']],
  )
})

test('任务阶段确定当前占用的角色资源', () => {
  const advisor = { role: 'advisor' }
  const review = { role: 'review' }

  assert.deepEqual(
    resourcePatchForJobProgress(advisor, 'finalize'),
    { resourceRole: 'none', resourceUnits: 0 },
  )
  assert.deepEqual(
    resourcePatchForJobProgress(advisor, 'llm'),
    { resourceRole: 'advisor', resourceUnits: 1 },
  )
  assert.deepEqual(
    resourcePatchForJobProgress(review, 'llm'),
    { resourceRole: 'review', resourceUnits: 1 },
  )
})

test('advisor容量门控不受review任务占用影响', () => {
  const data = {}
  for (const [code, source] of [
    ['600000', 'ondemand'],
    ['000001', 'auto'],
  ]) {
    enqueueJob(data, {
      code,
      mode: 'hold_advice',
      source,
    }, 1000)
    leaseJob(
      data,
      code,
      1100,
      source === 'ondemand' ? 'advisor' : 'review',
    )
  }

  const available = advisorAdmission(data, ['600036'], 2, 1200)
  assert.equal(available.accepted, true)
  assert.equal(available.running, 1)

  enqueueJob(data, {
    code: '300750',
    mode: 'hold_advice',
    source: 'ondemand',
  }, 1300)
  leaseJob(data, '300750', 1400, 'advisor')

  const full = advisorAdmission(data, ['600036'], 2, 1500)
  assert.equal(full.accepted, false)
  assert.equal(full.running, 2)
  assert.deepEqual(
    full.busy.map((job) => job.code).sort(),
    ['300750', '600000'],
  )
})

test('四路复核为到价任务预留两路且普通定时复核最多占两路', () => {
  assert.deepEqual(reviewRoleCapacities(4), {
    review: 4,
    reviewBackground: 2,
  })
  assert.deepEqual(reviewRoleCapacities(2), {
    review: 2,
    reviewBackground: 1,
  })

  const data = {}
  for (let index = 0; index < 4; index++) {
    enqueueJob(data, {
      code: `60000${index}`,
      mode: 'hold_advice',
      source: 'auto',
    }, 1000 + index)
  }
  const backgroundOnly = selectStartableJobs(data, {
    advisor: 0,
    review: 4,
    reviewBackground: 2,
  }, new Set(), 2000)
  assert.equal(backgroundOnly.length, 2)
  assert.ok(backgroundOnly.every((job) => job.source === 'auto'))

  enqueueJob(data, {
    code: '300001',
    mode: 'buy_advice',
    source: 'judge',
    trigger: { kind: 'price-review' },
  }, 2000)
  enqueueJob(data, {
    code: '300002',
    mode: 'buy_advice',
    source: 'review',
    trigger: { kind: 'price-review' },
  }, 2001)
  const withUrgent = selectStartableJobs(data, {
    advisor: 0,
    review: 4,
    reviewBackground: 2,
  }, new Set(), 2100)

  assert.equal(withUrgent.length, 4)
  assert.deepEqual(
    withUrgent.slice(0, 2).map((job) => job.trigger?.kind),
    ['price-review', 'price-review'],
  )
  assert.equal(
    withUrgent.filter((job) => job.source === 'auto').length,
    2,
  )
})

test('复核完成只改变复核任务，不回退已完成的主建议', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'ondemand',
  }, 1000)
  leaseJob(data, '600000', 1100, 'advisor')
  completeJob(data, '600000', 1200, { role: 'advisor' })

  enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'judge',
    trigger: {
      kind: 'price-review',
      alertId: 'review-alert',
      at: 1300,
      planRevision: 2,
    },
  }, 1300)
  leaseJob(data, '600000', 1400, 'review')
  completeJob(data, '600000', 1500, { role: 'review' })

  assert.equal(data.jobs['600000'].status, 'done')
  assert.equal(data.jobs['600000'].finishedAt, 1200)
  assert.equal(data.reviewJobs['600000'].status, 'done')
  assert.equal(data.reviewJobs['600000'].finishedAt, 1500)
  const progress = jobsToProgress(data, 1600, 1)
  assert.equal(progress.reviews[0].triggerKind, 'price-review')
  assert.equal(progress.reviews[0].triggerAlertId, 'review-alert')
})

test('迟到的旧jobId不能结束同股新任务', () => {
  const data = {
    jobs: {
      '600000': {
        id: 'advisor-new',
        code: '600000',
        role: 'advisor',
        status: 'queued',
        at: 2000,
      },
    },
  }

  const completion = completeJob(data, '600000', 3000, {
    role: 'advisor',
    jobId: 'advisor-old',
  })

  assert.deepEqual(completion, {
    status: 'missing',
    publish: false,
    jobId: '',
  })
  assert.equal(data.jobs['600000'].status, 'queued')
})

test('OSS运行态按角色合并同股任务且互不覆盖', () => {
  const account = {
    updatedAt: 1000,
    data: {
      jobs: {
        '600000': {
          id: 'advisor-1',
          code: '600000',
          role: 'advisor',
          status: 'done',
          progressAt: 1000,
        },
      },
    },
  }

  mergeAdviceRuntimeState(account, {
    updatedAt: 1100,
    reviewJobs: {
      '600000': {
        id: 'review-1',
        code: '600000',
        role: 'review',
        status: 'running',
        progressAt: 1100,
      },
    },
  })
  mergeAdviceRuntimeUpdate(account, {
    schemaVersion: 'advice-runtime-update.v2',
    code: '600000',
    role: 'review',
    jobKey: 'review:600000',
    updatedAt: 1200,
    reviewJob: {
      id: 'review-1',
      code: '600000',
      role: 'review',
      status: 'done',
      progressAt: 1200,
    },
  })

  assert.equal(account.data.jobs['600000'].status, 'done')
  assert.equal(account.data.reviewJobs['600000'].status, 'done')
  assert.equal(
    account.data.runtimeAdviceAppliedAt['review:600000'],
    1200,
  )
})

test('运行态的旧进度不能复活同一任务的终态', () => {
  const account = {
    updatedAt: 200,
    data: {
      jobs: {
        '600000': {
          id: 'advisor-1',
          code: '600000',
          role: 'advisor',
          status: 'done',
          stage: 'done',
          progressAt: 200,
          finishedAt: 200,
        },
      },
    },
  }

  mergeAdviceRuntimeState(account, {
    updatedAt: 300,
    jobs: {
      '600000': {
        id: 'advisor-1',
        code: '600000',
        role: 'advisor',
        status: 'running',
        stage: 'llm',
        progressAt: 300,
      },
    },
  })

  assert.equal(account.data.jobs['600000'].status, 'done')
  assert.equal(account.data.jobs['600000'].stage, 'done')
})

test('复核结果只能覆盖它开始时所基于的建议版本', () => {
  const source = {
    sourceAdviceAt: 1000,
    sourcePlanId: 'plan-1',
  }

  assert.equal(reviewResultStillCurrent(source, {
    at: 1000,
    advice: { continuity: { planId: 'plan-1' } },
  }), true)
  assert.equal(reviewResultStillCurrent(source, {
    at: 2000,
    advice: { continuity: { planId: 'plan-2' } },
  }), false)
  assert.equal(reviewResultStillCurrent({
    sourceAdviceAt: 1000,
    sourcePlanId: '',
  }, {
    at: 1000,
    advice: { action: '持有' },
  }), true)
})
