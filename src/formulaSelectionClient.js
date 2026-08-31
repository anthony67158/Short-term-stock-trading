import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

const stockFormulaCache = new Map()
const STOCK_FORMULA_STALE_MS = 30 * 60 * 1000

export function formulaSelectionClientError(message, status = 0) {
  const detail = String(message || '')
  if (
    Number(status) >= 500
    || /HTTP\s*\d{3}|fetch failed|failed to fetch|network|timeout|aborted/i
      .test(detail)
  ) {
    return '行情数据暂时不可用，请稍后重试'
  }
  return detail || '公式价位暂时不可用，请稍后重试'
}

export function formulaSelectionCacheKey(code, headers = {}) {
  const account = String(headers['X-Account-Nick'] || 'anonymous')
  return `${account}:${String(code || '')}`
}

export function isFormulaSelectionTransientError(error) {
  const status = Number(error?.status) || 0
  const errorCode = String(error?.errorCode || '')
  const message = String(error?.message || error || '')
  return (
    status >= 500
    || ['MARKET_DATA_UNAVAILABLE', 'NETWORK_ERROR'].includes(errorCode)
    || /HTTP\s*\d{3}|fetch failed|failed to fetch|network|timeout|超时|aborted/i
      .test(message)
  )
}

async function request(path, options = {}, timeoutMs = 70_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(api(path), {
      ...options,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        ...accountRequestHeaders(),
        ...(options.headers || {}),
      },
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      const failure = new Error(
        formulaSelectionClientError(
          payload?.error,
          response.status,
        ),
      )
      failure.status = response.status
      failure.errorCode = payload?.errorCode || ''
      throw failure
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('公式计算超时，请稍后重试')
    }
    if (!error?.status && error instanceof TypeError) {
      const failure = new Error(
        formulaSelectionClientError(error.message),
      )
      failure.errorCode = 'NETWORK_ERROR'
      throw failure
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function loadFormulaSelectionState() {
  return request('/api/formula_selection?view=latest')
}

export function runFormulaSelection(mode) {
  return request('/api/formula_selection', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key':
        `formula-selection:${mode}:${Date.now()}`,
    },
    body: JSON.stringify({ mode }),
  }, mode === 'close' ? 100_000 : 70_000)
}

export function loadFormulaSelectionProgress(mode) {
  return request(
    `/api/formula_selection?view=progress&mode=${encodeURIComponent(mode)}`,
    {},
    10_000,
  )
}

export function loadStockFormulaPrice(code) {
  const normalized = String(code || '')
  const headers = accountRequestHeaders()
  const cacheKey = formulaSelectionCacheKey(normalized, headers)
  return request(
    `/api/formula_selection?view=stock&code=${encodeURIComponent(normalized)}`,
    { headers },
    30_000,
  ).then((payload) => {
    if (payload?.stale !== true) {
      stockFormulaCache.set(cacheKey, {
        at: Date.now(),
        payload,
      })
    }
    return payload
  }).catch((error) => {
    const cached = stockFormulaCache.get(cacheKey)
    if (
      isFormulaSelectionTransientError(error)
      && cached
      && Date.now() - cached.at <= STOCK_FORMULA_STALE_MS
    ) {
      return {
        ...cached.payload,
        stale: true,
      }
    }
    throw error
  })
}
