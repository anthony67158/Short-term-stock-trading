const SNAPSHOT_TIMEOUT_MS = 5_000
const SNAPSHOT_CACHE_MS = 30 * 60 * 1000

let cached = null
let cachedAt = 0
let flight = null

function finiteScore(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.max(0, Math.min(100, number))
    : 0
}

export function normalizeStrategyPatternSnapshot(payload = {}) {
  if (
    payload?.schemaVersion !== 'strategy-pattern-snapshot.v1'
    || !/^\d{8}$/.test(String(payload.asOfDate || ''))
    || !payload.stocks
    || typeof payload.stocks !== 'object'
    || Array.isArray(payload.stocks)
  ) return null
  const stocks = new Map()
  for (const [code, raw] of Object.entries(payload.stocks)) {
    if (!/^\d{6}$/.test(code) || !raw || typeof raw !== 'object') continue
    stocks.set(code, {
      historyCoverage: Math.max(
        0,
        Math.min(1, Number(raw.historyCoverage) || 0),
      ),
      platformBreakout: finiteScore(raw.platformBreakout),
      supportPullback: finiteScore(raw.supportPullback),
      volumePriceSurge: finiteScore(raw.volumePriceSurge),
      lowerShadowReversal: finiteScore(raw.lowerShadowReversal),
      lowVolTrend: finiteScore(raw.lowVolTrend),
    })
  }
  return {
    schemaVersion: payload.schemaVersion,
    asOfDate: payload.asOfDate,
    generatedAt: Number(payload.generatedAt) || 0,
    summary: {
      stocks: stocks.size,
      historyDays: Math.max(
        0,
        Number(payload.summary?.historyDays) || 0,
      ),
      fullHistoryStocks: Math.max(
        0,
        Number(payload.summary?.fullHistoryStocks) || 0,
      ),
    },
    stocks,
  }
}

export async function fetchStrategyPatternSnapshot({
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
    const timeout = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS)
    try {
      const response = await fetchImpl(`${base}/strategy-pattern-snapshot`, {
        signal: controller.signal,
        headers: {
          ...(env.QUANT_KEY ? { 'X-API-Key': env.QUANT_KEY } : {}),
        },
      })
      if (!response.ok) return null
      const normalized = normalizeStrategyPatternSnapshot(await response.json())
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

export function resetStrategyPatternSnapshotCache() {
  cached = null
  cachedAt = 0
  flight = null
}
