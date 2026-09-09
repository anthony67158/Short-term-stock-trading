import {
  hasStorage,
  put,
  readJson,
} from './_blob.js'

export const OPPORTUNITY_TRAINING_STATUS_SCHEMA_VERSION =
  'opportunity-training-status.v1'

export const OPPORTUNITY_TRAINING_STATUS_PATH =
  'opportunitymodel/training-status.json'

export const OPPORTUNITY_COLLECTION_STATUS_PATH =
  'market/opportunity-radar/v1/status/latest.json'

const REQUIREMENTS = Object.freeze({
  samples: 1000,
  filledSamples: 300,
  dates: 60,
})

let memoryCollection = null

function count(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.max(0, Math.trunc(number))
    : 0
}

function text(value, maximum = 160) {
  return String(value || '').trim().slice(0, maximum)
}

function normalizedReadiness(value = {}) {
  const samples = count(value.samples)
  const filledSamples = count(
    value.filledSamples ?? value.filled_samples,
  )
  const dates = count(value.dates)
  const blockers = (Array.isArray(value.blockers)
    ? value.blockers
    : []).map((item) => text(item)).filter(Boolean).slice(0, 8)
  return {
    samples,
    filledSamples,
    dates,
    requirements: { ...REQUIREMENTS },
    remaining: {
      samples: Math.max(0, REQUIREMENTS.samples - samples),
      filledSamples: Math.max(
        0,
        REQUIREMENTS.filledSamples - filledSamples,
      ),
      dates: Math.max(0, REQUIREMENTS.dates - dates),
    },
    blockers,
  }
}

export function normalizeOpportunityTrainingStatus(
  training,
  collection,
) {
  const source = training && typeof training === 'object'
    ? training
    : {}
  const active = source.activeModel || {}
  const readiness = normalizedReadiness(source.readiness)
  const productionEligible = (
    source.productionEligible === true
    || active.productionEligible === true
  )
  return {
    schemaVersion: OPPORTUNITY_TRAINING_STATUS_SCHEMA_VERSION,
    generatedAt: count(source.generatedAt),
    state: productionEligible
      ? 'PRODUCTION_READY'
      : text(source.state, 40) || 'NOT_READY',
    modelVersion:
      text(active.modelVersion || source.modelVersion, 100) || null,
    shadowEligible: source.shadowEligible === true,
    productionEligible,
    readiness,
    promotionBlockers: (Array.isArray(source.promotionBlockers)
      ? source.promotionBlockers
      : []).map((item) => text(item)).filter(Boolean).slice(0, 8),
    collection: collection && typeof collection === 'object'
      ? {
          generatedAt: count(collection.generatedAt),
          batches: count(collection.settlement?.batches),
          candidates: count(collection.settlement?.candidates),
          evaluated: count(collection.settlement?.evaluated),
          deferred: count(collection.settlement?.deferred),
          matured: count(collection.settlement?.matured),
          pending: count(collection.settlement?.pending),
        }
      : null,
    directEntry: productionEligible
      ? {
          eligible: true,
          reason: 'V3已通过独立时间窗、净R和回撤晋级闸门',
        }
      : {
          eligible: false,
          reason: readiness.blockers[0]
            || 'V3尚未通过生产晋级闸门',
        },
  }
}

export function createOpportunityTrainingStatusStore(storage = {
  hasStorage,
  put,
  readJson,
}) {
  return {
    async readStatus() {
      if (!storage.hasStorage()) {
        return normalizeOpportunityTrainingStatus(
          null,
          memoryCollection,
        )
      }
      const [training, collection] = await Promise.all([
        storage.readJson(OPPORTUNITY_TRAINING_STATUS_PATH)
          .catch(() => null),
        storage.readJson(OPPORTUNITY_COLLECTION_STATUS_PATH)
          .catch(() => null),
      ])
      return normalizeOpportunityTrainingStatus(training, collection)
    },
    async saveCollectionStatus(value) {
      const snapshot = {
        schemaVersion: 'opportunity-collection-status.v1',
        generatedAt: count(value?.generatedAt) || Date.now(),
        settlement: value?.settlement || null,
      }
      if (!storage.hasStorage()) {
        memoryCollection = snapshot
        return snapshot
      }
      await storage.put(
        OPPORTUNITY_COLLECTION_STATUS_PATH,
        JSON.stringify(snapshot),
        {
          contentType: 'application/json',
          addRandomSuffix: false,
          cacheControlMaxAge: 0,
        },
      )
      return snapshot
    },
  }
}

export const opportunityTrainingStatusStore =
  createOpportunityTrainingStatusStore()
