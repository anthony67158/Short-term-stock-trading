import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cancelJob,
  completeJob,
  enqueueJob,
  jobsToProgress,
  leaseJob,
  reapOrphans,
  updateJobProgress,
} from '../api/_jobs.js'
import { shouldDetachOnDemandDrain } from '../api/cron_advice.js'

test('过期运行任务会被回收并在进度中显示为排队等待续跑', () => {
  const data = {}
  enqueueJob(data, { code: '600000', name: '浦发银行', mode: 'buy_advice' }, 1000)
  leaseJob(data, '600000', 1000)

  const reaped = reapOrphans(data, 1000 + 500 * 1000)
  const progress = jobsToProgress(data, 1000 + 500 * 1000, 2)

  assert.equal(reaped, 1)
  assert.equal(progress.running, true)
  assert.equal(progress.items[0].status, 'queued')
  assert.equal(progress.items[0].phase, '任务中断，等待云端自动续跑')
})

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
  assert.equal(job.maxAttempts, 3)
  assert.equal(progress.deepMode, true)
  assert.equal(progress.items[0].deepMode, true)
})

test('用户按需生成入队后必须脱离浏览器请求继续执行', () => {
  assert.equal(shouldDetachOnDemandDrain({
    op: 'enqueue',
    ondemand: true,
  }), true)
  assert.equal(shouldDetachOnDemandDrain({
    op: 'enqueue',
    ondemand: false,
  }), false)
  assert.equal(shouldDetachOnDemandDrain({
    op: 'status',
    ondemand: true,
  }), false)
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

test('进度快照携带单股阶段、数据源、模型端点和简体中文推理', () => {
  const data = {}
  enqueueJob(data, { code: '600000', name: '浦发银行', mode: 'buy_advice' }, 1000)
  leaseJob(data, '600000', 1000)
  updateJobProgress(data, '600000', {
    phase: '正在分析量价与资金共振',
    sources: [{ label: '实时行情', ok: true }],
    reasoning: '正在判断支撑位是否有效，并计算盈亏比。',
    model: 'DeepSeek-V4-Pro',
    endpoint: '主端点',
  }, 2000)

  const item = jobsToProgress(data, 2500, 2).items[0]
  assert.equal(item.phase, '正在分析量价与资金共振')
  assert.equal(item.reasoning, '正在判断支撑位是否有效，并计算盈亏比。')
  assert.deepEqual(item.sources, [{ label: '实时行情', ok: true }])
  assert.equal(item.model, 'DeepSeek-V4-Pro')
  assert.equal(item.endpoint, '主端点')
  assert.equal(item.progressAt, 2000)
})

test('持久任务推理限制长度并清理英文思维链标题', () => {
  const data = {}
  enqueueJob(data, { code: '600000', name: '浦发银行', mode: 'buy_advice' }, 1000)
  updateJobProgress(data, '600000', {
    reasoning: `Analyzing momentum...\n正在分析走势。${'中文推理'.repeat(3000)}`,
  }, 2000)

  const reasoning = data.jobs['600000'].reasoning
  assert.equal(reasoning.includes('Analyzing momentum'), false)
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

test('没有任务时不生成虚假的空批次完成时间', () => {
  const progress = jobsToProgress({}, 5000, 2)

  assert.equal(progress.total, 0)
  assert.equal(progress.done, 0)
  assert.equal(progress.running, false)
  assert.equal(progress.at, 0)
  assert.equal(progress.finishedAt, 0)
})
