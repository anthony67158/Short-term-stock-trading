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
            throw error
          }
          retryDelay = retryBaseMs
          if (!pending) notify({ status: 'synced', error: '', updatedAt: response.updatedAt || Date.now() })
        } catch (error) {
          if (item.epoch !== epoch) continue
          const retryable = error?.retryable !== false
          if (retryable && !pending) pending = item
          notify({
            status: 'error',
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
