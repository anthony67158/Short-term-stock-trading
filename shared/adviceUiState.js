import { adviceEntryMatchesMode } from './adviceModeContext.js'
import { isCompleteAdviceEntry } from './adviceBatchPolicy.js'
import { adviceRequestId } from './adviceGenerationPolicy.js'

const QUICK_GENERATION_STEPS = Object.freeze([
  { key: 'prepare', label: '准备上下文' },
  { key: 'collect', label: '采集证据' },
  { key: 'quant', label: '量化校验' },
  { key: 'decision', label: '生成结论' },
])

const DEEP_GENERATION_STEPS = Object.freeze([
  { key: 'prepare', label: '准备上下文' },
  { key: 'collect', label: '采集证据' },
  { key: 'quant', label: '量化校验' },
  { key: 'draft', label: '深度研判' },
  { key: 'decision', label: '发布最终结论' },
])

function inferredGenerationStage(generation = {}) {
  const explicit = String(generation.stage || '')
  if (['queued', 'preparing'].includes(explicit)) return 'prepare'
  if (explicit === 'collect') return 'collect'
  if (explicit === 'quant') return 'quant'
  if (['theory', 'llm', 'failover'].includes(explicit)) {
    return generation.deepMode === true ? 'draft' : 'decision'
  }
  if (explicit === 'finalize') return 'decision'
  if (['done', 'failed'].includes(explicit)) return explicit
  const phase = String(generation.phase || generation.label || '')
  if (/量化/.test(phase)) return 'quant'
  if (/采集|行情|资金|证据/.test(phase)) return 'collect'
  if (/发布最终|最终结论/.test(phase)) return 'decision'
  if (/生成|整理|模型|端点|候选/.test(phase)) {
    return generation.deepMode === true ? 'draft' : 'decision'
  }
  return 'prepare'
}

export function adviceGenerationSteps(generation = {}) {
  const steps = generation.deepMode === true
    ? DEEP_GENERATION_STEPS
    : QUICK_GENERATION_STEPS
  const stage = inferredGenerationStage(generation)
  const activeIndex = steps.findIndex((step) => step.key === stage)
  return steps.map((step, index) => ({
    ...step,
    state: stage === 'done'
      ? 'done'
      : index < Math.max(0, activeIndex)
        ? 'done'
        : index === Math.max(0, activeIndex)
          ? 'active'
          : 'pending',
  }))
}

export function shouldApplyCloudBatch(progress) {
  return !!(
    progress &&
    typeof progress === 'object' &&
    Number(progress.total) > 0 &&
    Array.isArray(progress.items) &&
    progress.items.length > 0
  )
}

function cloudProgressSignature(progress = {}) {
  const items = (list) => (Array.isArray(list) ? list : []).map((item) => [
    String(item?.code || ''),
    String(item?.jobId || ''),
    String(item?.status || ''),
    String(item?.stage || ''),
    String(item?.phase || ''),
    String(item?.error || ''),
    Number(item?.progressAt) || 0,
  ])
  return JSON.stringify({
    batchId: String(progress.batchId || ''),
    running: progress.running === true,
    total: Number(progress.total) || 0,
    done: Number(progress.done) || 0,
    ok: Number(progress.ok) || 0,
    fail: Number(progress.fail) || 0,
    skipped: Number(progress.skipped) || 0,
    items: items(progress.items),
    reviews: items(progress.reviews),
  })
}

export function shouldApplyCloudProgressSnapshot(
  current,
  incoming,
  { force = false } = {},
) {
  if (force) return true
  const incomingAt = Number(incoming?.at) || 0
  if (!incomingAt) return false
  const currentAt = Number(current?.at) || 0
  if (incomingAt !== currentAt) return incomingAt > currentAt
  return cloudProgressSignature(current)
    !== cloudProgressSignature(incoming)
}

export function mergeCloudAdviceItems(
  previousItems = [],
  incomingItems = [],
) {
  const previousByCode = new Map(
    (Array.isArray(previousItems) ? previousItems : [])
      .map((item) => [String(item?.code || ''), item]),
  )
  const isTerminal = (status) =>
    ['ok', 'fail', 'skipped'].includes(String(status || ''))
  return (Array.isArray(incomingItems) ? incomingItems : []).map((item) => {
    const next = { ...item }
    const previous = previousByCode.get(String(next.code || ''))
    if (
      previous
      && previous.jobId
      && previous.jobId === next.jobId
      && isTerminal(previous.status)
      && !isTerminal(next.status)
    ) return previous
    return next
  })
}

export function isAdviceItemActive(item) {
  return [
    'queued',
    'pending',
    'running',
    'canceling',
    'publishing',
  ].includes(String(item?.status || ''))
}

export function adviceJobState(
  batch,
  code,
  { role = 'advisor' } = {},
) {
  if (!batch || !code) return null
  const source = role === 'review'
    ? batch.reviews
    : batch.items
  const item = (source || []).find((entry) =>
    String(entry?.code) === String(code)
  )
  if (!isAdviceItemActive(item)) return null
  const running = item.status === 'running'
  const canceling = item.status === 'canceling'
  const publishing = item.status === 'publishing'
  const review = role === 'review'
  const defaultLabel = review
    ? running ? '建议复核中' : '排队等待云端复核'
    : running ? '操作建议生成中' : '排队等待云端生成'
  return {
    active: true,
    status: item.status,
    ...(review ? { role: 'review' } : {}),
    stage: String(item.stage || ''),
    label: canceling
      ? '正在取消生成'
      : publishing
        ? '正在核验并发布最终结论'
      : (item.phase || defaultLabel),
    cancelable: !review && !canceling && !publishing,
    cloud: !!batch.serverMode,
    deepMode: item.deepMode === true,
  }
}

const REVIEW_TERMINAL_VISIBLE_MS = 2 * 60 * 1000
const REVIEW_QUEUE_TIMEOUT_MS = 90 * 1000

export function adviceReviewCardState(
  batch,
  code,
  {
    alerts = [],
    adviceAt = 0,
    now = Date.now(),
  } = {},
) {
  const targetCode = String(code || '')
  if (!targetCode) return null
  const latestAdviceAt = Number(adviceAt) || 0
  const triggeredAlerts = (Array.isArray(alerts) ? alerts : [])
    .filter((alert) =>
      alert?.reviewOnly === true
      && String(alert.candCode || alert.code || '') === targetCode
      && alert.phase === 'reviewing'
      && (
        !latestAdviceAt
        || (Number(alert.triggeredAt) || 0) >= latestAdviceAt
      )
    )
  const triggeredAt = triggeredAlerts.reduce(
    (latest, alert) =>
      Math.max(latest, Number(alert.triggeredAt) || 0),
    0,
  )
  const jobs = (Array.isArray(batch?.reviews) ? batch.reviews : [])
    .filter((item) =>
      String(item?.code || '') === targetCode
      && item?.role === 'review'
      && item?.source === 'judge'
      && (
        !latestAdviceAt
        || (Number(item?.progressAt) || 0) >= latestAdviceAt
      )
      && (
        item?.triggerKind === 'price-review'
        || triggeredAlerts.length > 0
      )
    )
    .sort(
      (left, right) =>
        (Number(right?.progressAt) || 0)
        - (Number(left?.progressAt) || 0),
    )
  const job = jobs[0] || null
  const progressAt = Number(job?.progressAt) || 0
  const freshTerminal = (
    progressAt > 0
    && Number(now) - progressAt <= REVIEW_TERMINAL_VISIBLE_MS
  )
  if (!job || (triggeredAt > 0 && progressAt < triggeredAt)) {
    if (!triggeredAlerts.length) return null
    if (
      triggeredAt > 0
      && Number(now) - triggeredAt > REVIEW_QUEUE_TIMEOUT_MS
    ) {
      return {
        kind: 'failed',
        label: '自动复核未启动，请重新评估',
        detail: '触价后90秒内未创建后台任务',
      }
    }
    return {
      kind: 'queued',
      label: '条件已触发，预计1分钟内开始复核',
      detail: '云端定时任务每分钟扫描一次',
    }
  }
  if (['queued', 'pending'].includes(job.status)) {
    return {
      kind: 'queued',
      label: '条件已触发，等待后台复核',
      detail: String(job.phase || '后台任务已创建'),
    }
  }
  if (job.status === 'running') {
    return {
      kind: 'running',
      label: '条件已触发，正在自动复核',
      detail: String(job.phase || '正在核对最新行情与证据'),
    }
  }
  if (job.status === 'publishing') {
    return {
      kind: 'publishing',
      label: '复核完成，正在更新结论',
      detail: String(job.phase || '正在发布最新建议'),
    }
  }
  if (job.status === 'ok' && freshTerminal) {
    return {
      kind: 'done',
      label: '自动复核完成，结论已更新',
      detail: '请查看上方最新操作指令',
    }
  }
  if (
    job.status === 'fail'
    && (triggeredAlerts.length > 0 || freshTerminal)
  ) {
    return {
      kind: 'failed',
      label: '自动复核失败，请重新评估',
      detail: String(job.error || '后台复核未返回完整结果'),
    }
  }
  if (
    job.status === 'skipped'
    && (triggeredAlerts.length > 0 || freshTerminal)
  ) {
    return {
      kind: 'stopped',
      label: '自动复核已停止',
      detail: '可点击重新评估再次发起',
    }
  }
  return null
}

export function cloudAdviceLoadingState(batch, code) {
  const active = adviceJobState(batch, code)
    || adviceJobState(batch, code, { role: 'review' })
  if (!active) return null
  const source = active.role === 'review'
    ? batch.reviews
    : batch.items
  const item = (source || []).find(
    (entry) => String(entry?.code) === String(code),
  ) || {}
  return {
    loading: true,
    cloud: true,
    role: active.role,
    stage: String(item.stage || ''),
    phase: item.phase || active.label,
    warning: String(item.warning || ''),
    sources: Array.isArray(item.sources) ? item.sources : [],
    reasoning: String(item.reasoning || ''),
    quant: item.quant || null,
    model: String(item.model || ''),
    endpoint: String(item.endpoint || ''),
    deepMode: item.deepMode === true,
  }
}

export function mergeAdviceRefreshState(refreshState, previousState) {
  const previous = previousState && typeof previousState === 'object'
    ? previousState
    : null
  const refresh = refreshState && typeof refreshState === 'object'
    ? refreshState
    : {}
  const showingPrevious = !!(previous?.result || previous?.advice)
  return {
    ...(previous || {}),
    ...refresh,
    showingPrevious,
  }
}

export function shouldShowAdviceResult(state) {
  return !!(state && (state.result || state.advice))
}

export function createAdviceCompletionPuller(pull) {
  let deliveredFingerprint = ''
  return async function pullCompletedAdvice(progress) {
    const fingerprint = [
      ...(progress?.items || []),
      ...(progress?.reviews || []),
    ]
      .filter((item) => item?.status === 'ok' && item?.code)
      .map((item) => `${item.code}:${item.status}:${item.progressAt || 0}`)
      .sort()
      .join('|')
    if (!fingerprint || fingerprint === deliveredFingerprint) return false
    try {
      const pulled = await pull()
      if (pulled === false) return false
      deliveredFingerprint = fingerprint
      return true
    } catch {
      return false
    }
  }
}

export async function startAdvicePersistently(
  spec,
  {
    canUseServer,
    triggerServer,
    startLocal,
  },
) {
  const code = String(spec?.code || '')
  const requestId = String(
    spec?.requestId || adviceRequestId(spec),
  )
  if (
    code
    && typeof canUseServer === 'function'
    && canUseServer()
    && typeof triggerServer === 'function'
  ) {
    try {
      const submission = await triggerServer([code], {
        scope: 'all',
        force: true,
        deepMode: !!spec?.deepMode,
        requestId,
      })
      if (submission === true || submission?.ok) {
        return {
          status: 'started',
          mode: 'server',
          code,
          progress: submission?.progress || null,
        }
      }
      if (submission?.queued) {
        return {
          status: 'queued',
          mode: 'server',
          code,
          error: submission.error || '任务已排队，等待云端恢复',
        }
      }
      if (submission?.code === 'ADVISOR_CAPACITY_FULL') {
        return {
          status: 'full',
          mode: 'server',
          code,
          busy: Array.isArray(submission.busy)
            ? submission.busy
            : [],
          concurrency: Number(submission.concurrency) || 1,
          error: submission.error || '军师端点已满',
        }
      }
    } catch {
      // Fall back to the local runner only when the task was not persisted.
    }
  }
  if (typeof startLocal === 'function') startLocal(spec)
  return { status: 'started', mode: 'local', code }
}

export function newestAdviceResult(runnerResult, cachedResult, expectedMode = '') {
  if (runnerResult && expectedMode && !adviceEntryMatchesMode(runnerResult, expectedMode)) {
    runnerResult = null
  }
  if (cachedResult && expectedMode && !adviceEntryMatchesMode(cachedResult, expectedMode)) {
    cachedResult = null
  }
  if (
    runnerResult
    && !runnerResult.error
    && !runnerResult.pending
    && !isCompleteAdviceEntry(runnerResult, expectedMode)
  ) {
    runnerResult = null
  }
  if (
    cachedResult
    && !isCompleteAdviceEntry(cachedResult, expectedMode)
  ) {
    cachedResult = null
  }
  if (!runnerResult && !cachedResult) return { source: null, value: null }
  if (!runnerResult) return { source: 'cache', value: cachedResult }
  if (!cachedResult) return { source: 'runner', value: runnerResult }
  const runnerAt = Number(runnerResult.cachedAt) || 0
  const cachedAt = Number(cachedResult.at) || 0
  return cachedAt > runnerAt
    ? { source: 'cache', value: cachedResult }
    : { source: 'runner', value: runnerResult }
}
