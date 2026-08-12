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
    job.phase = String(phase || '').slice(0, 160)
    job.progressAt = now
    changed++
  }
  return changed
}

export function failAdviceJobsForDailyReport(
  data,
  error,
  now = Date.now(),
) {
  let failed = 0
  for (const job of Object.values(data?.jobs || {})) {
    if (!job || !['queued', 'running'].includes(job.status)) continue
    job.status = 'failed'
    job.error = String(error || '策略日报生成失败').slice(0, 300)
    job.phase = '策略日报生成失败，军师任务未启动'
    job.finishedAt = now
    job.leaseUntil = 0
    job.progressAt = now
    failed++
  }
  return failed
}
