const ACTIVE_STATUSES = new Set([
  'pending',
  'queued',
  'running',
  'canceling',
])

export function activeAdviceCancellationTargets(items = []) {
  const targets = []
  const seen = new Set()
  for (const item of items) {
    const code = String(item?.code || '')
    const normalizedTarget = item != null
      && !Object.prototype.hasOwnProperty.call(item, 'status')
      && (
        Object.prototype.hasOwnProperty.call(item, 'jobId')
        || Object.prototype.hasOwnProperty.call(item, 'batchId')
      )
    if (
      !code
      || seen.has(code)
      || (!normalizedTarget && !ACTIVE_STATUSES.has(item?.status))
    ) {
      continue
    }
    seen.add(code)
    targets.push({
      code,
      jobId: String(item?.jobId || ''),
      batchId: String(item?.batchId || ''),
    })
  }
  return targets
}

export function beginAdviceCancellation(items = []) {
  const abortCodes = []
  const next = items.map((item) => {
    if (!ACTIVE_STATUSES.has(item?.status)) return { ...item }
    if (item.status === 'running') abortCodes.push(String(item.code || ''))
    return {
      ...item,
      cancelPreviousStatus: item.status,
      status: 'canceling',
      phase: '正在确认停止',
    }
  })
  return {
    items: next,
    abortCodes: abortCodes.filter(Boolean),
  }
}

export function settleQueuedAdviceCancellations(items = []) {
  let skipped = 0
  const next = items.map((item) => {
    if (
      item?.status !== 'canceling'
      || !['pending', 'queued'].includes(item.cancelPreviousStatus)
    ) {
      return { ...item }
    }
    skipped++
    const settled = {
      ...item,
      status: 'skipped',
      phase: '已取消生成',
    }
    delete settled.cancelPreviousStatus
    return settled
  })
  return { items: next, skipped }
}

export function completeAdviceCancellation(item) {
  if (!item || !ACTIVE_STATUSES.has(item.status)) {
    return { item: { ...(item || {}) }, changed: false }
  }
  const settled = {
    ...item,
    status: 'skipped',
    phase: '已取消生成',
  }
  delete settled.cancelPreviousStatus
  return { item: settled, changed: true }
}

export function isAdviceCancellationConfirmed(progress, targets = []) {
  if (!progress || !Array.isArray(progress.items)) return false
  const items = Array.isArray(progress?.items) ? progress.items : []
  return targets.every((target) => {
    const current = items.find(
      (item) => String(item?.code || '') === String(target?.code || ''),
    )
    if (!current) return !!String(target?.jobId || '')
    const expectedId = String(target?.jobId || '')
    const currentId = String(current?.jobId || '')
    if (expectedId && currentId && expectedId !== currentId) return true
    const expectedBatch = String(target?.batchId || '')
    const currentBatch = String(current?.batchId || '')
    if (
      !expectedId
      && expectedBatch
      && currentBatch
      && expectedBatch !== currentBatch
    ) return true
    return !ACTIVE_STATUSES.has(current.status)
  })
}

export async function confirmAdviceCancellation({
  targets = [],
  send,
  readStatus,
  attempts = 3,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs = 700,
} = {}) {
  if (!targets.length) {
    return { ok: true, confirmed: true, canceled: 0, progress: null }
  }
  let progress = null
  let error = ''
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await send(targets)
      progress = response?.progress || progress
      error = response?.ok === false
        ? String(response.error || '停止请求未受理')
        : ''
      if (isAdviceCancellationConfirmed(progress, targets)) {
        return {
          ok: true,
          confirmed: true,
          canceled: Number(response?.canceled) || targets.length,
          progress,
        }
      }
    } catch (caught) {
      error = String(caught?.message || caught || '停止请求失败')
    }

    try {
      const latest = await readStatus()
      if (latest) progress = latest
      if (isAdviceCancellationConfirmed(progress, targets)) {
        return {
          ok: true,
          confirmed: true,
          canceled: targets.length,
          progress,
        }
      }
    } catch (caught) {
      error = String(caught?.message || caught || error)
    }

    if (attempt + 1 < attempts) await delay(delayMs)
  }
  return {
    ok: false,
    confirmed: false,
    canceled: 0,
    progress,
    error: error || '停止请求未确认，请重试',
  }
}
