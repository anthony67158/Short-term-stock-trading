const CACHE_KEY = 'cloud_account_snapshot_v1'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function storageOf(storage) {
  if (storage) return storage
  try { return globalThis.sessionStorage || null } catch { return null }
}

export function readAccountSnapshotCache(
  nick,
  {
    storage,
    now = Date.now(),
    maxAgeMs = MAX_AGE_MS,
  } = {},
) {
  const target = storageOf(storage)
  if (!target || !nick) return null
  try {
    const cached = JSON.parse(target.getItem(CACHE_KEY) || 'null')
    if (
      cached?.nick !== String(nick)
      || !cached.data
      || typeof cached.data !== 'object'
      || now - Number(cached.cachedAt || 0) > maxAgeMs
    ) return null
    return cached
  } catch {
    return null
  }
}

export function writeAccountSnapshotCache(
  nick,
  snapshot,
  { storage, now = Date.now() } = {},
) {
  const target = storageOf(storage)
  if (!target || !nick || !snapshot?.data) return false
  try {
    target.setItem(CACHE_KEY, JSON.stringify({
      nick: String(nick),
      data: snapshot.data,
      updatedAt: Number(snapshot.updatedAt) || 0,
      revision: Number(snapshot.revision) || 0,
      cachedAt: now,
    }))
    return true
  } catch {
    return false
  }
}

export function clearAccountSnapshotCache(nick, { storage } = {}) {
  const target = storageOf(storage)
  if (!target) return
  try {
    const cached = JSON.parse(target.getItem(CACHE_KEY) || 'null')
    if (!nick || cached?.nick === String(nick)) target.removeItem(CACHE_KEY)
  } catch {
    try { target.removeItem(CACHE_KEY) } catch { /* ignore */ }
  }
}
