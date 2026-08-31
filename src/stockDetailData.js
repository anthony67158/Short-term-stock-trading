import { prefetchPolling } from './hooks.js'

export const STOCK_DETAIL_CACHE_TTL_MS = 2 * 60 * 1000

export function stockDetailPath(code, klt = '101') {
  return `/api/stock_detail?code=${encodeURIComponent(code)}`
    + `&klt=${encodeURIComponent(klt)}&lmt=120&trends=1&quote=1`
}

export function preloadStockDetailData(code) {
  if (!code) return Promise.resolve(null)
  return prefetchPolling(stockDetailPath(code), {
    cacheTtlMs: STOCK_DETAIL_CACHE_TTL_MS,
  })
}
