import { beijingDayKey } from '../shared/tradingCalendar.js'

export const FUYAO_BASE_URL = 'https://fuyao.aicubes.cn'
export const FUYAO_SOURCE = '同花顺扶摇'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function positive(value) {
  const number = finite(value)
  return number != null && number > 0 ? number : null
}

function apiKey(env) {
  return String(env?.FUYAO_API_KEY || '').trim()
}

export function fuyaoConfigured(env = process.env) {
  return apiKey(env).length > 0
}

export function toFuyaoThscode(code) {
  const normalized = String(code || '').trim()
  if (!/^\d{6}$/.test(normalized)) return null
  if (/^(4|8|92)/.test(normalized)) return `${normalized}.BJ`
  if (/^(5|6|9)/.test(normalized)) return `${normalized}.SH`
  return `${normalized}.SZ`
}

function endpoint(path, query = {}) {
  const url = new URL(path, FUYAO_BASE_URL)
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url
}

async function requestFuyao(
  path,
  query,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5000,
  } = {},
) {
  const key = apiKey(env)
  if (!key) return null
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1000, Number(timeoutMs) || 5000),
  )
  try {
    const response = await fetchImpl(endpoint(path, query), {
      headers: {
        Accept: 'application/json',
        'X-api-key': key,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`扶摇行情HTTP ${response.status}`)
    }
    const payload = await response.json()
    if (Number(payload?.code) !== 0) {
      const code = Number.isFinite(Number(payload?.code))
        ? Number(payload.code)
        : 'UNKNOWN'
      throw new Error(`扶摇行情业务错误 ${code}`)
    }
    if (!payload?.data || !Array.isArray(payload.data.item)) {
      throw new Error('扶摇行情响应结构无效')
    }
    return payload.data
  } finally {
    clearTimeout(timer)
  }
}

export function mapFuyaoQuote(row = {}, timestamp = null) {
  const volume = positive(row.volume)
  const amount = positive(row.turnover)
  return {
    code: String(row.ticker || '').trim(),
    name: '',
    source: FUYAO_SOURCE,
    price: positive(row.last_price),
    pct: finite(row.price_change_ratio_pct),
    chg: finite(row.price_change),
    turnover: null,
    volRatio: null,
    mainInflow: null,
    retailInflow: null,
    main5dInflow: null,
    retail5dInflow: null,
    mainRatio: null,
    volume,
    amount,
    vwap: volume && amount ? amount / volume : null,
    high: positive(row.high_price),
    low: positive(row.low_price),
    open: positive(row.open_price),
    prevClose: positive(row.prev_price),
    tradeDate: finite(timestamp) != null
      ? beijingDayKey(Number(timestamp))
      : null,
    industry: null,
    thscode: String(row.thscode || '').trim() || null,
  }
}

export async function fetchFuyaoQuotes(
  codes,
  options = {},
) {
  const normalized = [...new Set(
    (Array.isArray(codes) ? codes : [])
      .map(toFuyaoThscode)
      .filter(Boolean),
  )]
  if (!normalized.length || !fuyaoConfigured(options.env)) return []
  const chunks = []
  for (let index = 0; index < normalized.length; index += 100) {
    chunks.push(normalized.slice(index, index + 100))
  }
  const responses = await Promise.all(chunks.map((chunk) =>
    requestFuyao(
      '/api/a-share/prices/snapshot',
      { thscodes: chunk.join(',') },
      options,
    )
  ))
  return responses.flatMap((data) =>
    (data?.item || []).map((row) =>
      mapFuyaoQuote(row, data.timestamp)
    )
  )
}

function historicalWindow(limit, now) {
  const end = Number(now) || Date.now()
  const days = Math.min(3650, Math.max(45, limit * 3))
  return {
    start: end - days * 24 * 60 * 60 * 1000,
    end,
  }
}

export async function fetchFuyaoDailyKline(
  code,
  klt = '101',
  limit = 120,
  options = {},
) {
  if (String(klt) !== '101' || !fuyaoConfigured(options.env)) {
    return null
  }
  const thscode = toFuyaoThscode(code)
  if (!thscode) return null
  const boundedLimit = Math.max(
    1,
    Math.min(500, Math.trunc(Number(limit) || 120)),
  )
  const window = historicalWindow(boundedLimit, options.now)
  const data = await requestFuyao(
    '/api/a-share/prices/historical',
    {
      thscode,
      interval: '1d',
      start: window.start,
      end: window.end,
      adjust: 'forward',
    },
    options,
  )
  const candles = (data?.item || [])
    .map((row) => ({
      date: finite(row.date_ms) != null
        ? beijingDayKey(Number(row.date_ms))
        : '',
      open: positive(row.open_price),
      close: positive(row.close_price),
      high: positive(row.high_price),
      low: positive(row.low_price),
      volume: positive(row.volume) || 0,
      amount: positive(row.turnover) || 0,
      pct: 0,
      turnover: null,
    }))
    .filter((row) =>
      row.date
      && row.open > 0
      && row.close > 0
      && row.high > 0
      && row.low > 0
    )
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-boundedLimit)
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1].close
    candles[index].pct = previous > 0
      ? +(((candles[index].close / previous) - 1) * 100).toFixed(2)
      : 0
  }
  return candles.length
    ? {
        name: '',
        candles,
        source: FUYAO_SOURCE,
      }
    : null
}
