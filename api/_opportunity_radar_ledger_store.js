import {
  hasStorage,
  list,
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

function dateRange(from, to, maximumDays = 61) {
  const start = new Date(`${safeDate(from)}T00:00:00.000Z`)
  const end = new Date(`${safeDate(to)}T00:00:00.000Z`)
  if (start > end) throw new Error('机会雷达账本日期范围无效')
  const dates = []
  for (
    let value = start.getTime();
    value <= end.getTime() && dates.length < maximumDays;
    value += 24 * 60 * 60 * 1000
  ) {
    dates.push(new Date(value).toISOString().slice(0, 10))
  }
  return dates
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
  list,
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
    async listBatches({
      from,
      to,
      limit = 5000,
    } = {}) {
      const maximum = Math.max(1, Math.min(5000, Number(limit) || 5000))
      const dates = dateRange(from, to)
      if (!storage.hasStorage()) {
        return [...memoryBatches.entries()]
          .filter(([path]) => dates.some((date) =>
            path.startsWith(
              `${OPPORTUNITY_RADAR_LEDGER_PREFIX}events/${date}/`,
            ),
          ))
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, maximum)
          .map(([, value]) => value)
      }
      if (typeof storage.list !== 'function') {
        throw new Error('机会雷达账本存储不支持枚举')
      }
      const refs = []
      for (const date of dates) {
        if (refs.length >= maximum) break
        const { blobs = [] } = await storage.list({
          prefix:
            `${OPPORTUNITY_RADAR_LEDGER_PREFIX}events/${date}/`,
          limit: maximum - refs.length,
        })
        refs.push(...blobs)
      }
      const batches = await Promise.all(refs.map((blob) =>
        storage.readJson(blob.pathname || blob).catch(() => null),
      ))
      return batches
        .filter(Boolean)
        .sort((left, right) =>
          Number(left.generatedAt || 0) - Number(right.generatedAt || 0),
        )
    },
  }
}

export const opportunityRadarLedgerStore =
  createOpportunityRadarLedgerStore()
