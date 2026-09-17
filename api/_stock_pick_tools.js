import { fetchAdvisorSearchBundle } from './_ai_search.js'
import { fetchResilientStockFund } from './_stock_fund.js'
import { fetchMarketSnapshot } from './market.js'
import { fetchQuotes } from './quote.js'
import {
  STOCK_PICK_MODE,
  normalizeStockPickMode,
} from '../shared/stockPickModes.js'

export const STOCK_PICK_TOOL_LABELS = Object.freeze({
  market_snapshot: '读取市场盘面',
  stock_quote: '核对实时行情',
  stock_fund_flow: '核对个股资金',
  stock_announcements: '检索公告与新闻',
})

export const STOCK_PICK_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'market_snapshot',
      description: '读取A股指数、市场广度和成交额，用于判断当前市场环境。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_quote',
      description: '读取候选股票的最新价格、涨跌幅、量比、换手、成交额及日内价带。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '候选池中的6位股票代码' },
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_fund_flow',
      description: '读取候选股票当日与近5日主力、散户资金流向。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '候选池中的6位股票代码' },
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_announcements',
      description: '检索候选股票截至当前时点可见的公告与新闻线索。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '候选池中的6位股票代码' },
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
  },
])

const REQUIRED_TOOLS = Object.freeze({
  [STOCK_PICK_MODE.INTRADAY]: [
    'market_snapshot',
    'stock_quote',
    'stock_fund_flow',
  ],
  [STOCK_PICK_MODE.EARLY_LAYOUT]: [
    'market_snapshot',
    'stock_quote',
    'stock_fund_flow',
    'stock_announcements',
  ],
  [STOCK_PICK_MODE.NEXT_DAY]: [
    'market_snapshot',
    'stock_quote',
    'stock_fund_flow',
    'stock_announcements',
  ],
})

function text(value, maximum = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function safeCode(value, allowedCodes) {
  const code = String(value || '').trim()
  if (!/^\d{6}$/.test(code) || !allowedCodes.has(code)) {
    const error = new Error('工具只能查询当前候选池中的股票')
    error.code = 'TOOL_CODE_OUT_OF_SCOPE'
    throw error
  }
  return code
}

function marketResult(market = {}) {
  const indices = (Array.isArray(market?.indices) ? market.indices : [])
    .filter((item) =>
      ['000001', '399001', '399006'].includes(String(item?.code || ''))
    )
    .map((item) => ({
      code: text(item.code, 12),
      name: text(item.name, 20),
      pct: finite(item.pct),
      mainNetYi: finite(item.mainInflow) == null
        ? null
        : +(finite(item.mainInflow) / 1e8).toFixed(2),
    }))
  const breadth = market?.breadth || {}
  return {
    indices,
    breadth: {
      up: finite(breadth.up),
      down: finite(breadth.down),
      limitUp: finite(breadth.limitUp),
      amountYi: finite(breadth.amountYi),
    },
  }
}

function quoteResult(quote = {}, fallback = {}) {
  return {
    code: text(quote.code || fallback.code, 12),
    name: text(quote.name || fallback.name, 60),
    price: finite(quote.price ?? fallback.quote?.price),
    pct: finite(quote.pct ?? fallback.quote?.pct),
    open: finite(quote.open ?? fallback.quote?.open),
    high: finite(quote.high ?? fallback.quote?.high),
    low: finite(quote.low ?? fallback.quote?.low),
    prevClose: finite(quote.prevClose ?? fallback.quote?.prevClose),
    amount: finite(quote.amount ?? fallback.quote?.amount),
    turnover: finite(quote.turnover ?? fallback.quote?.turnover),
    volumeRatio: finite(
      quote.volRatio
      ?? quote.volumeRatio
      ?? fallback.quote?.volumeRatio,
    ),
    tradeDate: text(quote.tradeDate || fallback.quote?.tradeDate, 16),
    priceStatus: text(quote.priceStatus, 24),
    isLivePrice: quote.isLivePrice === true,
  }
}

function fundResult(fund = {}, code = '') {
  return {
    code,
    mainNetYi: finite(fund.mainNetYi),
    mainNetPct: finite(fund.mainNetPct),
    main5dYi: finite(fund.main5dYi),
    retailNetYi: finite(fund.retailNetYi),
  }
}

function announcementResult(search = {}, code = '', now = Date.now()) {
  const items = (Array.isArray(search?.items) ? search.items : [])
    .filter((item) => {
      const published = Date.parse(String(item?.publishedAt || item?.date || ''))
      return !Number.isFinite(published) || published <= now
    })
    .slice(0, 4)
    .map((item) => ({
      title: text(item.title, 120),
      source: text(item.src || '联网检索', 40),
      publishedAt: text(item.publishedAt || item.date, 30),
      evidenceStatus: 'SEARCH_RESULT_UNVERIFIED',
    }))
  return {
    code,
    enabled: search?.enabled === true,
    items,
  }
}

export function requiredStockPickTools(mode) {
  return [...(REQUIRED_TOOLS[normalizeStockPickMode(mode)] || [])]
}

export function stockPickToolBrief(name, result = {}) {
  if (result?.error) return text(result.error, 100)
  if (name === 'market_snapshot') {
    const breadth = result.breadth || {}
    return `上涨${breadth.up ?? '—'} / 下跌${breadth.down ?? '—'}`
  }
  if (name === 'stock_quote') {
    return `${result.code || ''} ${result.price ?? '—'}元 ${result.pct ?? '—'}%`
  }
  if (name === 'stock_fund_flow') {
    return `${result.code || ''} 主力净额${result.mainNetYi ?? '—'}亿`
  }
  if (name === 'stock_announcements') {
    return `${result.code || ''} ${result.items?.length || 0}条线索`
  }
  return '已返回'
}

export function createStockPickToolbox({
  candidates = [],
  now = Date.now(),
  fetchMarket = fetchMarketSnapshot,
  fetchQuote = fetchQuotes,
  fetchFund = fetchResilientStockFund,
  fetchSearch = fetchAdvisorSearchBundle,
} = {}) {
  const byCode = new Map(
    (Array.isArray(candidates) ? candidates : [])
      .filter((item) => /^\d{6}$/.test(String(item?.code || '')))
      .map((item) => [String(item.code), item]),
  )
  const allowedCodes = new Set(byCode.keys())

  return async function execute(name, args = {}) {
    if (name === 'market_snapshot') {
      return marketResult(await fetchMarket())
    }
    const code = safeCode(args.code, allowedCodes)
    const candidate = byCode.get(code)
    if (name === 'stock_quote') {
      const quotes = await fetchQuote([code], { now })
      return quoteResult(quotes?.[0] || {}, candidate)
    }
    if (name === 'stock_fund_flow') {
      const fund = await fetchFund(code, {
        preferRealtime: true,
        fetchedAt: now,
      })
      return fundResult(fund, code)
    }
    if (name === 'stock_announcements') {
      const search = await fetchSearch({
        code,
        name: candidate?.name || '',
        industry: candidate?.industry || '',
        reviewOrigin: 'stock-pick-agent',
        includeIndustry: false,
      })
      return announcementResult(search, code, now)
    }
    const error = new Error('未知选股工具')
    error.code = 'UNKNOWN_STOCK_PICK_TOOL'
    throw error
  }
}
