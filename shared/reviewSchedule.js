const DEFAULT_LEASE_MS = 12 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 3
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function reviewRunKey(dayKey, session) {
  return `${String(dayKey || '')}:${String(session || '')}`
}

export function mergeReviewsByTimestamp(primary = {}, secondary = {}) {
  const merged = { ...(primary || {}) }
  for (const [code, review] of Object.entries(secondary || {})) {
    if (!review) continue
    const current = merged[code]
    if (!current || Number(review.at || 0) > Number(current.at || 0)) {
      merged[code] = review
    }
  }
  return merged
}

export function reviewsAfter(reviews = {}, since = 0) {
  const after = Number(since) || 0
  return Object.fromEntries(
    Object.entries(reviews || {}).filter(([, review]) =>
      Number(review?.at || 0) > after
    ),
  )
}

export function mergeReviewAutoState(primary = {}, secondary = {}) {
  const merged = structuredClone(primary && typeof primary === 'object' ? primary : {})
  if (!merged.runs || typeof merged.runs !== 'object') merged.runs = {}
  for (const [key, incomingRun] of Object.entries(secondary?.runs || {})) {
    const currentRun = merged.runs[key] || {}
    const codes = { ...(currentRun.codes || {}) }
    for (const [code, incoming] of Object.entries(incomingRun?.codes || {})) {
      const current = codes[code]
      const stamp = (value) => Math.max(
        Number(value?.completedAt || 0),
        Number(value?.failedAt || 0),
        Number(value?.claimedAt || 0),
      )
      if (!current || stamp(incoming) >= stamp(current)) codes[code] = incoming
    }
    merged.runs[key] = {
      ...currentRun,
      ...incomingRun,
      codes,
      updatedAt: Math.max(
        Number(currentRun.updatedAt || 0),
        Number(incomingRun?.updatedAt || 0),
      ),
    }
  }
  return merged
}

function reviewAutoOf(data) {
  if (!data.reviewAuto || typeof data.reviewAuto !== 'object') {
    data.reviewAuto = { runs: {} }
  }
  if (!data.reviewAuto.runs || typeof data.reviewAuto.runs !== 'object') {
    data.reviewAuto.runs = {}
  }
  return data.reviewAuto
}

function cleanupRuns(auto, now) {
  for (const [key, run] of Object.entries(auto.runs)) {
    if (now - Number(run?.updatedAt || run?.createdAt || 0) > RUN_RETENTION_MS) {
      delete auto.runs[key]
    }
  }
}

function runOf(data, dayKey, session, now) {
  const auto = reviewAutoOf(data)
  cleanupRuns(auto, now)
  const key = reviewRunKey(dayKey, session)
  if (!auto.runs[key] || typeof auto.runs[key] !== 'object') {
    auto.runs[key] = {
      dayKey,
      session,
      createdAt: now,
      updatedAt: now,
      codes: {},
    }
  }
  const run = auto.runs[key]
  if (!run.codes || typeof run.codes !== 'object') run.codes = {}
  return run
}

export function claimReviewCodes(data, {
  dayKey,
  session,
  now = Date.now(),
  limit = 2,
  leaseMs = DEFAULT_LEASE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  if (!dayKey || !['noon', 'close'].includes(session)) return []
  const run = runOf(data, dayKey, session, now)
  const holdings = Array.isArray(data.holding) ? data.holding : []
  const unique = new Map()
  for (const holding of holdings) {
    const code = String(holding?.code || '').trim()
    if (code && !unique.has(code)) unique.set(code, holding)
  }

  const claimed = []
  for (const [code, holding] of unique) {
    if (claimed.length >= Math.max(1, Number(limit) || 1)) break
    const current = run.codes[code]
    if (current?.status === 'done') continue
    if (current?.status === 'running' && Number(current.leaseUntil) > now) continue
    if (Number(current?.attempts || 0) >= maxAttempts) continue
    const state = {
      ...(current || {}),
      status: 'running',
      attempts: Number(current?.attempts || 0) + 1,
      claimedAt: now,
      leaseUntil: now + leaseMs,
      error: '',
    }
    run.codes[code] = state
    claimed.push({
      code,
      name: holding?.name || code,
      attempt: state.attempts,
    })
  }
  run.updatedAt = now
  return claimed
}

export function completeReviewClaim(data, {
  dayKey,
  session,
  code,
  review,
  now = Date.now(),
} = {}) {
  if (!code || !review) return false
  const run = runOf(data, dayKey, session, now)
  const current = run.codes[code] || {}
  run.codes[code] = {
    ...current,
    status: 'done',
    leaseUntil: 0,
    completedAt: now,
    error: '',
  }
  run.updatedAt = now
  data.reviews = data.reviews && typeof data.reviews === 'object'
    ? data.reviews
    : {}
  const normalized = {
    ...review,
    code,
    session,
    dayKey,
    at: Number(review.at) || now,
  }
  const existing = data.reviews[code]
  if (!existing || normalized.at >= Number(existing.at || 0)) {
    data.reviews[code] = normalized
  }
  return true
}

export function failReviewClaim(data, {
  dayKey,
  session,
  code,
  error,
  now = Date.now(),
} = {}) {
  if (!code) return false
  const run = runOf(data, dayKey, session, now)
  const current = run.codes[code]
  if (!current || current.status === 'done') return false
  run.codes[code] = {
    ...current,
    status: 'failed',
    leaseUntil: 0,
    failedAt: now,
    error: String(error || '复盘生成失败').slice(0, 160),
  }
  run.updatedAt = now
  return true
}
