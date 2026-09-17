// 选股快照持久化：OSS 存储 + 无存储时内存回退（对齐 tail_pick/opportunity 范式）。
import {
  del,
  hasStorage,
  put,
  readJson,
} from './_blob.js'

const PREFIX = 'stockpick/'
const PATHS = Object.freeze({
  latest: `${PREFIX}latest.json`,
  progress: `${PREFIX}progress.json`,
  lock: `${PREFIX}active.json`,
})
const CLAIM_TTL_MS = 3 * 60 * 1000

function jsonOptions() {
  return {
    access: 'public',
    contentType: 'application/json',
    cacheControlMaxAge: 0,
    addRandomSuffix: false,
  }
}

let memoryLatest = null
let memoryProgress = null
let memoryClaim = null

export function createStockPickStore(storage = {
  del,
  hasStorage,
  put,
  readJson,
}) {
  const writeJson = async (path, value) => {
    if (!storage.hasStorage()) return value
    await storage.put(path, JSON.stringify(value), jsonOptions())
    return value
  }
  return {
    paths: PATHS,
    async readLatest() {
      if (!storage.hasStorage()) return memoryLatest
      return storage.readJson(PATHS.latest).catch(() => null)
    },
    async saveLatest(snapshot) {
      if (!storage.hasStorage()) {
        memoryLatest = snapshot
        return snapshot
      }
      return writeJson(PATHS.latest, snapshot)
    },
    async readProgress() {
      if (!storage.hasStorage()) return memoryProgress
      return storage.readJson(PATHS.progress).catch(() => null)
    },
    async saveProgress(progress) {
      if (!storage.hasStorage()) {
        memoryProgress = progress
        return progress
      }
      return writeJson(PATHS.progress, progress)
    },
    // 单飞锁：避免同一账户并发全市场扫描重复计费。
    async claimRun(now = Date.now()) {
      const timestamp = Number(now) || Date.now()
      if (!storage.hasStorage()) {
        if (
          memoryClaim
          && timestamp - memoryClaim.claimedAt < CLAIM_TTL_MS
        ) return { acquired: false }
        memoryClaim = { claimedAt: timestamp }
        return { acquired: true }
      }
      const existing = await storage.readJson(PATHS.lock).catch(() => null)
      if (
        existing
        && timestamp - Number(existing.claimedAt || 0) < CLAIM_TTL_MS
      ) return { acquired: false }
      await writeJson(PATHS.lock, { claimedAt: timestamp })
      return { acquired: true }
    },
    async releaseRun() {
      if (!storage.hasStorage()) {
        memoryClaim = null
        return
      }
      await storage.del(PATHS.lock).catch(() => {})
    },
  }
}

export const stockPickStore = createStockPickStore()
