import { useEffect, useSyncExternalStore } from 'react'
import { api } from './apiBase.js'

const BATCH_LIMIT = 80
const REQUEST_TIMEOUT_MS = 15000

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
      api(`/api/stock_tags?codes=${codes.join(',')}&v=4`),
      { signal: controller.signal },
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
} = {}) {
  const cache = new Map()
  const pending = new Set()
  const inFlight = new Set()
  const listeners = new Set()
  let version = 0
  let timer = null
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
    if (!code || cache.has(code) || inFlight.has(code)) return
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
      .filter((code) => !cache.has(code) && !inFlight.has(code))
      .slice(0, BATCH_LIMIT)
    codes.forEach((code) => {
      pending.delete(code)
      inFlight.add(code)
    })
    if (!codes.length) return undefined

    activePromise = (async () => {
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
        }
      } catch {
        // 题材是辅助信息，失败保持静默；后续重新挂载可再次尝试。
      } finally {
        codes.forEach((code) => inFlight.delete(code))
        activePromise = null
        emit()
        if (pending.size) schedule()
      }
    })()
    return activePromise
  }

  return {
    ensure,
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
    stockTagStore.ensure(code)
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
    key.split(',').filter(Boolean).forEach(stockTagStore.ensure)
  }, [key])
  return Object.fromEntries(
    key.split(',')
      .filter(Boolean)
      .map((code) => [code, stockTagStore.get(code)]),
  )
}
