import {
  hasStorage,
  list,
  put,
  readJson,
} from './_blob.js'
import {
  OPPORTUNITY_RADAR_LEDGER_PREFIX,
} from './_opportunity_radar_ledger_store.js'

export const OPPORTUNITY_RADAR_OUTCOME_PREFIX =
  `${OPPORTUNITY_RADAR_LEDGER_PREFIX}outcomes/`

const memoryOutcomes = new Map()

function safeDate(value) {
  const date = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('机会雷达结果日期无效')
  }
  return date
}

function safeMode(value) {
  const mode = String(value || '').toLowerCase()
  if (!['intraday', 'close'].includes(mode)) {
    throw new Error('机会雷达结果模式无效')
  }
  return mode
}

function safeSlot(value) {
  const slot = String(value || 'manual')
  if (!/^(?:\d{4}|manual)$/.test(slot)) {
    throw new Error('机会雷达结果时段无效')
  }
  return slot
}

function safeCode(value) {
  const code = String(value || '')
  if (!/^\d{6}$/.test(code)) {
    throw new Error('机会雷达结果股票代码无效')
  }
  return code
}

function outcomePath({ tradeDate, mode, slot, code }) {
  return `${OPPORTUNITY_RADAR_OUTCOME_PREFIX}${safeDate(tradeDate)}/`
    + `${safeMode(mode)}-${safeSlot(slot)}/${safeCode(code)}.json`
}

function conflict(error) {
  return error?.status === 409
    || ['FileAlreadyExists', 'ObjectAlreadyExists']
      .includes(error?.code)
}

function jsonOptions() {
  return {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
    forbidOverwrite: true,
  }
}

export function createOpportunityRadarOutcomeStore(storage = {
  hasStorage,
  list,
  put,
  readJson,
}) {
  return {
    async saveOutcome(value) {
      if (value?.maturity !== 'MATURED') {
        throw new Error('机会雷达只持久化成熟结果')
      }
      const path = outcomePath(value || {})
      if (!storage.hasStorage()) {
        const current = memoryOutcomes.get(path)
        if (current) return current
        memoryOutcomes.set(path, value)
        return value
      }
      try {
        await storage.put(path, JSON.stringify(value), jsonOptions())
        return value
      } catch (error) {
        if (!conflict(error)) throw error
        const current = await storage.readJson(path)
        if (!current) throw error
        return current
      }
    },
    async readOutcome(input = {}) {
      const path = outcomePath(input)
      if (!storage.hasStorage()) return memoryOutcomes.get(path) || null
      return storage.readJson(path).catch(() => null)
    },
    async listOutcomes({
      tradeDate,
      mode,
      slot,
      limit = 10000,
    } = {}) {
      const prefix =
        `${OPPORTUNITY_RADAR_OUTCOME_PREFIX}${safeDate(tradeDate)}/`
        + `${safeMode(mode)}-${safeSlot(slot)}/`
      const maximum = Math.max(1, Math.min(
        10000,
        Number(limit) || 10000,
      ))
      if (!storage.hasStorage()) {
        return [...memoryOutcomes.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, maximum)
          .map(([, value]) => value)
      }
      if (typeof storage.list !== 'function') {
        throw new Error('机会雷达结果存储不支持枚举')
      }
      const { blobs = [] } = await storage.list({
        prefix,
        limit: maximum,
      })
      const outcomes = await Promise.all(blobs.map((blob) =>
        storage.readJson(blob.pathname || blob).catch(() => null),
      ))
      return outcomes.filter(Boolean)
    },
  }
}

export const opportunityRadarOutcomeStore =
  createOpportunityRadarOutcomeStore()
