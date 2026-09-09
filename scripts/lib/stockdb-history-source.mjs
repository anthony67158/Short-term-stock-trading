import {
  normalizeDailyRow,
  normalizeFundRow,
  normalizeMinuteRow,
  normalizeStockDbRows,
} from './stockdb-replay.mjs'

export const ASHARE_CODE_PREFIXES = Object.freeze([
  '0*',
  '3*',
  '6*',
  '920*',
])

export const STOCKDB_DAILY_FIELDS = Object.freeze([
  'date',
  'code',
  'name',
  'open',
  'high',
  'low',
  'close',
  'pre_close',
  'volume',
  'amount',
  'turnover_rate',
  'vol_ratio',
  'float_share',
  'is_st',
])

export const STOCKDB_MINUTE_FIELDS = Object.freeze([
  'date',
  'code',
  'name',
  'open',
  'high',
  'low',
  'close',
  'pre_close',
  'volume',
  'amount',
])

function compactDate(value) {
  const date = String(value || '').replaceAll('-', '')
  if (!/^\d{8}$/.test(date)) {
    throw new Error('StockDB历史日期无效')
  }
  return date
}

function rowsOf(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  if (Array.isArray(value?.result)) return value.result
  throw new Error('StockDB响应结构无效')
}

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  const workers = Array.from({
    length: Math.min(concurrency, items.length),
  }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return output
}

export class StockDbHistorySource {
  constructor(client, {
    prefixes = ASHARE_CODE_PREFIXES,
    concurrency = 2,
  } = {}) {
    if (!client || typeof client.values !== 'function') {
      throw new Error('StockDB历史数据源缺少只读客户端')
    }
    this.client = client
    this.prefixes = [...prefixes]
    this.concurrency = Math.max(1, Math.min(2, Number(concurrency) || 1))
  }

  async #readPrefixes(table, dateQuery, fields = []) {
    const groups = await mapLimit(
      this.prefixes,
      this.concurrency,
      async (prefix) => rowsOf(
        await this.client.values(table, prefix, dateQuery, fields),
      ),
    )
    return groups.flat()
  }

  async dailyRange(from, to) {
    const start = compactDate(from)
    const end = compactDate(to)
    if (start > end) throw new Error('StockDB日线日期范围无效')
    const raw = await this.#readPrefixes(
      '日k',
      start === end ? start : `${start}<${end}`,
      STOCKDB_DAILY_FIELDS,
    )
    return normalizeStockDbRows(raw, STOCKDB_DAILY_FIELDS)
      .map(normalizeDailyRow)
      .filter(Boolean)
  }

  async fundRange(from, to) {
    const start = compactDate(from)
    const end = compactDate(to)
    if (start > end) throw new Error('StockDB资金日期范围无效')
    const raw = await this.#readPrefixes(
      '资金流',
      start === end ? start : `${start}<${end}`,
    )
    return raw.map(normalizeFundRow).filter(Boolean)
  }

  async minuteDay(tradeDate) {
    const date = compactDate(tradeDate)
    const raw = await this.#readPrefixes(
      '分钟k',
      `${date}093000<${date}150000`,
      STOCKDB_MINUTE_FIELDS,
    )
    return normalizeStockDbRows(raw, STOCKDB_MINUTE_FIELDS)
      .map(normalizeMinuteRow)
      .filter(Boolean)
  }
}

export function indexRowsByCode(rows = []) {
  const output = new Map()
  for (const row of rows) {
    const code = String(row?.code || '')
    if (!/^\d{6}$/.test(code)) continue
    if (!output.has(code)) output.set(code, [])
    output.get(code).push(row)
  }
  for (const values of output.values()) {
    values.sort((left, right) =>
      String(left.date || left.timestamp)
        .localeCompare(String(right.date || right.timestamp))
    )
  }
  return output
}
