import {
  accountTradeStateFingerprint,
} from './accountSync.js'

const ACTIVE_STATUSES = new Set(['queued', 'running'])
const LEASE_MS = 12 * 60 * 1000
const HISTORY_LIMIT = 8

function cleanText(value, maximum = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function mergeByKey(current, incoming, keyOf, limit) {
  const merged = new Map(
    (Array.isArray(current) ? current : [])
      .map((item) => [keyOf(item), item])
      .filter(([key]) => key),
  )
  for (const item of incoming || []) {
    const key = keyOf(item)
    if (key) merged.set(key, item)
  }
  return [...merged.values()].slice(-limit)
}

function jobSource(value) {
  return value === 'review' ? 'review' : 'manual'
}

function historyEntry(job, result, data, now) {
  return {
    id: String(job?.id || ''),
    source: jobSource(job?.source),
    deepMode: job?.deepMode !== false,
    createdAt: Number(job?.createdAt || 0),
    completedAt: Number(job?.finishedAt || now),
    generatedAt: Number(result?.generatedAt || now),
    fingerprint: accountTradeStateFingerprint(data),
    result,
  }
}

function archiveEntry(data, entry) {
  if (!entry?.id || !entry?.result) return null
  const history = (Array.isArray(data.portfolioAnalysisHistory)
    ? data.portfolioAnalysisHistory
    : [])
    .filter((item) => item?.id && item.id !== entry.id)
  history.push(entry)
  history.sort(
    (left, right) =>
      Number(right.generatedAt || right.completedAt || 0)
      - Number(left.generatedAt || left.completedAt || 0),
  )
  data.portfolioAnalysisHistory = history.slice(0, HISTORY_LIMIT)
  data.portfolioAnalysisLatest = entry
  return entry
}

export function ensurePortfolioAnalysisRetention(data) {
  if (!data || typeof data !== 'object') return null
  const current = data.portfolioAnalysisJob
  if (
    !data.portfolioAnalysisLatest
    && current?.status === 'done'
    && current?.result
  ) {
    archiveEntry(
      data,
      historyEntry(
        current,
        current.result,
        data,
        Number(current.finishedAt || current.updatedAt || Date.now()),
      ),
    )
  }
  if (!Array.isArray(data.portfolioAnalysisHistory)) {
    data.portfolioAnalysisHistory = data.portfolioAnalysisLatest
      ? [data.portfolioAnalysisLatest]
      : []
  }
  return data.portfolioAnalysisLatest || null
}

export function latestPortfolioAnalysis(data) {
  return ensurePortfolioAnalysisRetention(data)
}

export function listPortfolioAnalysisHistory(data) {
  ensurePortfolioAnalysisRetention(data)
  return (data.portfolioAnalysisHistory || []).map((entry) => ({
    id: String(entry.id || ''),
    source: jobSource(entry.source),
    deepMode: entry.deepMode !== false,
    generatedAt: Number(entry.generatedAt || entry.completedAt || 0),
    headline: cleanText(entry.result?.analysis?.headline, 120),
    score: Number.isFinite(
      Number(entry.result?.analysis?.positionAssessment?.score),
    )
      ? Number(entry.result.analysis.positionAssessment.score)
      : null,
  }))
}

export function findPortfolioAnalysisHistory(data, id) {
  const normalized = String(id || '').trim()
  if (!/^portfolio_\d+$/.test(normalized)) return null
  ensurePortfolioAnalysisRetention(data)
  return (data.portfolioAnalysisHistory || [])
    .find((entry) => entry?.id === normalized)
    || null
}

export function isPortfolioAnalysisJobActive(job) {
  return !!job && ACTIVE_STATUSES.has(job.status)
}

export function isPortfolioAnalysisJobOrphan(
  job,
  now = Date.now(),
) {
  return !!(
    job
    && job.status === 'running'
    && Number(job.leaseUntil || 0) < now
  )
}

export function queuePortfolioAnalysisJob(
  data,
  {
    deepMode = true,
    refresh = false,
    source = 'manual',
  } = {},
  now = Date.now(),
) {
  ensurePortfolioAnalysisRetention(data)
  const current = data?.portfolioAnalysisJob
  if (isPortfolioAnalysisJobActive(current)) {
    return { job: current, created: false }
  }
  const job = {
    id: `portfolio_${now}`,
    status: 'queued',
    deepMode: deepMode !== false,
    refresh: refresh === true,
    source: jobSource(source),
    attempts: 0,
    createdAt: now,
    startedAt: 0,
    finishedAt: 0,
    updatedAt: now,
    leaseUntil: 0,
    phaseKey: 'queued',
    phase: '已提交后台，等待云端分析',
    phases: [],
    evidence: [],
    decisions: [],
    result: null,
    error: '',
  }
  data.portfolioAnalysisJob = job
  return { job, created: true }
}

export function leasePortfolioAnalysisJob(
  data,
  jobId,
  now = Date.now(),
) {
  const job = data?.portfolioAnalysisJob
  if (!job || job.id !== jobId) return null
  if (
    job.status !== 'queued'
    && !isPortfolioAnalysisJobOrphan(job, now)
  ) return null
  job.status = 'running'
  job.attempts = Number(job.attempts || 0) + 1
  job.startedAt = job.startedAt || now
  job.updatedAt = now
  job.leaseUntil = now + LEASE_MS
  job.phaseKey = 'account'
  job.phase = '正在准备服务端账户快照'
  job.error = ''
  return job
}

export function updatePortfolioAnalysisJob(
  data,
  jobId,
  event,
  payload = {},
  now = Date.now(),
) {
  const job = data?.portfolioAnalysisJob
  if (
    !job
    || job.id !== jobId
    || job.status !== 'running'
  ) return false
  if (event === 'phase') {
    const phase = {
      key: cleanText(payload.key, 40),
      text: cleanText(payload.text, 160),
      at: now,
    }
    job.phaseKey = phase.key || job.phaseKey
    job.phase = phase.text || job.phase
    job.phases = mergeByKey(
      job.phases,
      phase.key ? [phase] : [],
      (item) => item?.key,
      16,
    )
  } else if (event === 'evidence') {
    job.evidence = mergeByKey(
      job.evidence,
      Array.isArray(payload.items) ? payload.items : [],
      (item) => item?.id,
      80,
    )
  } else if (event === 'decision') {
    job.decisions = mergeByKey(
      job.decisions,
      payload.node ? [payload.node] : [],
      (item) => item?.key || item?.title,
      40,
    )
  }
  job.updatedAt = now
  job.leaseUntil = now + LEASE_MS
  return true
}

export function completePortfolioAnalysisJob(
  data,
  jobId,
  result,
  now = Date.now(),
) {
  const job = data?.portfolioAnalysisJob
  if (
    !job
    || job.id !== jobId
    || job.status !== 'running'
  ) return false
  job.status = 'done'
  job.result = result
  job.error = ''
  job.phaseKey = 'complete'
  job.phase = '后台分析已完成'
  job.updatedAt = now
  job.finishedAt = now
  job.leaseUntil = 0
  archiveEntry(data, historyEntry(job, result, data, now))
  return true
}

export function failPortfolioAnalysisJob(
  data,
  jobId,
  error,
  now = Date.now(),
) {
  const job = data?.portfolioAnalysisJob
  if (
    !job
    || job.id !== jobId
    || !ACTIVE_STATUSES.has(job.status)
  ) return false
  job.status = 'failed'
  job.result = null
  job.error = cleanText(error || '后台分析失败', 240)
  job.phaseKey = 'failed'
  job.phase = '后台分析失败'
  job.updatedAt = now
  job.finishedAt = now
  job.leaseUntil = 0
  return true
}

export function publicPortfolioAnalysisJob(job) {
  if (!job || typeof job !== 'object') return null
  return {
    id: String(job.id || ''),
    status: String(job.status || ''),
    deepMode: job.deepMode !== false,
    refresh: job.refresh === true,
    source: jobSource(job.source),
    attempts: Number(job.attempts || 0),
    createdAt: Number(job.createdAt || 0),
    startedAt: Number(job.startedAt || 0),
    finishedAt: Number(job.finishedAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    phaseKey: cleanText(job.phaseKey, 40),
    phase: cleanText(job.phase, 160),
    phases: Array.isArray(job.phases) ? job.phases : [],
    evidence: Array.isArray(job.evidence) ? job.evidence : [],
    decisions: Array.isArray(job.decisions) ? job.decisions : [],
    result: job.result || null,
    error: cleanText(job.error, 240),
  }
}
