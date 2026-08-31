import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'
import { planStore } from './planStore.js'
import {
  accountTradeStateFingerprint,
} from '../shared/accountSync.js'
import {
  beijingDate,
  beijingDayKey,
  beijingMinutes,
  isTradingDay,
  isTradingDayAt,
  localDateKey,
} from '../shared/tradingCalendar.js'

const stockFormulaCache = new Map()
const stockFormulaFlights = new Map()
const STOCK_FORMULA_LIVE_CACHE_MS = 60 * 1000
const STOCK_FORMULA_STALE_MS = 30 * 60 * 1000
const STOCK_FORMULA_CACHE_LIMIT = 64

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

function latestCompletedTradingDayKey(timestamp, includeCurrent) {
  const current = beijingDate(timestamp)
  current.setHours(0, 0, 0, 0)
  for (
    let offset = includeCurrent ? 0 : 1;
    offset <= 14;
    offset += 1
  ) {
    const candidate = new Date(current.getTime() - offset * 86400000)
    if (isTradingDay(candidate)) return localDateKey(candidate)
  }
  return beijingDayKey(timestamp)
}

export function formulaPriceCachePolicy(now = Date.now()) {
  const timestamp = Number(now) || Date.now()
  const day = beijingDayKey(timestamp)
  const minutes = beijingMinutes(timestamp)
  if (isTradingDayAt(timestamp)) {
    if (minutes < 570) {
      return {
        key: `close:${latestCompletedTradingDayKey(timestamp, false)}`,
        maxAgeMs: Infinity,
      }
    }
    if (minutes <= 690) {
      return {
        key: `live:${day}`,
        maxAgeMs: STOCK_FORMULA_LIVE_CACHE_MS,
      }
    }
    if (minutes < 780) {
      return { key: `lunch:${day}`, maxAgeMs: Infinity }
    }
    if (minutes < 900) {
      return {
        key: `live:${day}`,
        maxAgeMs: STOCK_FORMULA_LIVE_CACHE_MS,
      }
    }
    return { key: `close:${day}`, maxAgeMs: Infinity }
  }
  return {
    key: `close:${latestCompletedTradingDayKey(timestamp, true)}`,
    maxAgeMs: Infinity,
  }
}

export function formulaPriceAccountFingerprint(
  accountState = planStore.get(),
) {
  return accountTradeStateFingerprint(accountState || {})
}

export function readStockFormulaPriceCache(
  code,
  {
    now = Date.now(),
    headers = accountRequestHeaders(),
    accountState = planStore.get(),
  } = {},
) {
  const timestamp = Number(now) || Date.now()
  const policy = formulaPriceCachePolicy(timestamp)
  const cacheKey = formulaSelectionCacheKey(code, headers)
  const cached = stockFormulaCache.get(cacheKey)
  if (
    !cached
    || cached.marketKey !== policy.key
    || cached.accountFingerprint
      !== formulaPriceAccountFingerprint(accountState)
    || timestamp - cached.at > policy.maxAgeMs
  ) {
    return null
  }
  return cached.payload
}

export function clearStockFormulaPriceCache() {
  stockFormulaCache.clear()
  stockFormulaFlights.clear()
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

export function loadStockFormulaPrice(
  code,
  {
    force = false,
    now = Date.now(),
    accountState = planStore.get(),
  } = {},
) {
  const normalized = String(code || '')
  const headers = accountRequestHeaders()
  const cacheKey = formulaSelectionCacheKey(normalized, headers)
  const timestamp = Number(now) || Date.now()
  const policy = formulaPriceCachePolicy(timestamp)
  const accountFingerprint = formulaPriceAccountFingerprint(accountState)
  const flightKey =
    `${cacheKey}:${policy.key}:${accountFingerprint}`
  if (!force) {
    const cached = readStockFormulaPriceCache(normalized, {
      now: timestamp,
      headers,
      accountState,
    })
    if (cached) return Promise.resolve(cached)
  }
  if (stockFormulaFlights.has(flightKey)) {
    return stockFormulaFlights.get(flightKey)
  }
  const flight = request(
    `/api/formula_selection?view=stock&code=${encodeURIComponent(normalized)}`,
    { headers },
    30_000,
  ).then((payload) => {
    if (payload?.stale !== true) {
      stockFormulaCache.delete(cacheKey)
      stockFormulaCache.set(cacheKey, {
        at: timestamp,
        marketKey: policy.key,
        accountFingerprint,
        payload,
      })
      while (stockFormulaCache.size > STOCK_FORMULA_CACHE_LIMIT) {
        stockFormulaCache.delete(
          stockFormulaCache.keys().next().value,
        )
      }
    }
    return payload
  }).catch((error) => {
    const cached = stockFormulaCache.get(cacheKey)
    if (
      isFormulaSelectionTransientError(error)
      && cached
      && cached.accountFingerprint === accountFingerprint
      && timestamp - cached.at <= STOCK_FORMULA_STALE_MS
    ) {
      return {
        ...cached.payload,
        stale: true,
      }
    }
    throw error
  }).finally(() => {
    if (stockFormulaFlights.get(flightKey) === flight) {
      stockFormulaFlights.delete(flightKey)
    }
  })
  stockFormulaFlights.set(flightKey, flight)
  return flight
}
