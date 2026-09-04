import {
  hasStorage,
  list,
  put,
  readJson,
} from './_blob.js'

export const PRE_CATALYST_PREFIX = 'market/pre-catalyst/v1/'

const memory = {
  latest: null,
  progress: null,
  relations: { edges: [] },
  runs: new Map(),
  outcomes: new Map(),
  evaluation: null,
}

function safeDate(value) {
  const date = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('预催化日期无效')
  }
  return date
}

function safeId(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9:_-]/g, '')
    .slice(0, 100)
}

function options(extra = {}) {
  return {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
    ...extra,
  }
}

function isConflict(error) {
  return error?.status === 409
    || ['FileAlreadyExists', 'ObjectAlreadyExists']
      .includes(error?.code)
}

export function createPreCatalystStore(storage = {
  hasStorage,
  list,
  put,
  readJson,
}) {
  const write = async (path, value, extra = {}) => {
    if (!storage.hasStorage()) return value
    await storage.put(path, JSON.stringify(value), options(extra))
    return value
  }
  return {
    async readLatest() {
      if (!storage.hasStorage()) return memory.latest
      return storage.readJson(`${PRE_CATALYST_PREFIX}latest.json`)
        .catch(() => null)
    },
    async saveSnapshot(snapshot) {
      const tradeDate = safeDate(snapshot?.tradeDate)
      const generatedAt = Math.max(
        1,
        Number(snapshot?.generatedAt) || Date.now(),
      )
      const runPath =
        `${PRE_CATALYST_PREFIX}runs/${tradeDate}/${generatedAt}.json`
      if (!storage.hasStorage()) {
        memory.runs.set(runPath, snapshot)
        memory.latest = snapshot
        return snapshot
      }
      try {
        await write(runPath, snapshot, { forbidOverwrite: true })
      } catch (error) {
        if (!isConflict(error)) throw error
      }
      await write(`${PRE_CATALYST_PREFIX}latest.json`, snapshot)
      return snapshot
    },
    async readProgress() {
      if (!storage.hasStorage()) return memory.progress
      return storage.readJson(`${PRE_CATALYST_PREFIX}runtime.json`)
        .catch(() => null)
    },
    async saveProgress(progress) {
      if (!storage.hasStorage()) {
        memory.progress = progress
        return progress
      }
      return write(`${PRE_CATALYST_PREFIX}runtime.json`, progress)
    },
    async readRelations() {
      if (!storage.hasStorage()) return memory.relations
      return storage.readJson(`${PRE_CATALYST_PREFIX}relations.json`)
        .catch(() => ({ edges: [] }))
    },
    async listRuns(limit = 60) {
      if (!storage.hasStorage()) {
        return [...memory.runs.values()]
          .sort((left, right) =>
            Number(right?.generatedAt || 0)
              - Number(left?.generatedAt || 0)
          )
          .slice(0, limit)
      }
      const result = await storage.list({
        prefix: `${PRE_CATALYST_PREFIX}runs/`,
        limit: Math.max(1, Math.min(500, Number(limit) || 60)),
      })
      const ordered = (result?.blobs || [])
        .sort((left, right) =>
          String(right.pathname).localeCompare(String(left.pathname))
        )
        .slice(0, limit)
      return (await Promise.all(
        ordered.map((item) => storage.readJson(item.pathname)),
      )).filter(Boolean)
    },
    async saveOutcome(outcome) {
      const tradeDate = safeDate(outcome?.tradeDate)
      const key = safeId(
        `${outcome?.eventId || 'event'}:${outcome?.code || 'stock'}`,
      )
      if (!key) throw new Error('预催化结果标识无效')
      const path =
        `${PRE_CATALYST_PREFIX}outcomes/${tradeDate}/${key}.json`
      if (!storage.hasStorage()) {
        memory.outcomes.set(path, outcome)
        return outcome
      }
      try {
        await write(path, outcome, { forbidOverwrite: true })
      } catch (error) {
        if (!isConflict(error)) throw error
      }
      return outcome
    },
    async listOutcomes(limit = 1000) {
      if (!storage.hasStorage()) {
        return [...memory.outcomes.values()].slice(0, limit)
      }
      const result = await storage.list({
        prefix: `${PRE_CATALYST_PREFIX}outcomes/`,
        limit: Math.max(1, Math.min(5000, Number(limit) || 1000)),
      })
      return (await Promise.all(
        (result?.blobs || []).map((item) =>
          storage.readJson(item.pathname)
        ),
      )).filter(Boolean)
    },
    async readEvaluation() {
      if (!storage.hasStorage()) return memory.evaluation
      return storage.readJson(`${PRE_CATALYST_PREFIX}evaluation.json`)
        .catch(() => null)
    },
    async saveEvaluation(evaluation) {
      if (!storage.hasStorage()) {
        memory.evaluation = evaluation
        return evaluation
      }
      return write(
        `${PRE_CATALYST_PREFIX}evaluation.json`,
        evaluation,
      )
    },
  }
}

export const preCatalystStore = createPreCatalystStore()
