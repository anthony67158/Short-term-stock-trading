export const EXECUTION_EVENT_TYPES = Object.freeze([
  'QUOTE_UPDATE',
  'BAR_5M_CLOSED',
  'PRICE_TRIGGERED',
  'ACCOUNT_CHANGED',
  'NEWS_MATERIAL',
  'DAILY_CLOSE',
  'SCHEDULED_REVIEW',
  'USER_REQUEST',
])

function hashText(value) {
  let hash = 2166136261
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function llmDecision(event) {
  const payload = event.payload || {}
  if (event.type === 'USER_REQUEST') {
    return { runLlm: true, reason: '用户主动请求' }
  }
  if (event.type === 'NEWS_MATERIAL' && payload.material === true) {
    return { runLlm: true, reason: '重大消息改变软证据' }
  }
  if (
    event.type === 'PRICE_TRIGGERED'
    && payload.planConflict === true
    && payload.hardRisk !== true
  ) {
    return { runLlm: true, reason: '触价后出现计划冲突' }
  }
  if (
    event.type === 'SCHEDULED_REVIEW'
    && payload.evidenceChanged === true
  ) {
    return { runLlm: true, reason: '到期且证据发生实质变化' }
  }
  return {
    runLlm: false,
    reason: payload.hardRisk === true
      ? '硬风险由确定性规则直接处理'
      : '事件只需确定性重算',
  }
}

export function createExecutionEvent({
  type,
  code = '',
  planId = '',
  sourceAsOf = '',
  payload = {},
  idempotencyKey = '',
} = {}, now = Date.now()) {
  if (!EXECUTION_EVENT_TYPES.includes(type)) {
    throw new Error(`不支持的执行事件:${type}`)
  }
  const normalizedCode = String(code || '')
  const normalizedPlanId = String(planId || '')
  const normalizedAsOf = String(sourceAsOf || '')
  const key = String(idempotencyKey || '').trim()
    || `${type}:${normalizedCode}:${normalizedPlanId}:${hashText(
      `${normalizedAsOf}|${JSON.stringify(payload || {})}`,
    )}`
  return {
    schemaVersion: 'execution-event.v1',
    eventId: `event.${hashText(`${key}|${Number(now)}`)}`,
    idempotencyKey: key.slice(0, 200),
    type,
    code: normalizedCode,
    planId: normalizedPlanId,
    sourceAsOf: normalizedAsOf,
    payload: structuredClone(payload || {}),
    receivedAt: Number(now),
  }
}

export function processExecutionEvent(
  inputState,
  event,
  now = Date.now(),
) {
  if (event?.schemaVersion !== 'execution-event.v1') {
    throw new Error('执行事件版本无效')
  }
  const state = {
    processed: { ...(inputState?.processed || {}) },
    history: Array.isArray(inputState?.history)
      ? inputState.history.slice(-499)
      : [],
    stats: {
      total: Number(inputState?.stats?.total) || 0,
      unique: Number(inputState?.stats?.unique) || 0,
      duplicates: Number(inputState?.stats?.duplicates) || 0,
      llmRuns: Number(inputState?.stats?.llmRuns) || 0,
      deterministicOnly:
        Number(inputState?.stats?.deterministicOnly) || 0,
    },
  }
  for (const [key, at] of Object.entries(state.processed)) {
    if (Number(now) - (Number(at) || 0) > 24 * 3600 * 1000) {
      delete state.processed[key]
    }
  }
  const recentKeys = Object.entries(state.processed)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
  for (const [key] of recentKeys.slice(1000)) {
    delete state.processed[key]
  }
  state.stats.total++
  if (state.processed[event.idempotencyKey]) {
    state.stats.duplicates++
    return {
      state,
      duplicate: true,
      decision: {
        runDeterministic: false,
        runLlm: false,
        reason: '重复事件已忽略',
      },
    }
  }
  const llm = llmDecision(event)
  state.stats.unique++
  if (llm.runLlm) state.stats.llmRuns++
  else state.stats.deterministicOnly++
  const record = {
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    type: event.type,
    code: event.code,
    planId: event.planId,
    at: Number(now),
    duplicate: false,
    runLlm: llm.runLlm,
    reason: llm.reason,
  }
  state.processed[event.idempotencyKey] = Number(now)
  state.history = [record, ...state.history].slice(0, 500)
  return {
    state,
    duplicate: false,
    decision: {
      runDeterministic: true,
      runLlm: llm.runLlm,
      reason: llm.reason,
      invalidatePlan: event.type === 'ACCOUNT_CHANGED'
        || event.type === 'NEWS_MATERIAL',
      hardRisk: event.payload?.hardRisk === true,
    },
  }
}

export function summarizeExecutionEventState(state = {}) {
  const stats = state.stats || {}
  const unique = Number(stats.unique) || 0
  const deterministicOnly = Number(stats.deterministicOnly) || 0
  return {
    schemaVersion: 'execution-event-metrics.v1',
    total: Number(stats.total) || 0,
    unique,
    duplicates: Number(stats.duplicates) || 0,
    llmRuns: Number(stats.llmRuns) || 0,
    deterministicOnly,
    llmSaved: deterministicOnly,
    llmSavedPct: unique
      ? +(deterministicOnly / unique * 100).toFixed(1)
      : 0,
  }
}

export function summarizeExecutionEvents(records = []) {
  const total = records.length
  const duplicates = records.filter(
    (item) => item?.duplicate === true,
  ).length
  const unique = total - duplicates
  const llmRuns = records.filter(
    (item) => item?.duplicate !== true && item?.runLlm === true,
  ).length
  const deterministicOnly = Math.max(0, unique - llmRuns)
  const llmSaved = deterministicOnly
  return {
    total,
    unique,
    duplicates,
    llmRuns,
    deterministicOnly,
    llmSaved,
    llmSavedPct: unique
      ? +(llmSaved / unique * 100).toFixed(1)
      : 0,
  }
}
