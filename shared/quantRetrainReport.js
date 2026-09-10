function timestamp(value) {
  const time = new Date(value || 0).getTime()
  return Number.isFinite(time) && time > 0 ? time : null
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export function safeRunUrl(value) {
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

export const QUANT_REPORT_MODELS = Object.freeze({
  opportunity: 'V3 机会模型',
  stock: '个股模型',
  sector: '板块模型',
})

export function quantReportModel(report) {
  const model = report?.model || report?.meta?.model
  return Object.hasOwn(QUANT_REPORT_MODELS, model) ? model : 'stock'
}

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export function formatQuantMetric(value, unit = 'number') {
  const numeric = finite(value)
  if (numeric == null) return '未提供'
  if (unit === 'percent') return `${(numeric * 100).toFixed(2)}%`
  if (unit === 'r') return `${numeric.toFixed(3)} R`
  return numeric.toFixed(4)
}

export function opportunityReportSnapshot(value) {
  if (!value || !timestamp(value.generatedAt)) return null
  const rawTime = finite(value.trainingGeneratedAt)
  const at = rawTime > 0
    ? timestamp(rawTime < 100_000_000_000 ? rawTime * 1000 : rawTime)
    : timestamp(value.generatedAt)
  const labels = {
    NOT_READY: '等待成熟样本',
    REJECTED: '未通过验证',
    SHADOW_READY: '通过影子验证',
    PRODUCTION_READY: '生产模型已就绪',
  }
  const readiness = value.readiness || {}
  return {
    at,
    label: labels[value.state] || '状态待核对',
    productionEligible: value.productionEligible === true,
    samples: finite(readiness.samples),
    filledSamples: finite(readiness.filledSamples ?? readiness.filled_samples),
    dates: finite(readiness.dates),
    blockers: [...new Set([
      ...(Array.isArray(readiness.blockers) ? readiness.blockers : []),
      ...(Array.isArray(value.promotionBlockers) ? value.promotionBlockers : []),
    ])].map((item) => String(item).slice(0, 180)).slice(0, 8),
  }
}

export function dedupeQuantReports(reports = []) {
  const sorted = (Array.isArray(reports) ? reports : [])
    .filter((item) => item && typeof item === 'object')
    .slice()
    .sort((left, right) => Number(right.at || 0) - Number(left.at || 0))
  const seen = new Set()
  return sorted.filter((report) => {
    const runId = positiveInteger(report?.meta?.runId)
    const model = quantReportModel(report)
    const key = runId ? `${model}:run:${runId}` : `${model}:legacy:${legacySignature(report)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
