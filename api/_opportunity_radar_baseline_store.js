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

export const OPPORTUNITY_RADAR_DRIFT_HISTORY_PATH =
  `${OPPORTUNITY_RADAR_LEDGER_PREFIX}baseline/drift-history.json`

const DEFAULT_DRIFT_HISTORY_LIMIT = 60

let memoryBaseline = null
let memoryDriftHistory = []

// 漂移历史只保留判断趋势必需的精简字段，避免把完整分桶报告反复写盘。
function compactSnapshot(baseline) {
  const overall = baseline?.overall || {}
  return {
    generatedAt: Number(baseline?.generatedAt) || 0,
    range: baseline?.range || null,
    overall: {
      samples: Number(overall.samples) || 0,
      completedTrades: Number(overall.completedTrades) || 0,
      triggerRatePct: overall.triggerRatePct ?? null,
      winRatePct: overall.winRatePct ?? null,
      expectedNetRGivenFill: overall.expectedNetRGivenFill ?? null,
      expectedNetRPerCandidate: overall.expectedNetRPerCandidate ?? null,
      profitFactor: overall.profitFactor ?? null,
      sampleSufficient: overall.sampleSufficient === true,
    },
  }
}

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
    async readDriftHistory() {
      if (!storage.hasStorage()) return memoryDriftHistory.slice()
      const history = await storage.readJson(
        OPPORTUNITY_RADAR_DRIFT_HISTORY_PATH,
      ).catch(() => null)
      return Array.isArray(history) ? history : []
    },
    async appendDriftHistory(baseline, { limit } = {}) {
      const cap = Math.max(
        2,
        Math.min(365, Number(limit) || DEFAULT_DRIFT_HISTORY_LIMIT),
      )
      const snapshot = compactSnapshot(baseline)
      const existing = await this.readDriftHistory()
      const next = [...existing, snapshot]
        .sort((left, right) =>
          (Number(left.generatedAt) || 0) - (Number(right.generatedAt) || 0),
        )
        .slice(-cap)
      if (!storage.hasStorage()) {
        memoryDriftHistory = next
        return next
      }
      await storage.put(
        OPPORTUNITY_RADAR_DRIFT_HISTORY_PATH,
        JSON.stringify(next),
        {
          contentType: 'application/json',
          addRandomSuffix: false,
          cacheControlMaxAge: 0,
        },
      )
      return next
    },
  }
}

export const opportunityRadarBaselineStore =
  createOpportunityRadarBaselineStore()
