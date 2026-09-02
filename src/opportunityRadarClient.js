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

function sectorSessionFor(snapshot, lane) {
  if (lane === 'intraday') return 'intraday'
  if (snapshot?.phase === 'PREOPEN') return 'overnight'
  if (snapshot?.phase === 'INTRADAY') return 'intraday'
  return 'close'
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
  runTail = runTailPick,
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
  const sectorSession = sectorSessionFor(snapshot, lane)
  const lunch = snapshot?.phase === 'LUNCH'
  const rest = snapshot?.phase === 'REST'

  if (!rest && !(lunch && sectorSession === 'intraday')) {
    run('sector', () => runSector(sectorSession))
  }

  if (lane === 'intraday' && !lunch && !rest) {
    run('formulaIntraday', () => runFormula('intraday'))
  } else if (
    lane !== 'intraday'
    && snapshot?.phase === 'AFTER_CLOSE'
  ) {
    run('formulaClose', () => runFormula('close'))
  }

  if (
    lane === 'next'
    && snapshot?.tailSession?.canRun === true
    && snapshot?.sourceStatus?.tail?.status !== 'fresh'
  ) {
    run('tail', () => runTail(snapshot.tailSession.tradeDate))
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
