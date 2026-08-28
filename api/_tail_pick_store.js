import {
  del,
  hasStorage,
  put,
  readJson,
} from './_blob.js'
import { randomUUID } from 'node:crypto'

export const TAIL_PICK_PREFIX = 'market/tail-pick/v1/'

const PATHS = Object.freeze({
  latest: `${TAIL_PICK_PREFIX}latest.json`,
  manualLatest: `${TAIL_PICK_PREFIX}manual-latest.json`,
  task: `${TAIL_PICK_PREFIX}task.json`,
  runs: `${TAIL_PICK_PREFIX}runs/`,
  locks: `${TAIL_PICK_PREFIX}locks/`,
})

let memoryLatest = null
let memoryManualLatest = null
let memoryTask = null
let memoryClaim = null
const CLAIM_TTL_MS = 3 * 60 * 1000

function jsonOptions() {
  return {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  }
}

function safeTradeDate(value) {
  const date = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('尾盘选股交易日期无效')
  }
  return date
}

export function createTailPickStore(storage = {
  del,
  hasStorage,
  put,
  readJson,
}) {
  const writeJson = async (path, value, options = {}) => {
    if (!storage.hasStorage()) return value
    await storage.put(path, JSON.stringify(value), {
      ...jsonOptions(),
      ...options,
    })
    return value
  }
  return {
    paths: PATHS,
    runPath(tradeDate) {
      return `${PATHS.runs}${safeTradeDate(tradeDate)}/1450.json`
    },
    async readLatest() {
      if (!storage.hasStorage()) return memoryLatest
      return storage.readJson(PATHS.latest).catch(() => null)
    },
    async readRun(tradeDate) {
      if (!storage.hasStorage()) {
        return memoryLatest?.session?.tradeDate === tradeDate
          ? memoryLatest
          : null
      }
      return storage.readJson(this.runPath(tradeDate)).catch(() => null)
    },
    async readManualLatest() {
      if (!storage.hasStorage()) return memoryManualLatest
      return storage.readJson(PATHS.manualLatest).catch(() => null)
    },
    async saveRun(result) {
      const tradeDate = safeTradeDate(result?.session?.tradeDate)
      if (!storage.hasStorage()) {
        memoryLatest = result
        return result
      }
      await writeJson(this.runPath(tradeDate), result)
      await writeJson(PATHS.latest, result)
      return result
    },
    async saveManualRun(result) {
      if (!storage.hasStorage()) {
        memoryManualLatest = result
        return result
      }
      await writeJson(PATHS.manualLatest, result)
      return result
    },
    async readTask() {
      if (!storage.hasStorage()) return memoryTask
      return storage.readJson(PATHS.task).catch(() => null)
    },
    async saveTask(task) {
      if (!storage.hasStorage()) {
        memoryTask = task
        return task
      }
      return writeJson(PATHS.task, task)
    },
    async claimRun(tradeDate, now = Date.now(), mode = 'scheduled') {
      const timestamp = Number(now) || Date.now()
      const owner = randomUUID()
      if (!storage.hasStorage()) {
        if (
          memoryClaim?.tradeDate === tradeDate
          && timestamp - memoryClaim.claimedAt < CLAIM_TTL_MS
        ) return { acquired: false, path: '' }
        memoryClaim = { tradeDate, mode, claimedAt: timestamp, owner }
        return { acquired: true, path: '', owner }
      }
      const runMode = mode === 'manual' ? 'manual' : 'scheduled'
      const path = `${PATHS.locks}${safeTradeDate(tradeDate)}-active.json`
      const writeClaim = async () =>
        writeJson(path, {
          tradeDate,
          mode: runMode,
          claimedAt: timestamp,
          owner,
        }, { forbidOverwrite: true })
      try {
        await writeClaim()
        return { acquired: true, path, owner }
      } catch (firstError) {
        const conflict = firstError?.status === 409
          || [
            'FileAlreadyExists',
            'ObjectAlreadyExists',
            'PositionNotEqualToLength',
          ].includes(firstError?.code)
        if (!conflict) throw firstError
        const existing = await storage.readJson(path).catch(() => null)
        if (
          !existing?.claimedAt
          || timestamp - Number(existing.claimedAt) < CLAIM_TTL_MS
        ) return { acquired: false, path }
        await storage.del(path)
        try {
          await writeClaim()
          return { acquired: true, path, owner }
        } catch (retryError) {
          const retryConflict = retryError?.status === 409
            || [
              'FileAlreadyExists',
              'ObjectAlreadyExists',
              'PositionNotEqualToLength',
            ].includes(retryError?.code)
          if (retryConflict) return { acquired: false, path }
          throw retryError
        }
      }
    },
    async releaseRun(claim) {
      if (!claim?.acquired) return false
      if (!storage.hasStorage()) {
        if (memoryClaim?.owner !== claim.owner) return false
        memoryClaim = null
        return true
      }
      if (!claim.path || !claim.owner) {
        return false
      }
      const existing = await storage.readJson(claim.path).catch(() => null)
      if (existing?.owner !== claim.owner) return false
      await storage.del(claim.path)
      return true
    },
  }
}

export const tailPickStore = createTailPickStore()
