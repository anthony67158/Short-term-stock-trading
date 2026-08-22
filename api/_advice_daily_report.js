import { buildDailySummary } from './_daily_summary.js'
import { createAdviceDailyReportGate } from '../shared/adviceDailyReportPolicy.js'

const gates = new Map()

function gateFor(scopeKey) {
  const key = String(scopeKey || 'global')
  let gate = gates.get(key)
  if (!gate) {
    gate = createAdviceDailyReportGate({
      summarize: buildDailySummary,
    })
    gates.set(key, gate)
  }
  return gate
}

export function collectAdviceDailyReportHoldings(data) {
  const seen = new Set()
  const holdings = []
  for (const holding of data?.holding || []) {
    const code = String(holding?.code || '').trim()
    if (!code || seen.has(code)) continue
    seen.add(code)
    holdings.push({
      code,
      name: String(holding?.name || code).trim() || code,
    })
    if (holdings.length >= 20) break
  }
  return holdings
}

export function ensureAdviceDailyReport(options) {
  const { scopeKey, ...gateOptions } = options || {}
  return gateFor(scopeKey).ensure(gateOptions)
}

export function setAdviceDailyReportPhase(
  data,
  phase,
  now = Date.now(),
) {
  let changed = 0
  for (const job of Object.values(data?.jobs || {})) {
    if (!job || !['queued', 'running'].includes(job.status)) continue
    job.stage = 'preparing'
    job.phase = String(phase || '').slice(0, 160)
    job.progressAt = now
    changed++
  }
  return changed
}

export function continueAdviceJobsWithoutDailyReport(
  data,
  error,
  now = Date.now(),
) {
  let continued = 0
  for (const job of Object.values(data?.jobs || {})) {
    if (!job || !['queued', 'running'].includes(job.status)) continue
    job.error = ''
    job.dailyReportWarning = String(
      error || '策略日报暂不可用',
    ).slice(0, 300)
    job.stage = 'collect'
    job.phase = '策略日报不可用，继续生成个股建议'
    job.progressAt = now
    continued++
  }
  return continued
}
