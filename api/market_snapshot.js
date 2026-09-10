import { sendJson, sendError } from './_lib.js'
import { fetchLimitPool } from './_limit_pool.js'
import { fetchOverseas } from './_market_data.js'
import { fetchMarketSnapshot } from './market.js'
import { fetchMovers } from './board.js'
import { fetchSectorList } from './sectors.js'
import {
  buildMarketFundsSnapshot,
} from '../shared/marketFunds.js'

const CACHE_TTL_MS = 8_000
const OVERSEAS_CACHE_TTL_MS = 60_000
let cached = null
let inFlight = null
let overseasCached = null
let overseasInFlight = null

function settledValue(result) {
  return result.status === 'fulfilled' ? result.value : null
}

function settledError(result) {
  if (result.status === 'fulfilled') return null
  return String(result.reason?.message || result.reason || '数据源暂不可用')
}

async function readOverseasSnapshot(loader, timestamp) {
  if (
    overseasCached
    && timestamp - overseasCached.at < OVERSEAS_CACHE_TTL_MS
  ) {
    return overseasCached.value
  }
  if (overseasInFlight) return overseasInFlight
  overseasInFlight = Promise.resolve()
    .then(() => loader())
    .then((value) => {
      overseasCached = { at: timestamp, value }
      return value
    })
    .finally(() => {
      overseasInFlight = null
    })
  return overseasInFlight
}

export async function collectMarketSnapshot({
  market = fetchMarketSnapshot,
  sectors = fetchSectorList,
  limitPool = fetchLimitPool,
  movers = fetchMovers,
  overseas = fetchOverseas,
  now = Date.now,
} = {}) {
  const timestamp = Number(now()) || Date.now()
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
    readOverseasSnapshot(overseas, timestamp),
  ])
  const names = [
    'market',
    'sectors',
    'limitUp',
    'brokenLimit',
    'movers',
    'speed',
    'overseas',
  ]
  const errors = Object.fromEntries(
    results
      .map((result, index) => [names[index], settledError(result)])
      .filter(([, error]) => error),
  )
  const marketValue = settledValue(results[0])
  const sectorsValue = settledValue(results[1])
  return {
    ok: results.some((result) => result.status === 'fulfilled'),
    updatedAt: timestamp,
    market: marketValue,
    sectors: sectorsValue,
    marketFunds: buildMarketFundsSnapshot({
      market: marketValue,
      updatedAt: timestamp,
    }),
    limitUp: settledValue(results[2]),
    brokenLimit: settledValue(results[3]),
    movers: settledValue(results[4]),
    speed: settledValue(results[5]),
    overseas: settledValue(results[6]),
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
  overseasCached = null
  overseasInFlight = null
}

export default async function handler(_req, res) {
  try {
    sendJson(res, await readMarketSnapshot(), { cache: 8 })
  } catch (error) {
    sendError(res, error)
  }
}
