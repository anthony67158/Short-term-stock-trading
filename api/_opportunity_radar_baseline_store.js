import {
  hasStorage,
  put,
  readJson,
} from './_blob.js'
import {
  OPPORTUNITY_RADAR_LEDGER_PREFIX,
} from './_opportunity_radar_ledger_store.js'

export const OPPORTUNITY_RADAR_BASELINE_PATH =
  `${OPPORTUNITY_RADAR_LEDGER_PREFIX}baseline/latest.json`

let memoryBaseline = null

export function createOpportunityRadarBaselineStore(storage = {
  hasStorage,
  put,
  readJson,
}) {
  return {
    async saveBaseline(value) {
      if (value?.schemaVersion !== 'opportunity-radar-baseline.v1') {
        throw new Error('机会雷达基线格式无效')
      }
      if (!storage.hasStorage()) {
        memoryBaseline = value
        return value
      }
      await storage.put(
        OPPORTUNITY_RADAR_BASELINE_PATH,
        JSON.stringify(value),
        {
          contentType: 'application/json',
          addRandomSuffix: false,
          cacheControlMaxAge: 0,
        },
      )
      return value
    },
    async readBaseline() {
      if (!storage.hasStorage()) return memoryBaseline
      return storage.readJson(
        OPPORTUNITY_RADAR_BASELINE_PATH,
      ).catch(() => null)
    },
  }
}

export const opportunityRadarBaselineStore =
  createOpportunityRadarBaselineStore()
