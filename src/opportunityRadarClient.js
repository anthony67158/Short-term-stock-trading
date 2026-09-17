import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'
import {
  runFormulaSelection,
} from './formulaSelectionClient.js'
import {
  sectorForecastRequest,
} from './sectorForecastClient.js'
import {
  runTailPick,
} from './tailPickClient.js'
import {
  runPreCatalyst,
} from './preCatalystClient.js'

const READ_TIMEOUT_MS = 30_000

export function opportunityRadarClientError(error = {}) {
  const status = Number(error?.status) || 0
  const detail = String(error?.message || error || '')
  if (
    status >= 500
    || /HTTP\s*\d{3}|fetch failed|network|timeout|aborted|超时/i
      .test(detail)
  ) return '机会数据暂时不可用，请稍后重试'
  return detail || '机会雷达暂时不可用'
}

async function request(path, timeoutMs = READ_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(api(path), {
      signal: controller.signal,
      cache: 'no-store',
      headers: accountRequestHeaders(),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      const failure = new Error(
        payload?.error || `机会雷达服务异常(${response.status})`,
      )
      failure.status = response.status
      throw failure
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('机会雷达请求超时')
    }
    const failure = new Error(opportunityRadarClientError(error))
    failure.status = error?.status || 0
    throw failure
  } finally {
    clearTimeout(timeout)
  }
}

export function loadOpportunityRadar() {
  return request('/api/opportunity_radar')
}

// 旧候选池 Agent 已下线，选股改由 /api/stock_pick 承载。保留占位以兼容旧雷达调用。
export function runOpportunityAgentSelection() {
  return Promise.resolve({
    snapshot: {
      availability: 'UNAVAILABLE',
      reasonCode: 'AGENT_RETIRED',
      reason: '候选池Agent已下线，请使用选股模块',
    },
  })
}

export function invalidateOpportunityAgentSelection() {
  return Promise.resolve({ ok: true })
}

function activeSourceResult(value) {
  return value?.running === true
    || ['active-generation', 'already-running'].includes(value?.reason)
    || ['RUNNING', 'QUEUED'].includes(
      value?.task?.active?.status || value?.task?.status,
    )
}

function sourceFinished(snapshot, source) {
  const status = snapshot?.sourceStatus?.[source]?.status
  const task = snapshot?.tasks?.[source]
  const taskStatus =
    task?.active?.status
    || task?.latest?.status
    || task?.status
  const normalizedTaskStatus = String(taskStatus || '').toUpperCase()
  if (
    normalizedTaskStatus === 'FAILED'
    || ['failed', 'stale'].includes(status)
  ) {
    const failure = new Error(`${source}更新失败`)
    failure.source = source
    throw failure
  }
  return status === 'fresh'
    && !['RUNNING', 'QUEUED'].includes(normalizedTaskStatus)
}

export async function waitForOpportunitySources({
  sources,
  load = loadOpportunityRadar,
  timeoutMs = 120_000,
  pollMs = 1_000,
  now = Date.now,
  wait = (delayMs) => new Promise((resolve) =>
    setTimeout(resolve, delayMs)
  ),
} = {}) {
  const pending = [...new Set(sources || [])]
  const deadline = Number(now()) + timeoutMs
  let latest = null
  while (Number(now()) < deadline) {
    latest = await load()
    if (pending.every((source) => sourceFinished(latest, source))) {
      return latest
    }
    await wait(pollMs)
  }
  const failure = new Error('候选来源任务等待超时')
  failure.source = pending.join(',')
  throw failure
}

export function opportunityRadarAutoRefreshDelay(
  snapshot,
  now = Date.now(),
  { refreshing = false } = {},
) {
  if (refreshing) return 2_500
  const tasks = Object.values(snapshot?.tasks || {})
  if (tasks.some((task) =>
    ['running', 'RUNNING', 'QUEUED'].includes(
      task?.active?.status || task?.status,
    )
  )) return 2_500
  const sources = Object.values(snapshot?.sourceStatus || {})
  const activeDelays = sources
    .filter((source) =>
      ['running', 'pending'].includes(source?.status)
    )
    .map((source) => Number(source.refreshAfterMs) || 10_000)
  if (activeDelays.length) {
    return Math.max(1_000, Math.min(...activeDelays))
  }
  const scheduled = sources
    .map((source) => Number(source?.refreshAt))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now)
  if (!scheduled.length) return null
  return Math.max(1_000, Math.min(...scheduled) - now)
}

export function opportunityRadarHasStaleModelSource(
  snapshot,
  lane = snapshot?.defaultLane || 'intraday',
) {
  const sources = lane === 'next'
    ? ['formulaClose', 'preCatalyst']
    : ['formulaIntraday', 'preCatalyst', 'tail']
  return sources.some((source) => {
    const state = snapshot?.sourceStatus?.[source]
    return state?.status === 'stale'
      && /上一模型版本|旧评分口径/.test(
        String(state?.error || ''),
      )
  })
}

export function opportunityRadarLaneSummary(rows = []) {
  const normalized = Array.isArray(rows) ? rows : []
  const actionable = normalized.filter(
    (item) => item?.state !== 'AVOID',
  )
  const expectedValues = normalized
    .map((item) => Number(item?.adaptive?.estimate?.expectedNetR))
    .filter(Number.isFinite)
  return {
    total: normalized.length,
    actionable: actionable.length,
    rejected: normalized.length - actionable.length,
    bestExpectedNetR: expectedValues.length
      ? Math.max(...expectedValues)
      : null,
  }
}

function staleModelSources(
  snapshot,
  lane = snapshot?.defaultLane || 'intraday',
) {
  const sources = lane === 'next'
    ? ['formulaClose', 'preCatalyst']
    : ['formulaIntraday', 'preCatalyst', 'tail']
  return sources.filter((source) => {
    const state = snapshot?.sourceStatus?.[source]
    return state?.status === 'stale'
      && /上一模型版本|旧评分口径/.test(
        String(state?.error || ''),
      )
  })
}

export async function refreshOpportunityRadar({
  lane,
  snapshot,
  onSourceState = () => {},
  runSector = (session) => sectorForecastRequest({
    action: 'generate',
    method: 'POST',
    body: { session },
    timeoutMs: 300_000,
  }),
  runFormula = runFormulaSelection,
  runPreCatalystScan = runPreCatalyst,
  runAgentSelection = runOpportunityAgentSelection,
  invalidateAgentSelection = invalidateOpportunityAgentSelection,
  waitForSources = waitForOpportunitySources,
  load = loadOpportunityRadar,
} = {}) {
  const actions = []
  const queue = (source, action) => {
    actions.push({ source, action })
  }
  const run = ({ source, action }) => {
    onSourceState(source, 'running')
    return Promise.resolve()
      .then(action)
      .then((value) => {
        onSourceState(
          source,
          activeSourceResult(value) ? 'running' : 'done',
          activeSourceResult(value) ? '云端任务处理中' : '',
        )
        return { source, value }
      })
      .catch((error) => {
        const failure = new Error(opportunityRadarClientError(error))
        failure.source = source
        failure.cause = error
        onSourceState(source, 'failed', failure.message)
        throw failure
      })
  }
  if (lane === 'intraday' && snapshot?.phase === 'INTRADAY') {
    queue('sector', () => runSector('intraday'))
    queue('formulaIntraday', () => runFormula('intraday'))
    queue('preCatalyst', () => runPreCatalystScan({ force: true }))
  } else if (lane === 'next' && snapshot?.phase === 'AFTER_CLOSE') {
    queue('sector', () => runSector('close'))
    queue('formulaClose', () => runFormula('close'))
    queue('preCatalyst', () => runPreCatalystScan({ force: true }))
  } else if (lane === 'next' && snapshot?.phase === 'PREOPEN') {
    const staleSources = staleModelSources(snapshot, lane)
    if (staleSources.includes('formulaClose')) {
      queue('formulaClose', () => runFormula('close'))
    }
    if (staleSources.includes('preCatalyst')) {
      queue('preCatalyst', () => runPreCatalystScan({ force: true }))
    }
  }

  if (!actions.length) {
    return {
      completed: [],
      failed: [],
      snapshot: await load(),
    }
  }
  await invalidateAgentSelection(lane)
  const tasks = actions.map(run)
  const settled = await Promise.allSettled(tasks)
  const completed = settled
    .filter((item) => item.status === 'fulfilled')
    .map((item) => item.value.source)
  const failed = settled
    .filter((item) => item.status === 'rejected')
    .map((item) => item.reason?.source || 'unknown')
  const agentSource = lane === 'next'
    ? 'agentNext'
    : 'agentIntraday'
  if (!failed.length) {
    try {
      const activeSources = settled
        .filter((item) =>
          item.status === 'fulfilled'
          && activeSourceResult(item.value.value)
        )
        .map((item) => item.value.source)
      if (activeSources.length) {
        await waitForSources({
          sources: activeSources,
          load,
        })
        activeSources.forEach((source) =>
          onSourceState(source, 'done')
        )
      }
      onSourceState(agentSource, 'running')
      await runAgentSelection(lane)
      completed.push(agentSource)
      onSourceState(agentSource, 'done')
    } catch (error) {
      const failedSource = error?.source || agentSource
      failed.push(failedSource)
      onSourceState(
        failedSource,
        'failed',
        opportunityRadarClientError(error),
      )
    }
  }
  const latest = await load()
  return {
    completed,
    failed,
    snapshot: latest,
  }
}

export async function refreshTailOpportunity({
  snapshot,
  onSourceState = () => {},
  runTail = runTailPick,
  runAgentSelection = runOpportunityAgentSelection,
  invalidateAgentSelection = invalidateOpportunityAgentSelection,
  waitForSources = waitForOpportunitySources,
  load = loadOpportunityRadar,
} = {}) {
  const session = snapshot?.tailSession || {}
  if (!session.canRun || !session.tradeDate) {
    throw new Error('当前无法运行尾盘公式')
  }
  onSourceState('tail', 'running', '正在提交尾盘扫描')
  let activeSource = 'tail'
  try {
    await invalidateAgentSelection('intraday')
    const tailResult = await runTail(session.tradeDate)
    if (activeSourceResult(tailResult)) {
      await waitForSources({
        sources: ['tail'],
        load,
      })
    }
    activeSource = 'agentIntraday'
    onSourceState('agentIntraday', 'running')
    await runAgentSelection('intraday')
    onSourceState('agentIntraday', 'done')
    const latest = await load()
    onSourceState('tail', 'done')
    return latest
  } catch (error) {
    const failure = new Error(opportunityRadarClientError(error))
    failure.source = activeSource
    failure.cause = error
    onSourceState(activeSource, 'failed', failure.message)
    throw failure
  }
}
