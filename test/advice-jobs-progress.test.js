import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cancelJob,
  completeJob,
  enqueueJob,
  failJob,
  jobsToProgress,
  compareAdviceJobs,
  leaseJob,
  needsWorkerDispatch,
  reapOrphans,
  requeueAdvicePreparationFailure,
  updateJobProgress,
} from '../api/_jobs.js'

test('达到最大尝试次数的中断任务会终止，避免无限从头重跑', () => {
  const data = {}
  enqueueJob(data, { code: '600000', name: '浦发银行', mode: 'buy_advice' }, 1000)
  leaseJob(data, '600000', 1000)
  data.jobs['600000'].attempts = data.jobs['600000'].maxAttempts

  const reaped = reapOrphans(data, 1000 + 500 * 1000)
  const job = data.jobs['600000']

  assert.equal(reaped, 1)
  assert.equal(job.status, 'failed')
  assert.equal(job.phase, '生成中断次数过多')
  assert.equal(job.finishedAt, 1000 + 500 * 1000)
})

test('运行中任务取消后立即终止且不会被孤儿回收重新排队', () => {
  const data = {}
  enqueueJob(data, { code: '600000', name: '浦发银行', mode: 'buy_advice' }, 1000)
  leaseJob(data, '600000', 1000)

  assert.equal(cancelJob(data, '600000', 2000), true)
  assert.equal(data.jobs['600000'].status, 'canceled')
  assert.equal(data.jobs['600000'].phase, '已取消生成')
  assert.equal(reapOrphans(data, 1000 + 500 * 1000), 0)
  updateJobProgress(data, '600000', { phase: '迟到的模型事件' }, 3000)
  assert.equal(data.jobs['600000'].phase, '已取消生成')
})

test('最终结论发布后迟到的进度不能把任务改回处理中', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
    deepMode: true,
  }, 1000)
  leaseJob(data, '600000', 1000)
  completeJob(data, '600000', 2000)

  updateJobProgress(data, '600000', {
    stage: 'llm',
    phase: '迟到的模型事件',
  }, 3000)

  assert.equal(data.jobs['600000'].status, 'done')
  assert.equal(data.jobs['600000'].stage, 'done')
  assert.equal(data.jobs['600000'].phase, '生成完成')
  assert.equal(data.jobs['600000'].progressAt, 2000)
})

test('新批次进度只包含本批任务，不混入最近取消的旧任务', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000', name: '旧任务', mode: 'buy_advice', batchId: 'old',
  }, 1000)
  cancelJob(data, '600000', 1100)
  enqueueJob(data, {
    code: '600001', name: '新任务', mode: 'buy_advice', batchId: 'new',
  }, 2000)
  data.activeAdviceBatchId = 'new'

  const progress = jobsToProgress(data, 2500, 2)

  assert.equal(progress.total, 1)
  assert.equal(progress.skipped, 0)
  assert.deepEqual(progress.items.map((item) => item.code), ['600001'])
})

test('连续点击不同个股时进度必须保留所有跨批次活跃任务', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000', name: '第一只', mode: 'buy_advice', batchId: 'single-a',
  }, 1000)
  leaseJob(data, '600000', 1100)
  enqueueJob(data, {
    code: '000001', name: '第二只', mode: 'buy_advice', batchId: 'single-b',
  }, 2000)
  data.activeAdviceBatchId = 'single-b'

  const progress = jobsToProgress(data, 2100, 3)

  assert.deepEqual(
    progress.items.map((item) => [item.code, item.status]),
    [
      ['600000', 'running'],
      ['000001', 'queued'],
    ],
  )
  assert.deepEqual(progress.current, ['600000'])
  assert.equal(progress.total, 2)
})

test('深度任务模式会持久化到任务和批次进度', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
    batchId: 'deep-batch',
    deepMode: true,
  }, 1000)
  data.activeAdviceBatchId = 'deep-batch'

  const job = data.jobs['600000']
  const progress = jobsToProgress(data, 1500, 2)

  assert.equal(job.deepMode, true)
  assert.equal(job.maxAttempts, 1)
  assert.equal(progress.deepMode, true)
  assert.equal(progress.items[0].deepMode, true)
})

test('旧深度任务的三次重试配置会在领取时收紧且失败不再整轮重跑', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
    deepMode: true,
  }, 1000)
  data.jobs['600000'].maxAttempts = 3

  leaseJob(data, '600000', 1100)
  failJob(data, '600000', '模型输出不完整', 1200)

  assert.equal(data.jobs['600000'].maxAttempts, 1)
  assert.equal(data.jobs['600000'].attempts, 1)
  assert.equal(data.jobs['600000'].status, 'failed')
})

test('价格触发复核只允许一次任务尝试，失败不得循环重跑', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
    source: 'judge',
    trigger: {
      kind: 'price-review',
      at: 1000,
      decisionDeadlineAt: 121000,
      terminalRequired: true,
    },
  }, 1000)

  const job = data.reviewJobs['600000']
  assert.equal(job.maxAttempts, 1)
  leaseJob(data, '600000', 1100, 'review', job.id)
  failJob(data, '600000', '限时复核失败', 1200, 'review', job.id)
  assert.equal(job.status, 'failed')
  assert.equal(job.maxAttempts, 1)
})

test('重复点击不能用新排队任务覆盖正在生成的同一股票', () => {
  const data = {}
  const first = enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
    batchId: 'first-batch',
    deepMode: true,
    force: true,
  }, 1000)
  leaseJob(data, '600000', 1100)

  const duplicate = enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
    batchId: 'second-batch',
    deepMode: true,
    force: true,
  }, 2000)

  assert.equal(duplicate.created, false)
  assert.equal(duplicate.job.id, first.job.id)
  assert.equal(data.jobs['600000'].status, 'running')
  assert.equal(data.jobs['600000'].batchId, 'first-batch')
})

test('待办且没有有效Worker锁时必须补发异步Worker', () => {
  const data = {}
  enqueueJob(data, { code: '600000', mode: 'buy_advice' }, 1000)

  assert.equal(needsWorkerDispatch(data, 1100), true)

  data.jobWorker = { id: 'worker-1', lockUntil: 5000 }
  assert.equal(needsWorkerDispatch(data, 1100), false)
  assert.equal(needsWorkerDispatch(data, 6000), true)
})

test('Worker锁已过期时立即回收失联任务而不是继续等待任务长租约', () => {
  const beforeModel = {}
  enqueueJob(beforeModel, {
    code: '600000',
    mode: 'buy_advice',
    deepMode: true,
  }, 1000)
  beforeModel.jobWorker = { id: 'dead-worker', lockUntil: 61000 }
  leaseJob(beforeModel, '600000', 1100)

  assert.equal(beforeModel.jobs['600000'].leaseUntil > 62000, true)
  assert.equal(reapOrphans(beforeModel, 62000), 1)
  assert.equal(beforeModel.jobs['600000'].status, 'queued')
  assert.equal(beforeModel.jobs['600000'].attempts, 0)
  assert.equal(beforeModel.jobs['600000'].preparationRetries, 1)
  assert.equal(needsWorkerDispatch(beforeModel, 62000), true)

  beforeModel.jobWorker = { id: 'dead-worker-2', lockUntil: 123000 }
  leaseJob(beforeModel, '600000', 63000)
  assert.equal(reapOrphans(beforeModel, 124000), 1)
  assert.equal(beforeModel.jobs['600000'].status, 'failed')
  assert.match(beforeModel.jobs['600000'].error, /云端Worker已中断/)

  const afterModel = {}
  enqueueJob(afterModel, {
    code: '600001',
    mode: 'buy_advice',
    deepMode: true,
  }, 1000)
  afterModel.jobWorker = { id: 'dead-worker', lockUntil: 61000 }
  leaseJob(afterModel, '600001', 1100)
  updateJobProgress(afterModel, '600001', {
    stage: 'llm',
    endpoint: 'advisor-1',
  }, 2000)

  assert.equal(afterModel.jobs['600001'].leaseUntil > 62000, true)
  assert.equal(reapOrphans(afterModel, 62000), 1)
  assert.equal(afterModel.jobs['600001'].status, 'failed')
  assert.equal(afterModel.jobs['600001'].phase, '云端生成中断，请重新生成')
  assert.match(afterModel.jobs['600001'].error, /避免重复调用模型/)
})

test('Worker锁仍有效时不得提前回收运行任务', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    mode: 'buy_advice',
    deepMode: true,
  }, 1000)
  data.jobWorker = { id: 'live-worker', lockUntil: 90000 }
  leaseJob(data, '600000', 1100)

  assert.equal(reapOrphans(data, 62000), 0)
  assert.equal(data.jobs['600000'].status, 'running')
  assert.equal(data.jobs['600000'].attempts, 1)
})

test('模型调用前的准备故障只自动恢复一次且不消耗生成次数', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    mode: 'buy_advice',
    deepMode: true,
  }, 1000)
  const job = leaseJob(data, '600000', 1100)
  updateJobProgress(data, '600000', {
    stage: 'collect',
    phase: '正在读取账户与实时行情',
  }, 1200)

  const recovered = requeueAdvicePreparationFailure(
    data,
    '600000',
    1300,
    'advisor',
    job.id,
  )

  assert.equal(recovered.status, 'queued')
  assert.equal(recovered.attempts, 0)
  assert.equal(recovered.preparationRetries, 1)
  assert.equal(recovered.phase, '准备阶段中断，正在自动重试')

  leaseJob(data, '600000', 1400, 'advisor', job.id)
  const second = requeueAdvicePreparationFailure(
    data,
    '600000',
    1500,
    'advisor',
    job.id,
  )
  assert.equal(second, null)
  assert.equal(data.jobs['600000'].status, 'running')
})

test('模型已开始后不得自动重跑整题', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    mode: 'buy_advice',
    deepMode: true,
  }, 1000)
  const job = leaseJob(data, '600000', 1100)
  updateJobProgress(data, '600000', {
    stage: 'llm',
    endpoint: 'advisor-1',
    model: 'deep-model',
  }, 1200)

  assert.equal(
    requeueAdvicePreparationFailure(
      data,
      '600000',
      1300,
      'advisor',
      job.id,
    ),
    null,
  )
  assert.equal(data.jobs['600000'].status, 'running')
})

test('上一批延迟到达的取消请求不能取消新批次任务', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000', name: '新任务', mode: 'buy_advice', batchId: 'new-batch',
  }, 2000)

  assert.equal(cancelJob(data, '600000', 2500, 'old-batch'), false)
  assert.equal(data.jobs['600000'].status, 'queued')
  assert.equal(cancelJob(data, '600000', 2600, 'new-batch'), true)
  assert.equal(data.jobs['600000'].status, 'canceled')
})

test('进度快照携带单股阶段、数据源、模型端点和研判摘要', () => {
  const data = {}
  enqueueJob(data, { code: '600000', name: '浦发银行', mode: 'buy_advice' }, 1000)
  leaseJob(data, '600000', 1000)
  updateJobProgress(data, '600000', {
    stage: 'llm',
    phase: '正在分析量价与资金共振',
    sources: [{ label: '实时行情', ok: true }],
    reasoning: '正在判断支撑位是否有效，并计算盈亏比。',
    quant: { summary: '上涨概率48%，等待回踩。' },
    model: 'DeepSeek-V4-Pro',
    endpoint: '主端点',
  }, 2000)

  const item = jobsToProgress(data, 2500, 2).items[0]
  assert.equal(item.phase, '正在分析量价与资金共振')
  assert.equal(item.stage, 'llm')
  assert.equal(item.reasoning, '正在判断支撑位是否有效，并计算盈亏比。')
  assert.equal(item.quant.summary, '上涨概率48%，等待回踩。')
  assert.deepEqual(item.sources, [{ label: '实时行情', ok: true }])
  assert.equal(item.model, 'DeepSeek-V4-Pro')
  assert.equal(item.endpoint, '主端点')
  assert.equal(item.progressAt, 2000)
})

test('准备阶段长时间无进展时明确提示将自动跳过慢源', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
    deepMode: true,
  }, 1000)
  leaseJob(data, '600000', 1100)
  updateJobProgress(data, '600000', {
    stage: 'collect',
    phase: '正在读取账户与实时行情',
  }, 1200)

  const item = jobsToProgress(data, 22000, 2).items[0]

  assert.match(item.warning, /自动跳过并继续/)
})

test('持久任务研判摘要保留原文并去重过滤JSON草稿', () => {
  const data = {}
  enqueueJob(data, { code: '600000', name: '浦发银行', mode: 'buy_advice' }, 1000)
  updateJobProgress(data, '600000', {
    reasoning: [
      'Analyzing momentum...',
      'Analyzing momentum...',
      '正在分析走势。',
      '{"action":"hold"}',
      '中文推理'.repeat(3000),
    ].join('\n'),
  }, 2000)

  const reasoning = data.jobs['600000'].reasoning
  assert.equal(
    reasoning.match(/Analyzing momentum/g)?.length,
    1,
  )
  assert.equal(reasoning.includes('{"action"'), false)
  assert.equal(reasoning.length <= 6000, true)
  assert.equal(reasoning.includes('正在分析走势'), true)
})

test('状态查询不伪造新进度时间且完成时间保持稳定', () => {
  const data = {}
  enqueueJob(data, { code: '600000', name: '浦发银行', mode: 'buy_advice' }, 1000)
  leaseJob(data, '600000', 1100)
  completeJob(data, '600000', 2000)

  const first = jobsToProgress(data, 3000, 2)
  const later = jobsToProgress(data, 9000, 2)

  assert.equal(first.at, 2000)
  assert.equal(later.at, 2000)
  assert.equal(first.finishedAt, 2000)
  assert.equal(later.finishedAt, 2000)
})

test('没有完整正文的终态任务仍显示为发布中而不是生成完成', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
  }, 1000)
  leaseJob(data, '600000', 1100)
  completeJob(data, '600000', 2000)

  const progress = jobsToProgress(data, 2100, 2)

  assert.equal(progress.running, true)
  assert.equal(progress.done, 0)
  assert.equal(progress.items[0].status, 'publishing')
  assert.equal(progress.items[0].stage, 'finalize')
})

test('终态任务超过发布宽限期后转为失败而不是永久卡在发布中', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
  }, 1000)
  leaseJob(data, '600000', 1100)
  completeJob(data, '600000', 2000)

  const progress = jobsToProgress(data, 2000 + 3 * 60 * 1000, 2)

  assert.equal(progress.running, false)
  assert.equal(progress.done, 1)
  assert.equal(progress.fail, 1)
  assert.equal(progress.items[0].status, 'fail')
  assert.equal(progress.items[0].stage, 'failed')
  assert.match(progress.items[0].error, /发布失败/)
})

test('完整建议已落盘后终态任务才对外显示完成', () => {
  const data = {
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
  }
  enqueueJob(data, {
    code: '600000',
    name: '浦发银行',
    mode: 'buy_advice',
  }, 1000)
  leaseJob(data, '600000', 1100)
  completeJob(data, '600000', 2000)

  const progress = jobsToProgress(data, 2100, 2)

  assert.equal(progress.running, false)
  assert.equal(progress.done, 1)
  assert.equal(progress.items[0].status, 'ok')
})

test('没有任务时不生成虚假的空批次完成时间', () => {
  const progress = jobsToProgress({}, 5000, 2)

  assert.equal(progress.total, 0)
  assert.equal(progress.done, 0)
  assert.equal(progress.running, false)
  assert.equal(progress.at, 0)
  assert.equal(progress.finishedAt, 0)
})

test('任务调度优先级为Judge、一次性生成、单股手动、自动复核', () => {
  const jobs = [
    { source: 'auto', at: 1000 },
    { source: 'ondemand', batchRequest: false, at: 1000 },
    { source: 'ondemand', batchRequest: true, at: 1000 },
    { source: 'judge', at: 1000 },
  ]

  jobs.sort(compareAdviceJobs)

  assert.deepEqual(
    jobs.map((job) => [job.source, !!job.batchRequest]),
    [
      ['judge', false],
      ['ondemand', true],
      ['ondemand', false],
      ['auto', false],
    ],
  )
})
