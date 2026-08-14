import { adviceEntryMatchesMode } from './adviceModeContext.js'

export function shouldApplyCloudBatch(progress) {
  return !!(
    progress &&
    typeof progress === 'object' &&
    Number(progress.total) > 0 &&
    Array.isArray(progress.items) &&
    progress.items.length > 0
  )
}

export function adviceJobState(batch, code) {
  if (!batch || !code) return null
  const item = (batch.items || []).find((entry) => String(entry?.code) === String(code))
  if (!item || !['queued', 'pending', 'running', 'canceling'].includes(item.status)) return null
  const running = item.status === 'running'
  const canceling = item.status === 'canceling'
  return {
    active: true,
    status: item.status,
    label: canceling ? '正在取消生成' : (item.phase || (running ? 'AI 操作建议生成中' : '排队等待云端生成')),
    cancelable: !canceling,
    cloud: !!batch.serverMode,
  }
}

export function cloudAdviceLoadingState(batch, code) {
  const active = adviceJobState(batch, code)
  if (!active) return null
  const item = (batch.items || []).find(
    (entry) => String(entry?.code) === String(code),
  ) || {}
  return {
    loading: true,
    cloud: true,
    phase: item.phase || active.label,
    sources: Array.isArray(item.sources) ? item.sources : [],
    reasoning: String(item.reasoning || ''),
    quant: item.quant || null,
    model: String(item.model || ''),
    endpoint: String(item.endpoint || ''),
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
    const fingerprint = (progress?.items || [])
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
      })
      if (submission === true || submission?.ok) {
        return { status: 'started', mode: 'server', code }
      }
      if (submission?.queued) {
        return {
          status: 'queued',
          mode: 'server',
          code,
          error: submission.error || '任务已排队，等待云端恢复',
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
  if (!runnerResult && !cachedResult) return { source: null, value: null }
  if (!runnerResult) return { source: 'cache', value: cachedResult }
  if (!cachedResult) return { source: 'runner', value: runnerResult }
  const runnerAt = Number(runnerResult.cachedAt) || 0
  const cachedAt = Number(cachedResult.at) || 0
  return cachedAt > runnerAt
    ? { source: 'cache', value: cachedResult }
    : { source: 'runner', value: runnerResult }
}
