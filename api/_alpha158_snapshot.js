import {
  normalizeAlpha158Snapshot,
} from '../shared/alpha158Signal.js'

const SNAPSHOT_TIMEOUT_MS = 5_000
const SNAPSHOT_CACHE_MS = 30 * 60 * 1000

let cached = null
let cachedAt = 0
let flight = null

export async function fetchAlpha158Snapshot({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (cached && now - cachedAt < SNAPSHOT_CACHE_MS) return cached
  if (flight) return flight
  const base = String(env.QUANT_URL || '').trim().replace(/\/+$/, '')
  if (!base) return null
  flight = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      SNAPSHOT_TIMEOUT_MS,
    )
    try {
      const response = await fetchImpl(`${base}/alpha158-snapshot`, {
        signal: controller.signal,
        headers: {
          ...(env.QUANT_KEY ? { 'X-API-Key': env.QUANT_KEY } : {}),
        },
      })
      if (!response.ok) return null
      const normalized = normalizeAlpha158Snapshot(
        await response.json(),
      )
      if (normalized) {
        cached = normalized
        cachedAt = now
      }
      return normalized
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
      flight = null
    }
  })()
  return flight
}

export function resetAlpha158SnapshotCache() {
  cached = null
  cachedAt = 0
  flight = null
}
