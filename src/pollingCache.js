const cache = new Map()
const inflight = new Map()
const pollingChannels = new Map()
const MAX_ENTRIES = 32

export function readPollingCache(key, ttlMs, now = Date.now()) {
  const entry = cache.get(String(key || ''))
  if (!entry || now - entry.at > Math.max(0, Number(ttlMs) || 0)) {
    return null
  }
  return entry.data
}

export function readPollingCacheStale(
  key,
  maxAgeMs,
  now = Date.now(),
) {
  const entry = cache.get(String(key || ''))
  if (
    !entry
    || now - entry.at > Math.max(0, Number(maxAgeMs) || 0)
  ) {
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
      if (
        data?.ok !== false
        && data?.stale !== true
        && data?.klineStale !== true
      ) {
        writePollingCache(normalized, data)
      }
      return data
    })
    .finally(() => {
      if (inflight.get(normalized) === request) inflight.delete(normalized)
    })
  inflight.set(normalized, request)
  return request
}

function browserOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

function stopPollingChannel(channel) {
  if (channel.timer == null) return
  clearInterval(channel.timer)
  channel.timer = null
}

function runPollingChannel(channel) {
  if (!browserOnline()) return
  for (const subscriber of channel.subscribers) subscriber.callback()
}

function schedulePollingChannel(channel) {
  stopPollingChannel(channel)
  const intervals = [...channel.subscribers]
    .map((subscriber) => subscriber.intervalMs)
    .filter((value) => Number.isFinite(value) && value > 0)
  if (!intervals.length || !browserOnline()) return
  channel.intervalMs = Math.min(...intervals)
  channel.timer = setInterval(
    () => runPollingChannel(channel),
    channel.intervalMs,
  )
  channel.timer?.unref?.()
}

export function subscribePollingTicks(key, intervalMs, callback) {
  const normalized = String(key || '')
  if (!normalized || typeof callback !== 'function') return () => {}
  let channel = pollingChannels.get(normalized)
  if (!channel) {
    channel = {
      subscribers: new Set(),
      timer: null,
      intervalMs: 0,
      onOffline: null,
      onOnline: null,
    }
    channel.onOffline = () => stopPollingChannel(channel)
    channel.onOnline = () => {
      runPollingChannel(channel)
      schedulePollingChannel(channel)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', channel.onOffline)
      window.addEventListener('online', channel.onOnline)
    }
    pollingChannels.set(normalized, channel)
  }
  const subscriber = {
    callback,
    intervalMs: Math.max(0, Number(intervalMs) || 0),
  }
  channel.subscribers.add(subscriber)
  schedulePollingChannel(channel)
  return () => {
    channel.subscribers.delete(subscriber)
    if (channel.subscribers.size) {
      schedulePollingChannel(channel)
      return
    }
    stopPollingChannel(channel)
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', channel.onOffline)
      window.removeEventListener('online', channel.onOnline)
    }
    pollingChannels.delete(normalized)
  }
}

export function pollingSubscriptionSnapshot(key) {
  const channel = pollingChannels.get(String(key || ''))
  return channel
    ? {
        subscribers: channel.subscribers.size,
        intervalMs: channel.intervalMs,
        running: channel.timer != null,
      }
    : null
}

export function resetPollingSubscriptions() {
  for (const channel of pollingChannels.values()) {
    stopPollingChannel(channel)
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', channel.onOffline)
      window.removeEventListener('online', channel.onOnline)
    }
  }
  pollingChannels.clear()
}
