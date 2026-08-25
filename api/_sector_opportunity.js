import {
  buildSectorOpportunity,
} from '../shared/sectorOpportunity.js'
import {
  sectorForecastStore,
} from './_sector_forecast_store.js'

const CACHE_MS = 60 * 1000

let snapshotCache = {
  loadedAt: 0,
  latest: null,
  intraday: null,
}

async function snapshots(store, now) {
  if (
    store === sectorForecastStore
    && now - snapshotCache.loadedAt < CACHE_MS
  ) {
    return snapshotCache
  }
  const [latest, intraday] = await Promise.all([
    store.readLatest(),
    store.readIntraday(),
  ])
  const value = { loadedAt: now, latest, intraday }
  if (store === sectorForecastStore) snapshotCache = value
  return value
}

export async function loadSectorOpportunity(
  code,
  {
    store = sectorForecastStore,
    now = Date.now(),
  } = {},
) {
  const value = await snapshots(store, now)
  return buildSectorOpportunity({
    code,
    latest: value.latest,
    intraday: value.intraday,
    now,
  })
}

export function resetSectorOpportunityCache() {
  snapshotCache = {
    loadedAt: 0,
    latest: null,
    intraday: null,
  }
}
