const VOLATILE_ITEM_FIELDS = new Set([
  'qScore',
  'qBias',
  'qAt',
  'alertSyncedPrice',
])

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  const next = {}
  for (const key of Object.keys(value).sort()) {
    if (key === 'updatedAt' || VOLATILE_ITEM_FIELDS.has(key)) continue
    next[key] = canonical(value[key])
  }
  return next
}

function tradeState(data = {}) {
  return canonical({
    plan: data.plan || [],
    holding: data.holding || [],
    closed: data.closed || [],
    account: data.account || null,
  })
}

export function sameAccountTradeState(left, right) {
  return JSON.stringify(tradeState(left)) === JSON.stringify(tradeState(right))
}

export function accountTradeStateFingerprint(data) {
  const value = JSON.stringify(tradeState(data))
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

export function accountSnapshotForRestore(cloudData, pendingOutbox) {
  const pendingData = pendingOutbox?.data
  return pendingData && typeof pendingData === 'object'
    ? pendingData
    : cloudData
}

export async function saveWithRevisionRecovery({
  payload,
  save,
  getLatest,
  onRevision = () => {},
} = {}) {
  let response = await save(payload)
  if (response?.ok || response?.code !== 'ACCOUNT_VERSION_CONFLICT') {
    return response
  }

  let latest = null
  try {
    latest = await getLatest()
  } catch {
    latest = null
  }
  if (!latest?.ok || !Number.isInteger(Number(latest.revision))) {
    return {
      ...response,
      retryable: true,
      error: '云端版本已更新，自动对齐失败，稍后继续重试',
    }
  }
  const baseFingerprint = String(payload?.baseTradeFingerprint || '')
  const remoteMatchesBase = !!baseFingerprint
    && accountTradeStateFingerprint(latest.data) === baseFingerprint
  if (
    !remoteMatchesBase
    && !sameAccountTradeState(payload?.data, latest.data)
  ) {
    return {
      ...response,
      code: 'TRADE_STATE_CONFLICT',
      retryable: false,
      conflict: true,
      error: '检测到其他设备也修改了交易账本，为防止覆盖已暂停同步',
    }
  }

  const revision = Number(latest.revision)
  onRevision(revision)
  response = await save({
    ...payload,
    baseRevision: revision,
  })
  return response
}

export function createCloudSaveQueue({
  save,
  onState = () => {},
  retryBaseMs = 2000,
  retryMaxMs = 60000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof save !== 'function') throw new TypeError('save must be a function')

  let pending = null
  let running = null
  let retryTimer = null
  let retryDelay = retryBaseMs
  let epoch = 0

  const notify = (value) => {
    try { onState(value) } catch { /* 状态通知不能阻断账号保存 */ }
  }

  const scheduleRetry = () => {
    if (retryTimer) return
    const delay = retryDelay
    retryDelay = Math.min(retryMaxMs, retryDelay * 2)
    retryTimer = setTimer(() => {
      retryTimer = null
      return drain()
    }, delay)
  }

  async function drain() {
    if (running) return running
    if (!pending) return true
    if (retryTimer) {
      clearTimer(retryTimer)
      retryTimer = null
    }

    running = (async () => {
      while (pending) {
        const item = pending
        pending = null
        notify({ status: 'saving', error: '' })
        try {
          const response = await save(item.payload)
          if (item.epoch !== epoch) continue
          if (!response || response.ok !== true || response.storage !== 'oss') {
            const error = new Error(response?.error || '账号数据未确认写入 OSS')
            error.retryable = response?.retryable !== false
            error.code = response?.code || ''
            error.conflict = !!response?.conflict
            throw error
          }
          retryDelay = retryBaseMs
          if (!pending) notify({ status: 'synced', error: '', updatedAt: response.updatedAt || Date.now() })
        } catch (error) {
          if (item.epoch !== epoch) continue
          const retryable = error?.retryable !== false
          if (retryable && !pending) pending = item
          notify({
            status: retryable
              ? 'error'
              : (error?.conflict || error?.code === 'TRADE_STATE_CONFLICT')
                ? 'conflict'
                : 'error',
            error: String(error?.message || error || '账号数据保存失败').slice(0, 160),
          })
          if (retryable) scheduleRetry()
          return false
        }
      }
      return true
    })()

    try {
      return await running
    } finally {
      running = null
      if (pending && !retryTimer) void drain()
    }
  }

  return {
    enqueue(payload) {
      pending = { payload, epoch }
      if (retryTimer) {
        clearTimer(retryTimer)
        retryTimer = null
      }
      return drain()
    },
    retry() {
      if (retryTimer) {
        clearTimer(retryTimer)
        retryTimer = null
      }
      return drain()
    },
    reset() {
      epoch += 1
      pending = null
      if (retryTimer) clearTimer(retryTimer)
      retryTimer = null
      retryDelay = retryBaseMs
    },
  }
}
