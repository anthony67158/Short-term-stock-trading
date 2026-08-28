import { useEffect, useSyncExternalStore } from 'react'
import { api } from './apiBase.js'

const BATCH_LIMIT = 80
const REQUEST_TIMEOUT_MS = 15000
export const STOCK_TAG_REVALIDATE_MS = 5 * 60 * 1000
export const STOCK_TAG_FAILURE_RETRY_MS = 30 * 1000
const STOCK_TAG_SWEEP_MS = 60 * 1000

function validCode(value) {
  const code = String(value || '').trim()
  return /^\d{6}$/.test(code) ? code : ''
}

async function defaultFetchBatch(codes) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  )
  try {
    const response = await fetch(
      api(
        `/api/stock_tags?codes=${codes.join(',')}&v=5`
          + `&_t=${Date.now()}`,
      ),
      { signal: controller.signal, cache: 'no-store' },
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (payload?.ok === false) {
      throw new Error(payload.error || '题材数据暂不可用')
    }
    return Array.isArray(payload?.list) ? payload.list : []
  } finally {
    clearTimeout(timeout)
  }
}

export function createStockTagStore({
  fetchBatch = defaultFetchBatch,
  now = Date.now,
  revalidateMs = STOCK_TAG_REVALIDATE_MS,
} = {}) {
  const revalidateWindowMs = Number.isFinite(Number(revalidateMs))
    ? Math.max(1000, Number(revalidateMs))
    : STOCK_TAG_REVALIDATE_MS
  const cache = new Map()
  const checkedAt = new Map()
  const retryAt = new Map()
  const pending = new Set()
  const inFlight = new Set()
  const watched = new Map()
  const listeners = new Set()
  let version = 0
  let timer = null
  let watchTimer = null
  let activePromise = null

  const emit = () => {
    version++
    for (const listener of listeners) {
      try { listener() } catch { /* 单个订阅异常不阻断其它组件 */ }
    }
  }

  const schedule = () => {
    if (timer != null || typeof setTimeout !== 'function') return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, 0)
  }

  const ensure = (value) => {
    const code = validCode(value)
    const checked = Number(checkedAt.get(code)) || 0
    const currentTime = Number(now())
    const nextRetryAt = Number(retryAt.get(code)) || 0
    const retryReady = nextRetryAt > 0
      && currentTime >= nextRetryAt
    const fresh = !retryReady
      && checked > 0
      && currentTime - checked < revalidateWindowMs
    if (!code || fresh || inFlight.has(code)) return
    pending.add(code)
    schedule()
  }

  const flush = async () => {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
    if (activePromise) return activePromise
    const codes = [...pending]
      .filter((code) => !inFlight.has(code))
      .slice(0, BATCH_LIMIT)
    codes.forEach((code) => {
      pending.delete(code)
      inFlight.add(code)
    })
    if (!codes.length) return undefined

    activePromise = (async () => {
      let failed = false
      try {
        const list = await fetchBatch(codes)
        const received = new Set()
        for (const item of list || []) {
          const code = validCode(item?.code)
          if (code) {
            received.add(code)
            cache.set(code, item)
          }
        }
        for (const code of codes) {
          if (!received.has(code)) {
            cache.set(code, { code, displayTags: [] })
          }
          retryAt.delete(code)
        }
      } catch {
        failed = true
        for (const code of codes) {
          if (!cache.has(code)) {
            cache.set(code, {
              code,
              displayTags: [],
              unavailable: true,
            })
          }
        }
      } finally {
        const checked = Number(now()) || Date.now()
        codes.forEach((code) => checkedAt.set(code, checked))
        if (failed) {
          codes.forEach((code) => {
            retryAt.set(
              code,
              checked + STOCK_TAG_FAILURE_RETRY_MS,
            )
          })
        }
        codes.forEach((code) => inFlight.delete(code))
        activePromise = null
        emit()
        if (pending.size) schedule()
      }
    })()
    return activePromise
  }

  const stopWatchTimer = () => {
    if (watchTimer == null) return
    clearInterval(watchTimer)
    watchTimer = null
  }

  const startWatchTimer = () => {
    if (
      watchTimer != null
      || typeof setInterval !== 'function'
      || !watched.size
    ) return
    watchTimer = setInterval(() => {
      for (const code of watched.keys()) ensure(code)
    }, Math.min(
      STOCK_TAG_SWEEP_MS,
      revalidateWindowMs,
      STOCK_TAG_FAILURE_RETRY_MS,
    ))
    watchTimer?.unref?.()
  }

  const watch = (value) => {
    const code = validCode(value)
    if (!code) return () => {}
    watched.set(code, (watched.get(code) || 0) + 1)
    ensure(code)
    startWatchTimer()
    return () => {
      const count = (watched.get(code) || 1) - 1
      if (count > 0) watched.set(code, count)
      else watched.delete(code)
      if (!watched.size) stopWatchTimer()
    }
  }

  return {
    ensure,
    watch,
    flush,
    get: (code) => cache.get(validCode(code)) || null,
    getVersion: () => version,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const stockTagStore = createStockTagStore()

export function useStockTag(code) {
  useSyncExternalStore(
    stockTagStore.subscribe,
    stockTagStore.getVersion,
    stockTagStore.getVersion,
  )
  useEffect(() => {
    return stockTagStore.watch(code)
  }, [code])
  return stockTagStore.get(code)
}

export function useStockTags(codes = []) {
  useSyncExternalStore(
    stockTagStore.subscribe,
    stockTagStore.getVersion,
    stockTagStore.getVersion,
  )
  const key = [...new Set(codes.map(validCode).filter(Boolean))]
    .sort()
    .join(',')
  useEffect(() => {
    const unwatch = key.split(',')
      .filter(Boolean)
      .map(stockTagStore.watch)
    return () => unwatch.forEach((stop) => stop())
  }, [key])
  return Object.fromEntries(
    key.split(',')
      .filter(Boolean)
      .map((code) => [code, stockTagStore.get(code)]),
  )
}
