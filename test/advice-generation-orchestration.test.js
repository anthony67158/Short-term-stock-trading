import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  completeJob,
  enqueueJob,
  leaseJob,
} from '../api/_jobs.js'
import {
  shouldRunAdvisorCouncil,
  shouldGenerateAdviceDailyReport,
} from '../shared/adviceGenerationPolicy.js'
import {
  generationOptions,
} from '../shared/adviceBatchPolicy.js'
import {
  llmRoleForAdviceMode,
  maxTokensForMode,
} from '../api/_ai_prompts.js'

const stockDetailSource = readFileSync(
  new URL('../src/components/StockDetail.jsx', import.meta.url),
  'utf8',
)
const cronAdviceSource = readFileSync(
  new URL('../api/cron_advice.js', import.meta.url),
  'utf8',
)
const aiSource = readFileSync(
  new URL('../api/ai.js', import.meta.url),
  'utf8',
)
const adviceRunnerSource = readFileSync(
  new URL('../src/adviceRunner.js', import.meta.url),
  'utf8',
)

test('同一用户请求在任务完成后重放也不能再次创建生成任务', () => {
  const data = {}
  const first = enqueueJob(data, {
    code: '600000',
    mode: 'buy_advice',
    source: 'ondemand',
    idempotencyKey: 'user-request:req-1:600000',
  }, 1000)
  leaseJob(data, '600000', 1100)
  completeJob(data, '600000', 2000, {
    evidenceAsOf: 1500,
    planRevision: 1,
  })

  const replay = enqueueJob(data, {
    code: '600000',
    mode: 'buy_advice',
    source: 'ondemand',
    idempotencyKey: 'user-request:req-1:600000',
  }, 2100)

  assert.equal(first.created, true)
  assert.equal(replay.created, false)
  assert.equal(replay.replayed, true)
  assert.equal(data.jobs['600000'].status, 'done')
  assert.equal(data.jobs['600000'].id, first.job.id)
})

test('生成期间到达的Judge事件不改变主建议任务终态', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'ondemand',
    idempotencyKey: 'user-request:req-2:600000',
  }, 1000)
  leaseJob(data, '600000', 1050)
  const review = enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'judge',
    trigger: {
      kind: 'judge',
      decision: 'confirm',
      planId: 'plan-1',
      planRevision: 1,
      at: 1200,
    },
    idempotencyKey: 'judge:alert-1:plan-1:1:confirm',
  }, 1200)

  completeJob(data, '600000', 1300, {
    evidenceAsOf: 1250,
    planRevision: 2,
  })

  assert.equal(review.created, true)
  assert.equal(review.deferred, undefined)
  assert.equal(data.jobs['600000'].status, 'done')
  assert.equal(data.jobs['600000'].pendingTrigger, undefined)
  assert.equal(data.reviewJobs['600000'].status, 'queued')
})

test('复核运行期间的新事件只续跑复核任务一次', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'judge',
    trigger: {
      kind: 'judge',
      decision: 'invalid',
      planId: 'plan-1',
      planRevision: 1,
      at: 1000,
    },
    idempotencyKey: 'judge:alert-1:plan-1:1:invalid',
  }, 1000)
  leaseJob(data, '600000', 1050, 'review')
  enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'judge',
    trigger: {
      kind: 'judge',
      decision: 'invalid',
      planId: 'plan-1',
      planRevision: 1,
      at: 1400,
    },
    idempotencyKey: 'judge:alert-2:plan-1:1:invalid',
  }, 1400)

  const completion = completeJob(data, '600000', 1500, {
    evidenceAsOf: 1300,
    planRevision: 2,
    role: 'review',
  })
  const continuedId = data.reviewJobs['600000'].id
  const duplicate = enqueueJob(data, {
    code: '600000',
    mode: 'hold_advice',
    source: 'judge',
    trigger: {
      kind: 'judge',
      decision: 'invalid',
      planId: 'plan-1',
      planRevision: 1,
      at: 1600,
    },
    idempotencyKey: 'judge:alert-2:plan-1:1:invalid',
  }, 1600)

  assert.equal(data.reviewJobs['600000'].status, 'queued')
  assert.equal(data.reviewJobs['600000'].id, continuedId)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.replayed, true)
  assert.deepEqual(completion, {
    status: 'requeued',
    publish: false,
    jobId: continuedId,
  })
})

test('委员会只在显式深度生成时同步执行', () => {
  assert.equal(shouldRunAdvisorCouncil({
    enabled: true,
    deepMode: false,
    source: 'ondemand',
  }), false)
  assert.equal(shouldRunAdvisorCouncil({
    enabled: true,
    deepMode: true,
    source: 'ondemand',
  }), true)
  assert.equal(shouldRunAdvisorCouncil({
    enabled: true,
    deepMode: true,
    source: 'auto',
  }), false)
})

test('复核请求使用独立review角色且首次建议仍使用advisor', () => {
  assert.equal(llmRoleForAdviceMode('review'), 'review')
  assert.equal(llmRoleForAdviceMode('hold_advice', 'auto'), 'review')
  assert.equal(llmRoleForAdviceMode('buy_advice', 'judge'), 'review')
  assert.equal(llmRoleForAdviceMode('hold_advice', 'cron'), 'review')
  assert.equal(llmRoleForAdviceMode('hold_advice', 'ondemand'), 'advisor')
  assert.equal(llmRoleForAdviceMode('buy_advice', ''), 'advisor')
  assert.equal(llmRoleForAdviceMode('market'), 'agent')
})

test('快速军师不等待策略日报而深度研判仍尝试补齐', () => {
  assert.equal(shouldGenerateAdviceDailyReport({
    deepMode: false,
  }), false)
  assert.equal(shouldGenerateAdviceDailyReport({
    deepMode: true,
  }), true)
  assert.match(
    cronAdviceSource,
    /const generateDailyReport = shouldGenerateAdviceDailyReport/,
  )
  assert.match(
    cronAdviceSource,
    /if \(generateDailyReport\) \{/,
  )
  assert.doesNotMatch(
    cronAdviceSource,
    /failAdviceJobsForDailyReport/,
  )
  assert.match(
    adviceRunnerSource,
    /if \(shouldGenerateAdviceDailyReport\(/,
  )
  assert.doesNotMatch(
    adviceRunnerSource,
    /策略日报生成失败，未启动军师分析/,
  )
})

test('个股页默认快速生成且普通路径不再无条件同步委员会', () => {
  assert.match(
    stockDetailSource,
    /const loadQuant = async \(deepMode = false\)/,
  )
  assert.doesNotMatch(stockDetailSource, /deepMode:\s*true/)
  assert.doesNotMatch(
    cronAdviceSource,
    /if \(advice && councilEnabled\) \{[\s\S]*?await runAdvisorCouncilShadow/,
  )
  assert.match(
    cronAdviceSource,
    /onProgress\(\{\s*stage:\s*'council',\s*phase:\s*'委员会正在复核候选方案，尚未发布最终结论'/,
  )
  assert.match(
    cronAdviceSource,
    /onProgress\(\{\s*stage:\s*'finalize',\s*phase:\s*'复核完成，正在发布最终结论'/,
  )
  assert.match(
    cronAdviceSource,
    /const completion = completeJob\([\s\S]*?if \(!completion\?\.publish\) \{[\s\S]*?await saveWorking\(\)[\s\S]*?continue/,
  )
  assert.match(
    cronAdviceSource,
    /done\.role === 'review'[\s\S]*?!reviewResultStillCurrent\([\s\S]*?completion\.status = 'stale'/,
  )
  assert.match(
    cronAdviceSource,
    /selectStartableJobs\([\s\S]*?roleCapacities/,
  )
  assert.match(
    cronAdviceSource,
    /resourcePatchForJobProgress\([\s\S]*?REVIEW_CONC/,
  )
  assert.match(
    aiSource,
    /forceReasoning\s*\?\s*'数据齐全，正在形成候选方案…'\s*:\s*'数据齐全，正在生成操作建议…'/,
  )
})

test('普通军师生成有明确的低延迟预算且保留深度模式', () => {
  const quick = generationOptions(false)
  const deep = generationOptions(true)

  assert.equal(quick.fastMode, true)
  assert.equal(quick.runtimeBudgetMs, 75000)
  assert.equal(quick.maxAttempts, 2)
  assert.equal(deep.forceReasoning, true)
  assert.ok(deep.runtimeBudgetMs > quick.runtimeBudgetMs)
  assert.equal(maxTokensForMode('hold_advice', false), 3200)
  assert.ok(maxTokensForMode('hold_advice', true) >= 32000)
})
