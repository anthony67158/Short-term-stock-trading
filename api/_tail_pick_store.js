import {
  del,
  hasStorage,
  put,
  readJson,
} from './_blob.js'

export const TAIL_PICK_PREFIX = 'market/tail-pick/v1/'

const PATHS = Object.freeze({
  latest: `${TAIL_PICK_PREFIX}latest.json`,
  task: `${TAIL_PICK_PREFIX}task.json`,
  runs: `${TAIL_PICK_PREFIX}runs/`,
  locks: `${TAIL_PICK_PREFIX}locks/`,
})

let memoryLatest = null
let memoryTask = null

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
    async claimRun(tradeDate, now = Date.now()) {
      if (!storage.hasStorage()) {
        if (
          memoryTask?.status === 'RUNNING'
          && memoryTask.tradeDate === tradeDate
        ) return { acquired: false, path: '' }
        return { acquired: true, path: '' }
      }
      const path = `${PATHS.locks}${safeTradeDate(tradeDate)}-1450.json`
      try {
        await writeJson(path, {
          tradeDate,
          claimedAt: Number(now) || Date.now(),
        }, { forbidOverwrite: true })
        return { acquired: true, path }
      } catch (error) {
        if (
          error?.status === 409
          || [
            'FileAlreadyExists',
            'ObjectAlreadyExists',
            'PositionNotEqualToLength',
          ].includes(error?.code)
        ) return { acquired: false, path }
        throw error
      }
    },
    async releaseRun(claim) {
      if (!claim?.acquired || !claim.path || !storage.hasStorage()) {
        return false
      }
      await storage.del(claim.path)
      return true
    },
  }
}

export const tailPickStore = createTailPickStore()
