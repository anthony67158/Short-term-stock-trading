import { createAdviceDailyReportGate } from '../shared/adviceDailyReportPolicy.js'

function autoSession(now = Date.now()) {
  const date = new Date(Number(now) + 8 * 3600 * 1000)
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  if (minutes < 690) return 'morning'
  if (minutes < 900) return 'noon'
  return 'evening'
}

function uniqueHoldings(holdings) {
  const seen = new Set()
  return (holdings || []).filter((holding) => {
    const code = String(holding?.code || '')
    if (!code || seen.has(code)) return false
    seen.add(code)
    return true
  }).map((holding) => ({
    code: String(holding.code),
    name: holding.name || holding.code,
  }))
}

export function createLocalAdviceDailyReportGate({
  fetchReport = null,
  now = () => Date.now(),
} = {}) {
  const gate = createAdviceDailyReportGate({ now })
  return async function ensureLocalAdviceDailyReport({
    holdings = [],
    existingSummary = null,
    onPhase,
    signal,
  } = {}) {
    return gate.ensure({
      existingSummary,
      getSummary: async () => null,
      generate: async () => {
        const fetcher = fetchReport
          || (await import('./ai.js')).fetchDailyReport
        return fetcher({
          session: autoSession(now()),
          holdings: uniqueHoldings(holdings),
          refresh: false,
          signal,
          onPhase: (phase) => {
            if (typeof onPhase === 'function') {
              onPhase(phase?.text || '正在生成策略日报')
            }
          },
        })
      },
    })
  }
}

export const ensureLocalAdviceDailyReport =
  createLocalAdviceDailyReportGate()
