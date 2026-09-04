const VOLATILE_ITEM_FIELDS = new Set([
  'qScore',
  'qBias',
  'qAt',
  'alertSyncedPrice',
  'reviewSyncedPrice',
  'reviewSyncedPrices',
])

const ADVICE_VOLATILE_FIELDS = new Set([
  ...VOLATILE_ITEM_FIELDS,
  'name',
  'concept',
  'industry',
  'star',
  'alertMuted',
  'muteAdd',
  'muteReduce',
  'muteSl',
  'muteTp',
  'cashUpdatedAt',
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

function canonicalAdviceState(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalAdviceState)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
  }
  if (!value || typeof value !== 'object') return value
  const next = {}
  for (const key of Object.keys(value).sort()) {
    if (key === 'updatedAt' || ADVICE_VOLATILE_FIELDS.has(key)) {
      continue
    }
    next[key] = canonicalAdviceState(value[key])
  }
  return next
}

function comparableClosed(records) {
  return (records || []).map((record) => {
    // 旧版跨端自动结算只随机化这两个标识，经济结果一致时不应制造交易冲突。
    const automatedTSettlement = !!record?.holdingId && (
      String(record?.note || '').startsWith('做T净')
      || (record?.type === 'T' && record?.kind === 'T')
    )
    if (!automatedTSettlement) return record
    const economicRecord = { ...record }
    delete economicRecord.id
    delete economicRecord.batchId
    return economicRecord
  })
}

function legacyTradeState(data = {}) {
  return canonical({
    plan: data.plan || [],
    holding: data.holding || [],
    closed: data.closed || [],
    account: data.account || null,
  })
}

function tradeState(data = {}) {
  return canonical({
    plan: data.plan || [],
    holding: data.holding || [],
    closed: comparableClosed(data.closed),
    account: data.account || null,
  })
}

export function sameAccountTradeState(left, right) {
  return JSON.stringify(tradeState(left)) === JSON.stringify(tradeState(right))
}

function fingerprint(value) {
  const serialized = JSON.stringify(value)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < serialized.length; index++) {
    const code = serialized.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

export function accountTradeStateFingerprint(data) {
  return fingerprint(tradeState(data))
}

export function adviceGenerationStateFingerprint(data = {}) {
  return fingerprint(canonicalAdviceState({
    plan: data.plan || [],
    holding: data.holding || [],
    closed: comparableClosed(data.closed),
    account: data.account || null,
    executionPlans: data.executionPlans || [],
    quantModelVersion:
      data.settings?.quantModelVersion || 'default',
  }))
}

function legacyAccountTradeStateFingerprint(data) {
  return fingerprint(legacyTradeState(data))
}

export function pendingOutboxAfterReset(cloudData, pendingOutbox) {
  if (!pendingOutbox?.data || typeof pendingOutbox.data !== 'object') {
    return null
  }
  const resetAt = Number(cloudData?.tradeStateResetAt) || 0
  if (resetAt > 0 && (Number(pendingOutbox.at) || 0) <= resetAt) {
    return null
  }
  const baseFingerprint = String(
    pendingOutbox.baseTradeFingerprint || '',
  )
  const cloudMatchesBase = !!baseFingerprint && (
    accountTradeStateFingerprint(cloudData) === baseFingerprint
    || legacyAccountTradeStateFingerprint(cloudData)
      === baseFingerprint
  )
  if (
    !cloudMatchesBase
    && !sameAccountTradeState(pendingOutbox.data, cloudData)
  ) {
    return null
  }
  return pendingOutbox
}

export function accountSnapshotForRestore(cloudData, pendingOutbox) {
  const pendingData = pendingOutboxAfterReset(
    cloudData,
    pendingOutbox,
  )?.data
  return pendingData && typeof pendingData === 'object'
    ? pendingData
    : cloudData
}

export async function saveWithRevisionRecovery({
  payload,
  save,
  getLatest,
  onRevision = () => {},
  maxRevisionRetries = 3,
  wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  const retries = Math.max(
    0,
    Math.min(5, Number(maxRevisionRetries) || 0),
  )
  let nextPayload = payload
  let response = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    response = await save(nextPayload)
    if (
      response?.ok
      || response?.code !== 'ACCOUNT_VERSION_CONFLICT'
    ) {
      return response
    }
    if (attempt >= retries) break

    let latest = null
    try {
      latest = await getLatest()
    } catch {
      latest = null
    }
    if (
      !latest?.ok
      || !Number.isInteger(Number(latest.revision))
    ) {
      return {
        ...response,
        retryable: true,
        error: '云端版本已更新，自动对齐失败，稍后继续重试',
      }
    }
    const baseFingerprint = String(
      nextPayload?.baseTradeFingerprint || '',
    )
    const remoteMatchesBase = !!baseFingerprint && (
      accountTradeStateFingerprint(latest.data) === baseFingerprint
      || legacyAccountTradeStateFingerprint(latest.data)
        === baseFingerprint
    )
    if (
      !remoteMatchesBase
      && !sameAccountTradeState(nextPayload?.data, latest.data)
      && nextPayload?.forceTradeState !== true
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
    nextPayload = {
      ...nextPayload,
      baseRevision: revision,
    }
    await wait(Math.min(600, 75 * (2 ** attempt)))
  }

  return {
    ...response,
    retryable: true,
    error: '云端正在更新，已保留本机修改并将在稍后继续同步',
  }
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
  let activeItem = null
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
        activeItem = item
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
              ? 'retrying'
              : (error?.conflict || error?.code === 'TRADE_STATE_CONFLICT')
                ? 'conflict'
                : 'error',
            error: String(error?.message || error || '账号数据保存失败').slice(0, 160),
          })
          if (retryable) scheduleRetry()
          return false
        } finally {
          if (activeItem === item) activeItem = null
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
      const outboxId = String(payload?.outboxId || '')
      if (
        outboxId
        && String(activeItem?.payload?.outboxId || '') === outboxId
      ) {
        return running
      }
      if (
        outboxId
        && String(pending?.payload?.outboxId || '') === outboxId
      ) {
        if (retryTimer) {
          clearTimer(retryTimer)
          retryTimer = null
        }
        return drain()
      }
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
