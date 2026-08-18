import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  activeAdviceCancellationTargets,
  beginAdviceCancellation,
  completeAdviceCancellation,
  confirmAdviceCancellation,
  isAdviceCancellationConfirmed,
  settleQueuedAdviceCancellations,
} from '../shared/adviceCancellation.js'
import {
  cancelJob,
  enqueueJob,
  jobsToProgress,
  leaseJob,
} from '../api/_jobs.js'

const generationStatusSource = readFileSync(
  new URL('../src/components/AdviceGenerationStatus.jsx', import.meta.url),
  'utf8',
)
const planTabSource = readFileSync(
  new URL('../src/components/PlanTab.jsx', import.meta.url),
  'utf8',
)

test('全部停止收集所有跨批次活跃任务并保留精确jobId', () => {
  const targets = activeAdviceCancellationTargets([
    { code: '600000', status: 'running', jobId: 'job-a', batchId: 'a' },
    { code: '000001', status: 'queued', jobId: 'job-b', batchId: 'b' },
    { code: '000002', status: 'ok', jobId: 'job-c', batchId: 'c' },
  ])

  assert.deepEqual(targets, [
    { code: '600000', jobId: 'job-a', batchId: 'a' },
    { code: '000001', jobId: 'job-b', batchId: 'b' },
  ])
  assert.deepEqual(activeAdviceCancellationTargets(targets), targets)
})

test('取消中的视图保留运行态直到云端确认且排队任务可立即隐藏', () => {
  const result = beginAdviceCancellation([
    { code: '600000', status: 'running' },
    { code: '000001', status: 'queued' },
    { code: '000002', status: 'ok' },
  ])

  assert.deepEqual(result.items.map((item) => item.status), [
    'canceling',
    'canceling',
    'ok',
  ])
  assert.deepEqual(result.abortCodes, ['600000'])
})

test('本地全部停止只立即结算未启动任务并保留在途任务等待Abort完成', () => {
  const canceling = beginAdviceCancellation([
    { code: '600000', status: 'running' },
    { code: '000001', status: 'pending' },
    { code: '000002', status: 'queued' },
    { code: '000003', status: 'ok' },
  ])
  const settled = settleQueuedAdviceCancellations(canceling.items)

  assert.deepEqual(settled.items.map((item) => item.status), [
    'canceling',
    'skipped',
    'skipped',
    'ok',
  ])
  assert.equal(settled.skipped, 2)
})

test('在途任务Abort完成只结算一次避免取消进度重复计数', () => {
  const first = completeAdviceCancellation({
    code: '600000',
    status: 'canceling',
  })
  const repeated = completeAdviceCancellation(first.item)

  assert.equal(first.changed, true)
  assert.equal(first.item.status, 'skipped')
  assert.equal(repeated.changed, false)
  assert.equal(repeated.item.status, 'skipped')
})

test('云端取消首次网络失败后重试并等待权威状态确认', async () => {
  let sends = 0
  let reads = 0
  const targets = [{ code: '600000', jobId: 'job-a' }]
  const result = await confirmAdviceCancellation({
    targets,
    attempts: 3,
    delay: async () => {},
    send: async () => {
      sends++
      if (sends === 1) throw new Error('network reset')
      return {
        ok: true,
        progress: {
          items: [{ code: '600000', jobId: 'job-a', status: 'canceling' }],
        },
      }
    },
    readStatus: async () => {
      reads++
      return {
        items: reads === 1
          ? [{ code: '600000', jobId: 'job-a', status: 'running' }]
          : [{ code: '600000', jobId: 'job-a', status: 'skipped' }],
      }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.confirmed, true)
  assert.equal(sends, 2)
  assert.equal(reads, 2)
})

test('取消请求和状态查询都失败时不能伪装成已停止', async () => {
  const result = await confirmAdviceCancellation({
    targets: [{ code: '600000', jobId: 'job-a' }],
    attempts: 2,
    delay: async () => {},
    send: async () => {
      throw new Error('network reset')
    },
    readStatus: async () => null,
  })

  assert.equal(result.ok, false)
  assert.equal(result.confirmed, false)
  assert.match(result.error, /network reset/)
})

test('同股票已换成新jobId时旧取消视为完成且不能取消新任务', () => {
  const targets = [{ code: '600000', jobId: 'old-job' }]

  assert.equal(isAdviceCancellationConfirmed({
    items: [{ code: '600000', jobId: 'new-job', status: 'running' }],
  }, targets), true)
})

test('尚未取得jobId且任务暂未出现时不能提前宣告停止成功', () => {
  const targets = [{
    code: '600000',
    jobId: '',
    batchId: 'submitting-batch',
  }]

  assert.equal(isAdviceCancellationConfirmed({ items: [] }, targets), false)
  assert.equal(isAdviceCancellationConfirmed({
    items: [{
      code: '600000',
      jobId: 'new-job',
      batchId: 'other-batch',
      status: 'running',
    }],
  }, targets), true)
})

test('服务端取消必须匹配jobId并在进度中返回任务身份', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    mode: 'buy_advice',
    batchId: 'batch-a',
  }, 1000)
  leaseJob(data, '600000', 1100)
  const jobId = data.jobs['600000'].id

  assert.equal(
    cancelJob(data, '600000', 1200, '', 'stale-job'),
    false,
  )
  assert.equal(data.jobs['600000'].status, 'running')
  assert.equal(cancelJob(data, '600000', 1300, '', jobId), true)

  const item = jobsToProgress(data, 1400, 2).items[0]
  assert.equal(item.jobId, jobId)
  assert.equal(item.batchId, 'batch-a')
  assert.equal(item.status, 'skipped')
})

test('本地个股停止同时中止runner并更新批量项且全部按钮语义明确', () => {
  assert.match(
    generationStatusSource,
    /else\s*\{\s*cancelAdvice\(code\)\s*void cancelOne\(code\)/,
  )
  assert.match(planTabSource, /全部停止/)
})
