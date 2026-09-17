// 选股快照持久化：OSS 存储 + 无存储时内存回退（对齐 tail_pick/opportunity 范式）。
import {
  del,
  hasStorage,
  put,
  readJson,
} from './_blob.js'
import { createHash } from 'node:crypto'
import {
  STOCK_PICK_MODE,
  normalizeStockPickMode,
} from '../shared/stockPickModes.js'

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
const memoryAgents = new Map()
const memoryAgentProgress = new Map()
const memoryNextDaySelections = new Map()
const memoryAgentClaims = new Map()

function scopeKey(scope = '') {
  const value = String(scope || '').trim()
  if (!value) return 'global'
  return createHash('sha256').update(`stock-pick:${value}`).digest('hex').slice(0, 24)
}

function scopedPath(scope, suffix) {
  return `${PREFIX}accounts/${scopeKey(scope)}/${suffix}`
}

function agentKey(mode, scope) {
  return `${scopeKey(scope)}:${normalizeStockPickMode(mode)}`
}

function agentPath(mode, scope) {
  return scopedPath(
    scope,
    `agent-${normalizeStockPickMode(mode).toLowerCase()}.json`,
  )
}

function agentProgressPath(mode, scope) {
  return scopedPath(
    scope,
    `agent-progress-${normalizeStockPickMode(mode).toLowerCase()}.json`,
  )
}

function agentLockPath(mode, scope) {
  return scopedPath(
    scope,
    `agent-active-${normalizeStockPickMode(mode).toLowerCase()}.json`,
  )
}

function nextDaySelectionPath(scope) {
  return scopedPath(scope, 'next-day-selection.json')
}

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
    async readAgent(mode = STOCK_PICK_MODE.INTRADAY, scope = '') {
      const key = agentKey(mode, scope)
      if (!storage.hasStorage()) return memoryAgents.get(key) || null
      return storage.readJson(agentPath(mode, scope)).catch(() => null)
    },
    async saveAgent(
      selection,
      mode = STOCK_PICK_MODE.INTRADAY,
      scope = '',
    ) {
      const key = agentKey(mode, scope)
      if (!storage.hasStorage()) {
        memoryAgents.set(key, selection)
        return selection
      }
      return writeJson(agentPath(mode, scope), selection)
    },
    async readAgentProgress(mode = STOCK_PICK_MODE.INTRADAY, scope = '') {
      const key = agentKey(mode, scope)
      if (!storage.hasStorage()) return memoryAgentProgress.get(key) || null
      return storage.readJson(agentProgressPath(mode, scope)).catch(() => null)
    },
    async saveAgentProgress(
      progress,
      mode = STOCK_PICK_MODE.INTRADAY,
      scope = '',
    ) {
      const key = agentKey(mode, scope)
      if (!storage.hasStorage()) {
        memoryAgentProgress.set(key, progress)
        return progress
      }
      return writeJson(agentProgressPath(mode, scope), progress)
    },
    async readNextDaySelection(scope = '') {
      const key = scopeKey(scope)
      if (!storage.hasStorage()) {
        return memoryNextDaySelections.get(key) || null
      }
      return storage.readJson(nextDaySelectionPath(scope)).catch(() => null)
    },
    async saveNextDaySelection(selection, scope = '') {
      const key = scopeKey(scope)
      if (!storage.hasStorage()) {
        memoryNextDaySelections.set(key, selection)
        return selection
      }
      return writeJson(nextDaySelectionPath(scope), selection)
    },
    async claimAgentRun({
      mode = STOCK_PICK_MODE.INTRADAY,
      scope = '',
      runKey = '',
      now = Date.now(),
    } = {}) {
      const timestamp = Number(now) || Date.now()
      const key = agentKey(mode, scope)
      if (!storage.hasStorage()) {
        const existing = memoryAgentClaims.get(key)
        if (
          existing
          && timestamp - Number(existing.claimedAt || 0) < CLAIM_TTL_MS
        ) return { acquired: false, active: existing }
        const claim = { claimedAt: timestamp, runKey: String(runKey || '') }
        memoryAgentClaims.set(key, claim)
        return { acquired: true, active: claim }
      }
      const path = agentLockPath(mode, scope)
      const existing = await storage.readJson(path).catch(() => null)
      if (
        existing
        && timestamp - Number(existing.claimedAt || 0) < CLAIM_TTL_MS
      ) return { acquired: false, active: existing }
      const claim = { claimedAt: timestamp, runKey: String(runKey || '') }
      await writeJson(path, claim)
      return { acquired: true, active: claim }
    },
    async releaseAgentRun(mode = STOCK_PICK_MODE.INTRADAY, scope = '') {
      const key = agentKey(mode, scope)
      if (!storage.hasStorage()) {
        memoryAgentClaims.delete(key)
        return
      }
      await storage.del(agentLockPath(mode, scope)).catch(() => {})
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
