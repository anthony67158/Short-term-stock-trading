import { sendJson, sendError } from './_lib.js'
import { fetchLimitPool } from './_limit_pool.js'
import { fetchMarketSnapshot } from './market.js'
import { fetchMovers } from './board.js'
import { fetchSectorList } from './sectors.js'

const CACHE_TTL_MS = 8_000
let cached = null
let inFlight = null

function settledValue(result) {
  return result.status === 'fulfilled' ? result.value : null
}

function settledError(result) {
  if (result.status === 'fulfilled') return null
  return String(result.reason?.message || result.reason || '数据源暂不可用')
}

export async function collectMarketSnapshot({
  market = fetchMarketSnapshot,
  sectors = fetchSectorList,
  limitPool = fetchLimitPool,
  movers = fetchMovers,
  now = Date.now,
} = {}) {
  const ztPromise = limitPool('zt')
  const dtPromise = limitPool('dt')
  const zbPromise = limitPool('zb')
  const results = await Promise.allSettled([
    market({
      limitUpPool: ztPromise,
      limitDownPool: dtPromise,
      brokenLimitPool: zbPromise,
    }),
    sectors({ type: 'industry', sort: 'main' }),
    ztPromise,
    zbPromise,
    movers('inflow'),
    movers('speed'),
  ])
  const names = ['market', 'sectors', 'limitUp', 'brokenLimit', 'movers', 'speed']
  const errors = Object.fromEntries(
    results
      .map((result, index) => [names[index], settledError(result)])
      .filter(([, error]) => error),
  )
  return {
    ok: results.some((result) => result.status === 'fulfilled'),
    updatedAt: Number(now()) || Date.now(),
    market: settledValue(results[0]),
    sectors: settledValue(results[1]),
    limitUp: settledValue(results[2]),
    brokenLimit: settledValue(results[3]),
    movers: settledValue(results[4]),
    speed: settledValue(results[5]),
    errors,
  }
}

export async function readMarketSnapshot(options = {}) {
  const timestamp = Number(options.now?.() ?? Date.now())
  if (cached && timestamp - cached.at < CACHE_TTL_MS) return cached.value
  if (inFlight) return inFlight
  inFlight = collectMarketSnapshot(options)
    .then((value) => {
      cached = { at: timestamp, value }
      return value
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

export function resetMarketSnapshotCache() {
  cached = null
  inFlight = null
}

export default async function handler(_req, res) {
  try {
    sendJson(res, await readMarketSnapshot(), { cache: 8 })
  } catch (error) {
    sendError(res, error)
  }
}
