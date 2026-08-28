import { emGetOne } from './_lib.js'
import { fetchMarketSnapshot } from './market.js'
import {
  fetchKlineTx,
  fetchTrendsTx,
} from './stock_detail.js'
import { fetchStockFund } from './_stock_fund.js'
import { fetchStockTagProfile } from './stock_tags.js'
import { sectorForecastStore } from './_sector_forecast_store.js'
import { buildSectorOpportunity } from '../shared/sectorOpportunity.js'
import {
  evaluateTailPickSignal,
} from '../shared/tailPickFormula.js'
import {
  evaluateTailPickIntraday,
  evaluateTailPickMarketGate,
  evaluateTailPickStockGate,
} from '../shared/tailPickPolicy.js'
import { beijingDayKey } from '../shared/tradingCalendar.js'

const MARKET_FS =
  'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'
const MARKET_FIELDS =
  'f2,f3,f5,f6,f8,f12,f14,f15,f16,f17,f18,f20,f62,f184,f124'
const MIN_FORMULA_GAIN_PCT = 2.4
const MAX_MARKET_PAGES = 30

function finite(value) {
  if (value == null || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function quoteDate(value) {
  const seconds = finite(value)
  return seconds && seconds > 1_000_000_000
    ? beijingDayKey(seconds * 1000)
    : null
}

export function mapTailPickMarketRow(row = {}) {
  return {
    code: String(row.f12 || ''),
    name: String(row.f14 || ''),
    price: finite(row.f2),
    pct: finite(row.f3),
    volume: finite(row.f5),
    amount: finite(row.f6),
    turnover: finite(row.f8),
    high: finite(row.f15),
    low: finite(row.f16),
    open: finite(row.f17),
    prevClose: finite(row.f18),
    totalMarketCap: finite(row.f20),
    mainInflow: finite(row.f62),
    mainRatio: finite(row.f184),
    tradeDate: quoteDate(row.f124),
  }
}

export function passesTailPickRealtimePrefilter(
  quote = {},
  expectedTradeDate = beijingDayKey(),
) {
  if (
    !/^\d{6}$/.test(quote.code)
    || /ST|退/.test(String(quote.name || '').toUpperCase())
    || /^(68|8|4|9)/.test(quote.code)
  ) return false
  if (quote.tradeDate !== expectedTradeDate) return false
  const {
    price,
    open,
    high,
    low,
    volume,
    amount,
    turnover,
  } = quote
  if (
    [price, open, high, low, volume, amount, turnover]
      .some((value) => finite(value) == null)
  ) return false
  return (
    quote.pct > MIN_FORMULA_GAIN_PCT
    && amount >= 50_000_000
    && turnover > 5
    && open < price
    && high - price > (open - low) * 1.5
    && high / open > 1.01
    && high / open < 1.09
    && high / price < 1.06
  )
}

function marketPagePath(page) {
  return `/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1`
    + '&fltt=2&invt=2&fid=f3'
    + `&fs=${encodeURIComponent(MARKET_FS)}`
    + `&fields=${MARKET_FIELDS}`
}

export async function fetchTailPickRealtimePool({
  fetchPage = (page) => emGetOne(
    marketPagePath(page),
    { hostIndex: page, maxAttempts: 4 },
  ),
  now = Date.now(),
} = {}) {
  const rows = []
  let total = 0
  let pagesRead = 0
  let boundaryReached = false
  for (let page = 1; page <= MAX_MARKET_PAGES; page++) {
    const payload = await fetchPage(page)
    const diff = Array.isArray(payload?.data?.diff)
      ? payload.data.diff
      : []
    if (page === 1) total = Number(payload?.data?.total) || diff.length
    pagesRead = page
    if (!diff.length) {
      boundaryReached = true
      break
    }
    rows.push(...diff.map((item) => mapTailPickMarketRow(item)))
    const lastPct = finite(diff.at(-1)?.f3)
    if (lastPct == null || lastPct <= MIN_FORMULA_GAIN_PCT) {
      boundaryReached = true
      break
    }
  }
  if (!boundaryReached) {
    throw new Error('全市场涨幅分页未读取到2.4%边界')
  }
  const unique = [...new Map(
    rows.filter((item) => item.code).map((item) => [item.code, item]),
  ).values()]
  return {
    total,
    pagesRead,
    inspectedCount: unique.length,
    list: unique.filter((item) =>
      passesTailPickRealtimePrefilter(item, beijingDayKey(now))
    ),
  }
}

export function parseTailPickIndexCandles(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const parts = Array.isArray(row) ? row : String(row).split(',')
      return {
        date: parts[0],
        open: finite(parts[1]),
        close: finite(parts[2]),
        high: finite(parts[3]),
        low: finite(parts[4]),
        volume: finite(parts[5]),
      }
    })
    .filter((item) => item.date && item.close > 0)
}

async function fetchTencentIndexKline(symbol) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(
      'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
        + `?param=${symbol},day,,,60,qfq&_=${Date.now()}`,
      {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://gu.qq.com/',
        },
      },
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    const node = payload?.data?.[symbol]
    const rows = node?.qfqday || node?.day || []
    if (!Array.isArray(rows) || rows.length < 60) {
      throw new Error('指数日线不足60日')
    }
    return parseTailPickIndexCandles(rows)
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchTailPickIndexSeries() {
  const indices = [
    { code: '000001', name: '上证指数', symbol: 'sh000001' },
    { code: '399001', name: '深证成指', symbol: 'sz399001' },
  ]
  return Promise.all(indices.map(async (item) => {
    return {
      code: item.code,
      name: item.name,
      candles: await fetchTencentIndexKline(item.symbol),
    }
  }))
}

function usableSectorSnapshot(latest, intraday, now = Date.now()) {
  return [intraday, latest]
    .filter((item) =>
      item
      && Array.isArray(item.sectors)
      && item.sectors.length > 0
      && Number(item.generatedAt) > 0
      && now - Number(item.generatedAt) <= 72 * 60 * 60 * 1000
    )
    .sort((left, right) =>
      Number(right.generatedAt || 0) - Number(left.generatedAt || 0)
    )[0] || null
}

export async function collectTailPickMarketContext({
  fetchMarket = fetchMarketSnapshot,
  fetchIndices = fetchTailPickIndexSeries,
  store = sectorForecastStore,
  now = Date.now(),
} = {}) {
  const [market, indexSeries, latest, intraday] = await Promise.all([
    fetchMarket(),
    fetchIndices(),
    store.readLatest(),
    store.readIntraday(),
  ])
  const sectorSnapshot = usableSectorSnapshot(latest, intraday, now)
  return {
    market,
    indexSeries,
    latest,
    intraday,
    sectorSnapshot,
    marketGate: evaluateTailPickMarketGate({
      market,
      indexSeries,
      sectorSnapshot,
    }),
  }
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

function sectorOpportunityFromTags({
  code,
  profile,
  latest,
  intraday,
  now,
}) {
  const direct = buildSectorOpportunity({
    code,
    latest,
    intraday,
    now,
  })
  if (direct.matched) return direct
  const snapshot = usableSectorSnapshot(latest, intraday, now)
  const conceptCodes = new Set(
    (profile?.conceptBoards || []).map((item) => String(item.code)),
  )
  const names = new Set([
    profile?.industry,
    ...(profile?.concepts || []),
  ].filter(Boolean).map(String))
  const matches = (snapshot?.sectors || [])
    .filter((sector) =>
      conceptCodes.has(String(sector.code))
      || names.has(String(sector.name))
    )
    .sort((left, right) =>
      Number(left.rank || 999) - Number(right.rank || 999)
    )
  const sector = matches[0]
  if (!sector) return direct
  return {
    matched: true,
    probeEligible: sector.actionability === 'LAYOUT',
    entryMode: sector.actionability === 'LAYOUT'
      ? 'MANUAL_PROBE'
      : sector.actionability === 'WAIT_PULLBACK'
        ? 'WAIT_PULLBACK'
        : 'NONE',
    signalDate: snapshot.signalDate,
    generatedAt: snapshot.generatedAt,
    sourceSession: snapshot.session,
    sector: {
      code: String(sector.code || ''),
      name: String(sector.name || ''),
      rank: finite(sector.rank),
      phase: String(sector.phase || ''),
      actionability: String(sector.actionability || ''),
      nextScore: finite(sector.forecast?.next?.score),
      weekScore: finite(sector.forecast?.week?.score),
      breadth: finite(sector.breadth?.inflowPct),
      reasons: (sector.reasons || []).slice(0, 4),
      risks: (sector.risks || []).slice(0, 4),
    },
    stock: {
      code,
      name: profile?.name || '',
      role: 'member',
      roleLabel: '板块成员',
      score: finite(sector.forecast?.layout?.score)
        ?? finite(sector.forecast?.next?.score),
    },
  }
}

export async function scanTailPickCandidates({
  marketContext,
  fetchPool = fetchTailPickRealtimePool,
  fetchKline = fetchKlineTx,
  fetchTrends = fetchTrendsTx,
  fetchFund = fetchStockFund,
  fetchTags = fetchStockTagProfile,
  now = Date.now(),
} = {}) {
  const universe = await fetchPool({ now })
  const daily = await mapLimit(
    universe.list,
    12,
    async (quote) => {
      const kline = await fetchKline(quote.code, '101', 40)
        .catch(() => null)
      if (!kline?.candles?.length) return null
      const formula = evaluateTailPickSignal({
        candles: kline.candles,
        quote,
        turnover: quote.turnover,
      })
      return {
        code: quote.code,
        name: quote.name || kline.name,
        quote,
        candles: kline.candles,
        formula,
      }
    },
  )
  const formulaMatches = daily.filter((item) => item?.formula?.matched)
  const enriched = await mapLimit(
    formulaMatches,
    8,
    async (item) => {
      const [trendsResult, fundResult, tagResult] =
        await Promise.allSettled([
          fetchTrends(item.code),
          fetchFund(item.code, {
            preferRealtime: true,
            fetchedAt: now,
          }),
          fetchTags(item.code, undefined, now),
        ])
      const trends = trendsResult.status === 'fulfilled'
        ? trendsResult.value?.trends
        : []
      const intraday = evaluateTailPickIntraday(trends)
      const profile = tagResult.status === 'fulfilled'
        ? tagResult.value
        : null
      const sectorOpportunity = sectorOpportunityFromTags({
        code: item.code,
        profile,
        latest: marketContext.latest,
        intraday: marketContext.intraday,
        now,
      })
      const stockGate = evaluateTailPickStockGate({
        code: item.code,
        name: item.name,
        candles: item.candles,
        quote: item.quote,
        sectorOpportunity,
        intraday,
      })
      return {
        ...item,
        intraday,
        fund: fundResult.status === 'fulfilled'
          ? fundResult.value
          : null,
        tags: profile,
        sectorOpportunity,
        stockGate,
      }
    },
  )
  return {
    universe: {
      total: universe.total,
      pagesRead: universe.pagesRead,
      inspectedCount: universe.inspectedCount,
      realtimePrefilterCount: universe.list.length,
      formulaMatchCount: formulaMatches.length,
      disciplinePassCount: enriched.filter(
        (item) => item.stockGate.passed,
      ).length,
    },
    candidates: enriched,
  }
}
