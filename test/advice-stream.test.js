import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceFailureReason,
  createRecoverableSerialRunner,
  createAdviceSSEParser,
  internalRequestHeaders,
  invokeSSE,
  mergeExternalJobs,
  progressPatchForEvent,
  buildAdviceReviewRecord,
  quantResultFromAdviceResponse,
  startJsonHeartbeat,
} from '../api/cron_advice.js'
import { adviceEvidenceDigest } from '../shared/adviceIntelligence.js'
import {
  buildScheduledReviewGateResponse,
  resolveAIBudget,
  resolveAdviceDailySummary,
  resolveReasoningMode,
} from '../api/ai.js'

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

test('服务端单只超时会中止原模型请求避免与重试重叠', async () => {
  let aborted = false
  const result = await invokeSSE((req) => new Promise((resolve) => {
    req.signal.addEventListener('abort', () => {
      aborted = true
      resolve()
    }, { once: true })
  }), {
    timeoutMs: 10,
  })

  assert.equal(result, null)
  assert.equal(aborted, true)
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

test('自动复核门禁返回可持久化的维持原计划契约', () => {
  const snapshot = {
    freshness: { status: 'LIVE', missingSources: [] },
    evidence: { quote: { price: 10.01, pct: 1.2 } },
  }
  const response = buildScheduledReviewGateResponse({
    mode: 'hold_advice',
    origin: 'auto',
    previousDigest: adviceEvidenceDigest(snapshot),
    snapshot,
    hasPreviousAdvice: true,
    meta: { trustScore: { score: 58 } },
    news: [],
    now: 2000,
  })

  assert.equal(response.ok, true)
  assert.equal(response.unchanged, true)
  assert.equal(response.reviewDisposition, 'unchanged')
  assert.equal(response.meta.reviewReason, '关键证据无实质变化')
  assert.equal(response.updatedAt, 2000)
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

test('任务层直接复用军师统一证据中的量化结果', () => {
  const result = quantResultFromAdviceResponse({
    meta: {
      quantResult: {
        score: 68,
        bias: '偏多',
        forecast: { direction: '上涨', upProb: 58 },
      },
    },
  }, 10.25)

  assert.equal(result.score, 68)
  assert.equal(result.price, 10.25)
  assert.equal(result.forecast.direction, '上涨')
})

test('自动复核记录是否调用LLM及风险周期', () => {
  const record = buildAdviceReviewRecord({
    code: '600000',
    mode: 'hold_advice',
    origin: 'auto',
    previousEntry: {
      advice: { action: '持有' },
    },
    cacheItem: {
      at: 2000,
      advice: {
        action: '持有',
        reviewCycle: {
          status: 'unchanged',
          reason: '关键证据无实质变化',
          changeType: 'maintain',
          configuredIntervalMin: 15,
          intervalMin: 5,
          riskLevel: 'urgent',
          riskReasons: ['现价接近止损位'],
        },
      },
      meta: {
        evidenceSnapshot: { snapshotId: 'ev-1' },
      },
    },
    llmRan: false,
    durationMs: 3200,
  })

  assert.equal(record.schemaVersion, 'advice-review.v1')
  assert.equal(record.llmRan, false)
  assert.equal(record.disposition, 'unchanged')
  assert.equal(record.riskLevel, 'urgent')
  assert.equal(record.intervalMin, 5)
  assert.equal(record.evidenceSnapshotId, 'ev-1')
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

test('军师优先使用前置闸门注入的策略日报而不是再次查询覆盖', async () => {
  const injected = {
    day: new Date(Date.now() + 8 * 3600 * 1000)
      .toISOString()
      .slice(0, 10),
    sessionCn: '盘前早报',
    text: '闸门已确认的策略摘要',
  }
  let reads = 0

  const result = await resolveAdviceDailySummary(
    { dailyReport: injected },
    async () => {
      reads++
      return { text: 'OSS中的其它摘要' }
    },
  )

  assert.deepEqual(result, injected)
  assert.equal(reads, 0)
})

test('军师拒绝过期的客户端日报并回退服务端当天摘要', async () => {
  const current = {
    day: new Date(Date.now() + 8 * 3600 * 1000)
      .toISOString()
      .slice(0, 10),
    sessionCn: '盘前早报',
    text: '服务端当天策略摘要',
  }
  let reads = 0

  const result = await resolveAdviceDailySummary(
    {
      dailyReport: {
        day: '2000-01-01',
        sessionCn: '过期日报',
        text: '过期策略摘要',
      },
    },
    async () => {
      reads++
      return current
    },
  )

  assert.deepEqual(result, current)
  assert.equal(reads, 1)
})

test('串行保存单次失败后仍可执行下一次保存', async () => {
  let attempts = 0
  const runner = createRecoverableSerialRunner(async () => {
    attempts++
    if (attempts === 1) throw new Error('OSS瞬时失败')
    return attempts
  })

  await assert.rejects(() => runner.run(), /OSS瞬时失败/)
  assert.equal(await runner.run(), 2)
  await runner.settle()
})
