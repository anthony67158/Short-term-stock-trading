import {
  hasStorage,
  put,
  readJson,
} from './_blob.js'

export const OPPORTUNITY_RADAR_LEDGER_PREFIX =
  'market/opportunity-radar/v1/'

const memoryBatches = new Map()

function safeDate(value) {
  const date = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('机会雷达账本日期无效')
  }
  return date
}

function safeMode(value) {
  const mode = String(value || '').toLowerCase()
  if (!['intraday', 'close'].includes(mode)) {
    throw new Error('机会雷达账本模式无效')
  }
  return mode
}

function safeSlot(value) {
  const slot = String(value || 'manual')
  if (!/^(?:\d{4}|manual)$/.test(slot)) {
    throw new Error('机会雷达账本时段无效')
  }
  return slot
}

function batchPath({ tradeDate, mode, slot }) {
  return `${OPPORTUNITY_RADAR_LEDGER_PREFIX}events/`
    + `${safeDate(tradeDate)}/${safeMode(mode)}-${safeSlot(slot)}.json`
}

function jsonOptions() {
  return {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
    forbidOverwrite: true,
  }
}

function conflict(error) {
  return error?.status === 409
    || ['FileAlreadyExists', 'ObjectAlreadyExists']
      .includes(error?.code)
}

export function createOpportunityRadarLedgerStore(storage = {
  hasStorage,
  put,
  readJson,
}) {
  return {
    async saveBatch(value) {
      const path = batchPath(value || {})
      if (!storage.hasStorage()) {
        const current = memoryBatches.get(path)
        if (current) return current
        memoryBatches.set(path, value)
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
    async readBatch(input = {}) {
      const path = batchPath(input)
      if (!storage.hasStorage()) return memoryBatches.get(path) || null
      return storage.readJson(path).catch(() => null)
    },
  }
}

export const opportunityRadarLedgerStore =
  createOpportunityRadarLedgerStore()
