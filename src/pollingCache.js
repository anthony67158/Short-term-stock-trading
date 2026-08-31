const cache = new Map()
const inflight = new Map()
const MAX_ENTRIES = 32

export function readPollingCache(key, ttlMs, now = Date.now()) {
  const entry = cache.get(String(key || ''))
  if (!entry || now - entry.at > Math.max(0, Number(ttlMs) || 0)) {
    return null
  }
  return entry.data
}

export function writePollingCache(key, data, now = Date.now()) {
  const normalized = String(key || '')
  if (!normalized || data == null) return
  cache.delete(normalized)
  cache.set(normalized, { data, at: now })
  while (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value)
  }
}

export function clearPollingCache(key) {
  if (key == null) cache.clear()
  else cache.delete(String(key))
}

export async function loadPollingResource(
  key,
  loader,
  {
    ttlMs = 0,
    preferCache = true,
  } = {},
) {
  const normalized = String(key || '')
  const cached = preferCache
    ? readPollingCache(normalized, ttlMs)
    : null
  if (cached != null) return cached
  if (inflight.has(normalized)) return inflight.get(normalized)

  const request = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (data?.ok !== false) writePollingCache(normalized, data)
      return data
    })
    .finally(() => {
      if (inflight.get(normalized) === request) inflight.delete(normalized)
    })
  inflight.set(normalized, request)
  return request
}
