import { readAccount } from '../api/account.js'
import { reconcileAdviceNumbers } from '../shared/adviceValidation.js'
import {
  DEEP_ADVICE_TARGET_MS,
  QUICK_ADVICE_TARGET_MS,
} from '../shared/adviceGenerationPolicy.js'
import {
  TRIGGERED_REVIEW_MODEL_BUDGET_MS,
  TRIGGERED_REVIEW_TIME_LIMIT_MINUTES,
} from '../shared/triggeredReviewDecision.js'

const apiBase = String(process.env.HARNESS_API_URL || 'http://localhost:3001').replace(/\/+$/, '')
const nick = String(process.env.HARNESS_NICK || '').trim()
const password = String(process.env.HARNESS_PASSWORD || '')
const runs = Math.max(1, Math.min(12, Number(process.env.HARNESS_RUNS) || 4))
const concurrency = Math.max(1, Math.min(runs, Number(process.env.HARNESS_CONCURRENCY) || 2))
const budgetMs = Math.max(30000, Math.min(560000, Number(process.env.HARNESS_BUDGET_MS) || 210000))
const profile = String(process.env.HARNESS_PROFILE || 'standard').trim().toLowerCase()
const defaultMaxMs = {
  quick: QUICK_ADVICE_TARGET_MS,
  deep: DEEP_ADVICE_TARGET_MS,
  review: 45000,
}[profile] || 0
const maxMs = Math.max(0, Number(process.env.HARNESS_MAX_MS) || defaultMaxMs)
const scope = String(process.env.HARNESS_SCOPE || 'mixed').trim().toLowerCase()
const selectedCodes = new Set(
  String(process.env.HARNESS_CODES || '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean),
)

if (!nick) throw new Error('请通过 HARNESS_NICK 指定用于只读取样的账号')
if (!password) throw new Error('请通过 HARNESS_PASSWORD 提供Harness账号密码')
const account = await readAccount(nick)
if (!account?.data) throw new Error('Harness 账号不存在或无法读取')
const holdings = (account.data.holding || []).filter((item) => item?.code)
const holdingCodes = new Set(holdings.map((item) => item.code))
const watches = (account.data.plan || []).filter((item) =>
  item?.code && !holdingCodes.has(item.code)
)
const subjects = []
const subjectCount = Math.max(holdings.length, watches.length)
for (let index = 0; index < subjectCount; index += 1) {
  if (holdings[index] && scope !== 'watch') {
    subjects.push({ mode: 'hold_advice', stock: holdings[index] })
  }
  if (watches[index] && scope !== 'holding') {
    subjects.push({ mode: 'buy_advice', stock: watches[index] })
  }
}
const selectedSubjects = selectedCodes.size
  ? subjects.filter((item) => selectedCodes.has(item.stock.code))
  : subjects
if (!selectedSubjects.length) {
  throw new Error('Harness 没有符合范围的持仓或自选标的')
}

function parseFrame(frame) {
  let event = ''
  let raw = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) raw += line.slice(5).trim()
  }
  if (!raw) return { event, data: null }
  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: null }
  }
}

async function parseSSE(response, startedAt) {
  let result = null
  const reasoning = []
  const timeline = [{
    event: 'headers',
    elapsedMs: Date.now() - startedAt,
    status: response.status,
  }]
  let firstReasoningMs = null
  let buffer = ''
  const decoder = new TextDecoder()
  const handleFrame = (frame) => {
    const parsed = parseFrame(frame)
    const event = parsed.event
    const data = parsed.data
    if (event === 'result') result = data
    if (event === 'reasoning' && data?.text) {
      reasoning.push(String(data.text))
      firstReasoningMs ??= Date.now() - startedAt
    }
    if (['phase', 'model', 'result'].includes(event)) {
      timeline.push({
        event,
        key: data?.key || null,
        endpoint: data?.endpoint || null,
        ok: data?.ok ?? null,
        error: data?.error || null,
        elapsedMs: Date.now() - startedAt,
      })
    }
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
      .replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      handleFrame(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim()) handleFrame(buffer)
  return {
    result,
    visibleReasoning: reasoning.join(''),
    firstReasoningMs,
    timeline,
  }
}

function reasoningQuality(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const keys = lines.map((line) =>
    line
      .replace(/[.,;:!?。，；：！？'"`()[\]{}]/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase()
  )
  return {
    lines: lines.length,
    uniqueLines: new Set(keys).size,
    duplicateLines: Math.max(0, lines.length - new Set(keys).size),
  }
}

function caseAt(index) {
  const selected = profile === 'mixed'
    ? ['quick', 'deep', 'review'][index % 3]
    : profile
  const subject = selectedSubjects[index % selectedSubjects.length]
  const stock = subject.stock
  if (subject.mode === 'hold_advice') {
    const previousAdvice = account.data.advice?.[stock.code]?.advice
      || account.data.advice?.[stock.code]
      || null
    const now = Date.now()
    return {
      id: `hold-${stock.code}-${index + 1}`,
      mode: 'hold_advice',
      payload: {
        code: stock.code,
        name: stock.name,
        holdCost: stock.buyPrice,
        holdQty: stock.qty,
        sellableTodayQty: stock.qty,
        account: account.data.account || null,
        ...(selected === 'review' ? {
          previousAdvice,
          reviewOrigin: 'judge',
          reviewEvent: {
            kind: 'price-review',
            reviewMode: 'EXIT_PROTECTION',
            plannedAction: '减仓',
            direction: 'lte',
            threshold: Number(stock.sl || stock.buyPrice),
            price: Number(stock.sl || stock.buyPrice),
            at: now,
            timeLimitMinutes: TRIGGERED_REVIEW_TIME_LIMIT_MINUTES,
            decisionDeadlineAt: now
              + TRIGGERED_REVIEW_TIME_LIMIT_MINUTES * 60 * 1000,
          },
        } : {}),
      },
      profile: selected,
    }
  }
  const previousAdvice = account.data.advice?.[stock.code]?.advice
    || account.data.advice?.[stock.code]
    || null
  const now = Date.now()
  return {
    id: `buy-${stock.code}-${index + 1}`,
    mode: 'buy_advice',
    payload: {
      code: stock.code,
      name: stock.name,
      account: account.data.account || null,
      ...(selected === 'review' ? {
        previousAdvice,
        reviewOrigin: 'judge',
        reviewEvent: {
          kind: 'price-review',
          reviewMode: 'ENTRY_CONFIRMATION',
          plannedAction: 'PROBE',
          actionLabel: '条件试仓',
          directionApproved: true,
          direction: 'gte',
        threshold: Number(stock.buyPrice),
        price: Number(stock.buyPrice),
          at: now,
          timeLimitMinutes: TRIGGERED_REVIEW_TIME_LIMIT_MINUTES,
          decisionDeadlineAt: now
            + TRIGGERED_REVIEW_TIME_LIMIT_MINUTES * 60 * 1000,
        },
      } : {}),
    },
    profile: selected,
  }
}

async function execute(testCase) {
  const startedAt = Date.now()
  const requestBudgetMs = testCase.profile === 'quick'
    ? QUICK_ADVICE_TARGET_MS
    : testCase.profile === 'review'
      ? TRIGGERED_REVIEW_MODEL_BUDGET_MS
      : testCase.profile === 'deep'
        ? DEEP_ADVICE_TARGET_MS
        : budgetMs
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    requestBudgetMs + 20000,
  )
  try {
    const response = await fetch(`${apiBase}/api/ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-account-nick': encodeURIComponent(nick),
        'x-account-password': encodeURIComponent(password),
      },
      body: JSON.stringify({
        mode: testCase.mode,
        payload: testCase.payload,
        stream: true,
        fastMode: ['quick', 'review'].includes(testCase.profile),
        forceReasoning: testCase.profile === 'deep',
        runtimeBudgetMs: requestBudgetMs,
      }),
      signal: controller.signal,
    })
    const parsed = await parseSSE(response, startedAt)
    const output = parsed.result
    const checked = reconcileAdviceNumbers({
      mode: testCase.mode,
      result: output?.result,
      payload: testCase.payload,
    })
    const errors = []
    if (!output?.ok) errors.push(output?.error || '生成失败')
    if (output?.fallbackOnly) {
      errors.push(output?.warning || '仅返回确定性降级结果')
    }
    if (output?.truncated) errors.push('结果被截断')
    if (!checked.valid && checked.issues.length) {
      errors.push(...checked.issues)
    }
    const decisionAction = output?.result?.decisionPlan?.action || null
    const monitoringPlan = output?.result?.monitoringPlan || null
    if (
      testCase.mode === 'hold_advice'
      && decisionAction === 'HOLD'
      && monitoringPlan?.state !== 'READY'
    ) {
      errors.push(
        monitoringPlan
          ? `监控计划不可用：${(monitoringPlan.errors || []).join('；')}`
          : '持有建议缺少监控计划',
      )
    }
    const liveReasoningQuality = reasoningQuality(
      parsed.visibleReasoning,
    )
    const finalReasoningQuality = reasoningQuality(
      output?.result?.reasoning,
    )
    if (liveReasoningQuality.duplicateLines > 0) {
      errors.push(
        `实时研判摘要包含${liveReasoningQuality.duplicateLines}条重复内容`,
      )
    }
    if (
      testCase.profile === 'deep'
      && finalReasoningQuality.uniqueLines < 3
    ) {
      errors.push('深度研判摘要未覆盖至少三个独立维度')
    }
    const elapsedMs = Date.now() - startedAt
    if (maxMs > 0 && elapsedMs > maxMs) {
      errors.push(`耗时${elapsedMs}ms，超过${maxMs}ms目标`)
    }
    const modelCalls = parsed.timeline.filter((item) =>
      item.event === 'model'
    ).length
    if (modelCalls > 1) {
      errors.push(`单次任务触发${modelCalls}次完整模型调用`)
    }
    let llmPasses = 0
    let previousPhase = ''
    for (const item of parsed.timeline) {
      if (item.event !== 'phase') continue
      if (item.key === 'llm' && previousPhase !== 'llm') llmPasses += 1
      previousPhase = item.key
    }
    if (llmPasses > 1) {
      errors.push(`单次任务进入${llmPasses}轮模型生成`)
    }
    return {
      id: testCase.id,
      code: testCase.payload.code,
      name: testCase.payload.name,
      mode: testCase.mode,
      profile: testCase.profile,
      ok: errors.length === 0,
      elapsedMs,
      firstReasoningMs: parsed.firstReasoningMs,
      modelCalls,
      llmPasses,
      model: output?.model || '',
      endpoint: output?.endpoint || '',
      decisionAction,
      monitoringState: monitoringPlan?.state || null,
      monitoringWarnings: monitoringPlan?.warnings || [],
      adjustments: checked.issues,
      liveReasoningQuality,
      finalReasoningQuality,
      errors,
      timeline: parsed.timeline,
    }
  } catch (error) {
    return {
      id: testCase.id,
      code: testCase.payload.code,
      name: testCase.payload.name,
      mode: testCase.mode,
      profile: testCase.profile,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      errors: [String(error?.message || error)],
    }
  } finally {
    clearTimeout(timeout)
  }
}

const results = new Array(runs)
let cursor = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < runs) {
    const index = cursor++
    results[index] = await execute(caseAt(index))
  }
}))
const summary = {
  ok: results.every((result) => result.ok),
  passed: results.filter((result) => result.ok).length,
  total: results.length,
  concurrency,
  profile,
  maxMs: maxMs || null,
  avgMs: Math.round(results.reduce((sum, result) => sum + result.elapsedMs, 0) / results.length),
  results,
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
if (!summary.ok) process.exitCode = 1
