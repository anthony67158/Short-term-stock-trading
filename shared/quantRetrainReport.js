function timestamp(value) {
  const time = new Date(value || 0).getTime()
  return Number.isFinite(time) && time > 0 ? time : null
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function safeRunUrl(value) {
  const text = String(value || '')
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/i.test(text)
    ? text
    : ''
}

export function normalizeRetrainRun(run, now = Date.now()) {
  if (!run || typeof run !== 'object') return null
  const startedAt = timestamp(run.run_started_at || run.created_at)
  const completedAt = run.status === 'completed'
    ? timestamp(run.updated_at)
    : null
  const updatedAt = timestamp(run.updated_at) || startedAt
  const endAt = completedAt || (
    Number.isFinite(Number(now)) ? Number(now) : Date.now()
  )
  const status = String(run.status || 'unknown')
  const conclusion = run.conclusion == null
    ? null
    : String(run.conclusion)
  let state = 'unknown'
  if (status === 'queued' || status === 'requested' || status === 'waiting') {
    state = 'queued'
  } else if (status === 'in_progress' || status === 'pending') {
    state = 'running'
  } else if (status === 'completed' && conclusion === 'success') {
    state = 'success'
  } else if (status === 'completed' && conclusion === 'cancelled') {
    state = 'cancelled'
  } else if (status === 'completed') {
    state = 'failed'
  }
  return {
    runId: positiveInteger(run.id),
    runNumber: positiveInteger(run.run_number),
    state,
    status,
    conclusion,
    event: String(run.event || ''),
    startedAt,
    completedAt,
    updatedAt,
    durationSec: startedAt && endAt >= startedAt
      ? Math.max(0, Math.round((endAt - startedAt) / 1000))
      : null,
    url: safeRunUrl(run.html_url),
    headSha: String(run.head_sha || '').slice(0, 12),
  }
}

function legacySignature(report) {
  return [
    String(report?.decision || ''),
    String(report?.title || ''),
    String(report?.body || ''),
  ].join('\n')
}

export function dedupeQuantReports(reports = []) {
  const sorted = (Array.isArray(reports) ? reports : [])
    .filter((item) => item && typeof item === 'object')
    .slice()
    .sort((left, right) => Number(right.at || 0) - Number(left.at || 0))
  const seen = new Set()
  return sorted.filter((report) => {
    const runId = positiveInteger(report?.meta?.runId)
    const key = runId ? `run:${runId}` : `legacy:${legacySignature(report)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
