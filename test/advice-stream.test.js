import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceRuntimeUpdateFromData,
  adviceFailureReason,
  adviceTradeStateMatches,
  createRecoverableSerialRunner,
  createAdviceSSEParser,
  internalRequestHeaders,
  invoke,
  invokeSSE,
  mergeExternalJobs,
  progressPatchForEvent,
  buildAdviceReviewRecord,
  quantResultFromAdviceResponse,
  requeueAdviceForTradeChange,
  startJsonHeartbeat,
} from '../api/cron_advice.js'
import { adviceEvidenceDigest } from '../shared/adviceIntelligence.js'
import {
  buildScheduledReviewGateResponse,
  resolveAIBudget,
  resolveAdviceDailySummary,
  resolveReasoningMode,
  shouldRepairAdvisorBody,
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

test('军师阶段事件保留稳定阶段键供前端展示完整流程', () => {
  assert.deepEqual(progressPatchForEvent('phase', {
    key: 'quant',
    text: '正在量化打分',
  }), {
    stage: 'quant',
    phase: '正在量化打分',
  })
  assert.deepEqual(progressPatchForEvent('quant', {
    summary: '上涨概率48%，当前只适合回调低吸。',
  }), {
    quant: {
      summary: '上涨概率48%，当前只适合回调低吸。',
    },
  })
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

test('服务端进程内调用完成后立即清理长超时与中止监听', async () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timers = new Set()
  let abortAdds = 0
  let abortRemoves = 0
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay }
    timers.add(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    timers.delete(timer)
  }
  const signal = {
    aborted: false,
    addEventListener() { abortAdds++ },
    removeEventListener() { abortRemoves++ },
  }

  try {
    const result = await invoke((_req, res) => {
      res.json({ ok: true })
    }, { signal })

    assert.deepEqual(result, { ok: true })
    assert.equal(timers.size, 0)
    assert.equal(abortAdds, 1)
    assert.equal(abortRemoves, 1)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test('军师生成期间持仓或成交变化时旧结果必须失效', () => {
  const source = {
    plan: [],
    holding: [{
      id: 'holding-1',
      code: '002309',
      qty: 25,
      buyPrice: 3.26,
      buyFee: 5.08,
    }],
    closed: [],
    account: { cash: 58000 },
  }
  const latest = {
    ...source,
    holding: [{
      ...source.holding[0],
      qty: 16,
      buyFee: 3.25,
    }],
    closed: [{
      id: 'sell-9',
      type: 'SELL',
      code: '002309',
      qty: 9,
      price: 3.05,
      at: 1000,
    }],
  }

  assert.equal(adviceTradeStateMatches(source, source), true)
  assert.equal(adviceTradeStateMatches(source, latest), false)
})

test('交易变化导致的旧建议不消耗重试次数并按最新账本重新排队', () => {
  const data = {
    jobs: {
      '002309': {
        id: 'job-1',
        code: '002309',
        status: 'running',
        attempts: 1,
        startedAt: 900,
        leaseUntil: 999999,
      },
    },
  }

  const job = requeueAdviceForTradeChange(data, '002309', 1000)

  assert.equal(job.status, 'queued')
  assert.equal(job.attempts, 0)
  assert.equal(job.startedAt, 0)
  assert.equal(job.leaseUntil, 0)
  assert.match(job.phase, /最新持仓重新复核/)
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
    adviceFailureReason({
      ok: true,
      truncated: true,
      result: { action: '持有' },
    }, 'hold_advice'),
    '军师建议输出被截断',
  )
  assert.equal(
    adviceFailureReason({
      ok: true,
      truncated: false,
      result: { action: '持有' },
    }, 'hold_advice'),
    '军师建议缺少：标题、执行指令、失效条件、核心依据',
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

test('快速与深度军师的截断正文都会在任务内自动重整', () => {
  assert.equal(shouldRepairAdvisorBody({
    advisor: true,
    budgetMs: 20000,
    parsed: { value: { action: '持有' }, repaired: true },
  }), true)
  assert.equal(shouldRepairAdvisorBody({
    advisor: true,
    budgetMs: 20000,
    parsed: { value: null, repaired: false },
  }), true)
  assert.equal(shouldRepairAdvisorBody({
    advisor: true,
    budgetMs: 20000,
    parsed: { value: { action: '持有' }, repaired: false },
  }), false)
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

test('单股完成增量只携带该股建议和必要运行态', () => {
  const data = {
    advice: {
      '600519': {
        at: 300,
        advice: { action: '持有', reasoning: 'a'.repeat(1000) },
      },
      '000001': {
        at: 200,
        advice: { action: '观望', reasoning: 'b'.repeat(1000) },
      },
    },
    jobs: {
      '600519': {
        id: 'job-1',
        code: '600519',
        status: 'done',
        progressAt: 300,
      },
      '000001': {
        id: 'job-2',
        code: '000001',
        status: 'running',
        progressAt: 250,
      },
    },
    adviceLog: [
      { id: 'log-a', code: '600519', at: 300 },
      { id: 'log-b', code: '000001', at: 200 },
    ],
    decisionLog: [
      { id: 'decision-a', code: '600519', at: 300 },
      { id: 'decision-b', code: '000001', at: 200 },
    ],
    alerts: [
      { id: 'alert-a', code: '600519', updatedAt: 300 },
      { id: 'alert-b', code: '000001', updatedAt: 200 },
    ],
    plan: [
      { code: '600519', qScore: 72, qBias: '偏多', qAt: 300 },
      { code: '000001', qScore: 48, qBias: '中性', qAt: 200 },
    ],
  }

  const update = adviceRuntimeUpdateFromData(
    data,
    '600519',
    320,
    2,
  )

  assert.equal(update.code, '600519')
  assert.equal(update.advice.advice.action, '持有')
  assert.equal(update.job.status, 'done')
  assert.deepEqual(update.adviceLog.map((item) => item.id), ['log-a'])
  assert.deepEqual(
    update.decisionLog.map((item) => item.id),
    ['decision-a'],
  )
  assert.deepEqual(update.alerts.map((item) => item.id), ['alert-a'])
  assert.deepEqual(update.planPatch, {
    code: '600519',
    qScore: 72,
    qBias: '偏多',
    qAt: 300,
  })
  assert.ok(Buffer.byteLength(JSON.stringify(update)) < 100_000)
})
