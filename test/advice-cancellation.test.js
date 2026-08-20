import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  activeAdviceCancellationTargets,
  beginAdviceCancellation,
  completeAdviceCancellation,
  confirmAdviceBatchCancellation,
  confirmAdviceCancellation,
  isAdviceCancellationConfirmed,
  settleQueuedAdviceCancellations,
} from '../shared/adviceCancellation.js'
import {
  cancelJob,
  cancelAll,
  enqueueJob,
  isAdviceBatchCanceled,
  jobsToProgress,
  leaseJob,
  markAdviceBatchCanceled,
  mergeAdviceBatchCancellations,
} from '../api/_jobs.js'

const generationStatusSource = readFileSync(
  new URL('../src/components/AdviceGenerationStatus.jsx', import.meta.url),
  'utf8',
)
const planTabSource = readFileSync(
  new URL('../src/components/PlanTab.jsx', import.meta.url),
  'utf8',
)
const adviceBatchSource = readFileSync(
  new URL('../src/adviceBatch.js', import.meta.url),
  'utf8',
)
const serverAdviceSource = readFileSync(
  new URL('../src/serverAdvice.js', import.meta.url),
  'utf8',
)
const cronAdviceSource = readFileSync(
  new URL('../api/cron_advice.js', import.meta.url),
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

test('批次取消墓碑阻止迟到的云端入队请求复活任务', () => {
  const data = {}
  markAdviceBatchCanceled(data, 'batch-late', 1000)

  const result = enqueueJob(data, {
    code: '600000',
    mode: 'buy_advice',
    batchId: 'batch-late',
    batchRequest: true,
  }, 1100)

  assert.equal(result.created, false)
  assert.equal(result.canceled, true)
  assert.equal(data.jobs?.['600000'], undefined)
  assert.equal(isAdviceBatchCanceled(data, 'batch-late', 1200), true)
})

test('取消与入队并发落盘时墓碑合并后终止迟到任务', () => {
  const cancelWorking = {}
  const enqueueWorking = {}
  markAdviceBatchCanceled(cancelWorking, 'batch-race', 1000)
  enqueueJob(enqueueWorking, {
    code: '600000',
    mode: 'buy_advice',
    batchId: 'batch-race',
    batchRequest: true,
  }, 1001)

  mergeAdviceBatchCancellations(enqueueWorking, cancelWorking, 1100)

  assert.equal(
    enqueueWorking.jobs['600000'].status,
    'canceled',
  )
  assert.equal(
    enqueueWorking.jobs['600000'].cancelRequested,
    true,
  )
})

test('批次全部取消幂等并在进度中返回权威确认', () => {
  const data = {}
  enqueueJob(data, {
    code: '600000',
    mode: 'buy_advice',
    batchId: 'batch-all',
    batchRequest: true,
  }, 1000)
  leaseJob(data, '600000', 1100)
  enqueueJob(data, {
    code: '000001',
    mode: 'buy_advice',
    batchId: 'batch-other',
    batchRequest: true,
  }, 1101)
  data.activeAdviceBatchId = 'batch-all'

  assert.equal(cancelAll(data, 1200, 'batch-all'), 1)
  assert.equal(cancelAll(data, 1300, 'batch-all'), 0)
  assert.equal(data.jobs['000001'].status, 'queued')
  assert.equal(isAdviceBatchCanceled(data, 'batch-all', 1300), true)
  const progress = jobsToProgress(data, 1400, 2)
  assert.equal(progress.batchId, 'batch-all')
  assert.equal(progress.batchCanceled, true)
  assert.equal(progress.running, true)
})

test('批次取消响应丢失后重试仍可由服务端墓碑确认', async () => {
  let sends = 0
  const result = await confirmAdviceBatchCancellation({
    batchId: 'batch-retry',
    targets: [{ code: '600000', batchId: 'batch-retry' }],
    attempts: 3,
    delay: async () => {},
    send: async () => {
      sends++
      if (sends === 1) throw new Error('response lost')
      return {
        ok: true,
        confirmed: true,
        batchId: 'batch-retry',
        progress: {
          batchId: 'batch-retry',
          batchCanceled: true,
          items: [],
        },
      }
    },
    readStatus: async () => null,
  })

  assert.equal(result.confirmed, true)
  assert.equal(result.batchId, 'batch-retry')
  assert.equal(sends, 2)
})

test('本地个股停止同时中止runner并更新批量项且全部按钮语义明确', () => {
  assert.match(
    generationStatusSource,
    /else\s*\{\s*cancelAdvice\(code\)\s*void cancelOne\(code\)/,
  )
  assert.match(planTabSource, /全部停止/)
})

test('全部停止不等待提交请求并使用批次级取消协议', () => {
  const cancelAllBlock = adviceBatchSource.match(
    /async function cancelBatchInternal\(\)[\s\S]*?(?=export function cancelBatch)/,
  )?.[0] || ''
  assert.match(adviceBatchSource, /cancelServerAdviceBatch\(/)
  assert.doesNotMatch(
    cancelAllBlock,
    /await state\._submissionPromise/,
  )
  assert.match(serverAdviceSource, /op:\s*'cancelAll'/)
  assert.match(cronAdviceSource, /markAdviceBatchCanceled/)
  assert.match(planTabSource, /batch\.cancelError\s*\?\s*'重试停止'/)
})
