import test from 'node:test'
import assert from 'node:assert/strict'

import {
  completeJob,
  enqueueJob,
  jobsToProgress,
  leaseJob,
  reapOrphans,
  updateJobProgress,
} from '../api/_jobs.js'

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
