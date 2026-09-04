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
  load = loadOpportunityRadar,
} = {}) {
  const tasks = []
  const run = (source, action) => {
    onSourceState(source, 'running')
    tasks.push(
      Promise.resolve()
        .then(action)
        .then((value) => {
          onSourceState(source, 'done')
          return { source, value }
        })
        .catch((error) => {
          const failure = new Error(opportunityRadarClientError(error))
          failure.source = source
          failure.cause = error
          onSourceState(source, 'failed', failure.message)
          throw failure
        }),
    )
  }
  if (lane === 'intraday' && snapshot?.phase === 'INTRADAY') {
    run('sector', () => runSector('intraday'))
    run('formulaIntraday', () => runFormula('intraday'))
    run('preCatalyst', () => runPreCatalystScan({ force: true }))
  } else if (lane === 'next' && snapshot?.phase === 'AFTER_CLOSE') {
    run('sector', () => runSector('close'))
    run('formulaClose', () => runFormula('close'))
    run('preCatalyst', () => runPreCatalystScan({ force: true }))
  }

  if (!tasks.length) {
    return {
      completed: [],
      failed: [],
      snapshot: await load(),
    }
  }
  const settled = await Promise.allSettled(tasks)
  const latest = await load()
  return {
    completed: settled
      .filter((item) => item.status === 'fulfilled')
      .map((item) => item.value.source),
    failed: settled
      .filter((item) => item.status === 'rejected')
      .map((item) => item.reason?.source || 'unknown'),
    snapshot: latest,
  }
}

export async function refreshTailOpportunity({
  snapshot,
  onSourceState = () => {},
  runTail = runTailPick,
  load = loadOpportunityRadar,
} = {}) {
  const session = snapshot?.tailSession || {}
  if (!session.canRun || !session.tradeDate) {
    throw new Error('当前无法运行尾盘公式')
  }
  onSourceState('tail', 'running', '正在提交尾盘扫描')
  try {
    await runTail(session.tradeDate)
    const latest = await load()
    onSourceState('tail', 'done')
    return latest
  } catch (error) {
    const failure = new Error(opportunityRadarClientError(error))
    failure.source = 'tail'
    failure.cause = error
    onSourceState('tail', 'failed', failure.message)
    throw failure
  }
}
