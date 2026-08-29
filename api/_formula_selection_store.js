import { randomUUID } from 'node:crypto'
import {
  del,
  hasStorage,
  put,
  readJson,
} from './_blob.js'

export const FORMULA_SELECTION_PREFIX = 'market/formula-selection/v1/'

const memoryLatest = new Map()
const memoryClaims = new Map()
const CLAIM_TTL_MS = 3 * 60 * 1000

function safeMode(value) {
  const mode = String(value || '').toLowerCase()
  if (!['intraday', 'close'].includes(mode)) {
    throw new Error('公式选股模式无效')
  }
  return mode
}

function safeDate(value) {
  const date = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('公式选股日期无效')
  }
  return date
}

function options(extra = {}) {
  return {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
    ...extra,
  }
}

export function createFormulaSelectionStore(storage = {
  del,
  hasStorage,
  put,
  readJson,
}) {
  const write = async (path, value, extra = {}) => {
    if (!storage.hasStorage()) return value
    await storage.put(path, JSON.stringify(value), options(extra))
    return value
  }
  const latestPath = (mode) =>
    `${FORMULA_SELECTION_PREFIX}${safeMode(mode)}/latest.json`
  const runPath = (mode, date, slot) =>
    `${FORMULA_SELECTION_PREFIX}runs/${safeDate(date)}/`
      + `${safeMode(mode)}-${String(slot || 'manual')}.json`

  return {
    async readLatest(mode) {
      const normalized = safeMode(mode)
      if (!storage.hasStorage()) return memoryLatest.get(normalized) || null
      return storage.readJson(latestPath(normalized)).catch(() => null)
    },
    async saveRun(mode, value) {
      const normalized = safeMode(mode)
      const date = safeDate(value?.tradeDate)
      const slot = value?.slot || 'manual'
      if (!storage.hasStorage()) {
        memoryLatest.set(normalized, value)
        return value
      }
      await write(runPath(normalized, date, slot), value)
      await write(latestPath(normalized), value)
      return value
    },
    async claimRun(mode, date, slot = 'manual', now = Date.now()) {
      const normalized = safeMode(mode)
      const tradeDate = safeDate(date)
      const timestamp = Number(now) || Date.now()
      const owner = randomUUID()
      const key = `${tradeDate}:${normalized}:${slot}`
      const path =
        `${FORMULA_SELECTION_PREFIX}locks/${tradeDate}-${normalized}-${slot}.json`
      if (!storage.hasStorage()) {
        const current = memoryClaims.get(key)
        if (current && timestamp - current.claimedAt < CLAIM_TTL_MS) {
          return { acquired: false, path: '', key }
        }
        memoryClaims.set(key, { owner, claimedAt: timestamp })
        return { acquired: true, path: '', key, owner }
      }
      const payload = {
        mode: normalized,
        tradeDate,
        slot,
        owner,
        claimedAt: timestamp,
      }
      try {
        await write(path, payload, { forbidOverwrite: true })
        return { acquired: true, path, key, owner }
      } catch (error) {
        const conflict = error?.status === 409
          || ['FileAlreadyExists', 'ObjectAlreadyExists']
            .includes(error?.code)
        if (!conflict) throw error
        const current = await storage.readJson(path).catch(() => null)
        if (
          current?.claimedAt
          && timestamp - Number(current.claimedAt) < CLAIM_TTL_MS
        ) return { acquired: false, path, key }
        await storage.del(path)
        try {
          await write(path, payload, { forbidOverwrite: true })
          return { acquired: true, path, key, owner }
        } catch {
          return { acquired: false, path, key }
        }
      }
    },
    async releaseRun(claim) {
      if (!claim?.acquired) return false
      if (!storage.hasStorage()) {
        if (memoryClaims.get(claim.key)?.owner !== claim.owner) return false
        memoryClaims.delete(claim.key)
        return true
      }
      const current = await storage.readJson(claim.path).catch(() => null)
      if (current?.owner !== claim.owner) return false
      await storage.del(claim.path)
      return true
    },
  }
}

export const formulaSelectionStore = createFormulaSelectionStore()
