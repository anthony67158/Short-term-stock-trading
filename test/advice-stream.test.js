import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceFailureReason,
  createAdviceSSEParser,
  internalRequestHeaders,
  mergeExternalJobs,
  progressPatchForEvent,
  startJsonHeartbeat,
} from '../api/cron_advice.js'
import { resolveAIBudget, resolveReasoningMode } from '../api/ai.js'

test('服务端可解析跨分片的 AI SSE 事件', () => {
  const seen = []
  const parser = createAdviceSSEParser((event, data) => seen.push({ event, data }))

  parser.push('event: phase\ndata: {"text":"正在采集')
  parser.push('行情"}\n\nevent: reasoning\ndata: {"text":"正在判断支撑位。"}\n\n')
  parser.end()

  assert.deepEqual(seen, [
    { event: 'phase', data: { text: '正在采集行情' } },
    { event: 'reasoning', data: { text: '正在判断支撑位。' } },
  ])
})

test('AI SSE 事件会转换为持久任务进度补丁', () => {
  assert.deepEqual(
    progressPatchForEvent('phase', { text: '正在量化打分' }),
    { phase: '正在量化打分' },
  )
  assert.deepEqual(
    progressPatchForEvent('source', { label: '实时行情', ok: true }),
    { source: { label: '实时行情', ok: true } },
  )
  assert.deepEqual(
    progressPatchForEvent('reasoning', { text: '正在检查量价共振。' }),
    { reasoningDelta: '正在检查量价共振。' },
  )
  assert.deepEqual(
    progressPatchForEvent('model', { model: 'DeepSeek-V4-Pro', endpoint: '主端点' }),
    { model: 'DeepSeek-V4-Pro', endpoint: '主端点' },
  )
})

test('批量 Worker 用标准 SSE 注释心跳保持长请求连接', () => {
  const chunks = []
  const headers = {}
  const stop = startJsonHeartbeat({
    writableEnded: false,
    setHeader: (key, value) => { headers[key.toLowerCase()] = value },
    write: (chunk) => chunks.push(chunk),
  }, 60000)
  stop()

  assert.equal(headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(headers['x-accel-buffering'], 'no')
  assert.equal(chunks.length, 1)
  assert.match(chunks[0], /^: hb \d+\n\n$/)
})

test('服务端进程内调用使用当前运行时端口而不是无效公网地址', () => {
  assert.deepEqual(internalRequestHeaders({ PORT: '3000' }), {
    host: '127.0.0.1:3000',
    'x-forwarded-host': '127.0.0.1:3000',
    'x-forwarded-proto': 'http',
  })
  assert.equal(
    internalRequestHeaders({ FC_SERVER_PORT: '9000' })['x-forwarded-host'],
    '127.0.0.1:9000',
  )
})

test('持久任务保留安全的军师失败原因而不是泛化为空结果', () => {
  assert.equal(
    adviceFailureReason({ ok: false, error: '模型未返回有效内容，请稍后重试。' }),
    '模型未返回有效内容，请稍后重试。',
  )
  assert.equal(
    adviceFailureReason({ ok: true, truncated: true }, true),
    '深度建议输出不完整',
  )
})

test('旧批次的取消状态不能污染同股票的新一轮强制生成', () => {
  const working = {
    jobs: {
      '600000': {
        id: 'new-job',
        code: '600000',
        status: 'queued',
        at: 2000,
        cancelRequested: false,
      },
    },
  }
  const fresh = {
    jobs: {
      '600000': {
        id: 'old-job',
        code: '600000',
        status: 'canceled',
        at: 1000,
        cancelRequested: true,
      },
    },
  }

  mergeExternalJobs(working, fresh)

  assert.equal(working.jobs['600000'].status, 'queued')
  assert.equal(working.jobs['600000'].cancelRequested, false)
})

test('同一任务的外部取消仍会立即传播到 Worker', () => {
  const working = {
    jobs: {
      '600000': {
        id: 'same-job',
        code: '600000',
        status: 'running',
        at: 2000,
        cancelRequested: false,
      },
    },
  }
  const fresh = {
    jobs: {
      '600000': {
        id: 'same-job',
        code: '600000',
        status: 'canceled',
        at: 2000,
        finishedAt: 2500,
        progressAt: 2500,
        cancelRequested: true,
      },
    },
  }

  mergeExternalJobs(working, fresh)

  assert.equal(working.jobs['600000'].status, 'canceled')
  assert.equal(working.jobs['600000'].cancelRequested, true)
})

test('Worker合并后采用最新活跃任务的批次且保留旧任务运行态', () => {
  const working = {
    activeAdviceBatchId: 'single-a',
    jobs: {
      '600000': {
        id: 'job-a',
        code: '600000',
        batchId: 'single-a',
        status: 'running',
        at: 1000,
      },
    },
  }
  const fresh = {
    activeAdviceBatchId: 'single-b',
    jobs: {
      '600000': { ...working.jobs['600000'] },
      '000001': {
        id: 'job-b',
        code: '000001',
        batchId: 'single-b',
        status: 'queued',
        at: 2000,
      },
    },
  }

  mergeExternalJobs(working, fresh)

  assert.equal(working.jobs['600000'].status, 'running')
  assert.equal(working.jobs['000001'].status, 'queued')
  assert.equal(working.activeAdviceBatchId, 'single-b')
})

test('批量任务可收紧单股预算但不能突破安全边界', () => {
  assert.equal(resolveAIBudget(true, 210000), 210000)
  assert.equal(resolveAIBudget(true, 999999), 560000)
  assert.equal(resolveAIBudget(true, 1000), 30000)
  assert.equal(resolveAIBudget(false, null), 150000)
})

test('批量快速模式会关闭深度思考，普通单股生成保持原配置', () => {
  assert.equal(resolveReasoningMode(true, true), false)
  assert.equal(resolveReasoningMode(true, false), true)
  assert.equal(resolveReasoningMode(false, false), false)
  assert.equal(resolveReasoningMode(false, false, true), true)
})
