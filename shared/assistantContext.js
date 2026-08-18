const text = (value, max = 80) => String(value || '').trim().slice(0, max)
const number = (value) => {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const codeOf = (value) => (/^\d{6}$/.test(String(value || '')) ? String(value) : '')
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && item !== ''))
const totalCount = (declared, actual) => {
  const value = number(declared)
  return value != null && value >= actual
    ? Math.min(10000, Math.floor(value))
    : actual
}

export function authoritativeListCount(result = {}) {
  const listLength = Array.isArray(result.list) ? result.list.length : 0
  return totalCount(result.total, listLength)
}

export function amountInYi(value) {
  const parsed = number(value)
  return parsed == null ? null : +(parsed / 1e8).toFixed(2)
}

export function sanitizeAccountContext(input = {}) {
  const account = input.account && typeof input.account === 'object' ? input.account : {}
  const rawPositions = Array.isArray(input.positions) ? input.positions : []
  const rawWatchlist = Array.isArray(input.watchlist) ? input.watchlist : []
  const rawRecentTrades = Array.isArray(input.recentTrades) ? input.recentTrades : []
  const declaredCounts = input.counts && typeof input.counts === 'object'
    ? input.counts
    : {}
  const positions = rawPositions.slice(0, 12)
    .map((item) => compact({
      code: codeOf(item.code),
      name: text(item.name, 20),
      qty: number(item.qty),
      cost: number(item.cost),
      currentPrice: number(item.currentPrice),
      pnlPct: number(item.pnlPct),
      sellableToday: number(item.sellableToday),
      t1Locked: !!item.t1Locked,
      weightPct: number(item.weightPct),
      tp: number(item.tp),
      sl: number(item.sl),
    })).filter((item) => item.code)
  const watchlist = rawWatchlist.slice(0, 40)
    .map((item) => compact({
      code: codeOf(item.code),
      name: text(item.name, 20),
      qScore: number(item.qScore),
      qBias: text(item.qBias, 12),
    })).filter((item) => item.code)
  const recentTrades = rawRecentTrades.slice(0, 10)
    .map((item) => compact({
      type: ['BUY', 'SELL', 'CLOSE', 'T'].includes(item.type) ? item.type : 'OTHER',
      code: codeOf(item.code),
      name: text(item.name, 20),
      qty: number(item.qty),
      price: number(item.price ?? item.sellPrice ?? item.buyPrice),
      at: number(item.at ?? item.sellAt ?? item.buyAt),
    })).filter((item) => item.code)
  const counts = {
    positions: totalCount(declaredCounts.positions, rawPositions.length),
    watchlist: totalCount(declaredCounts.watchlist, rawWatchlist.length),
    recentTrades: totalCount(declaredCounts.recentTrades, rawRecentTrades.length),
  }
  const decision = input.decision && typeof input.decision === 'object' ? compact({
    recommendations: number(input.decision.recommendations),
    executions: number(input.decision.executions),
    adoptionRate: number(input.decision.adoptionRate),
  }) : undefined
  return compact({
    account: compact({
      totalAssets: number(account.totalAssets),
      cash: number(account.cash),
      positionPct: number(account.positionPct),
    }),
    positions,
    watchlist,
    recentTrades,
    counts,
    capturedAt: number(input.capturedAt),
    decision,
  })
}

function iso(value, fallback = '') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value)
  const candidate = value == null || value === '' ? fallback : value
  if (candidate == null || candidate === '') return ''
  const date = new Date(candidate)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}
export function formatEvidenceTime(value, kind = 'data') {
  if (!value) return '时间未知'
  const prefix = kind === 'snapshot'
    ? '快照'
    : kind === 'published'
      ? '发布'
      : '数据'
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return `${prefix} ${String(value).slice(5).replace('-', '/')}`
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return `${prefix} ${date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })}`
}
function safeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  } catch { return '' }
}
function evidence(id, title, source, summary, asOf, url = '', timeKind = 'data', dimension = 'data') {
  return {
    id: `证据${id}`,
    title: text(title, 80),
    source,
    asOf,
    timeKind,
    url: safeUrl(url),
    summary: text(summary, 220),
    dimension: dimension === 'search' ? 'search' : 'data',
  }
}

export function accountEvidence(context, index = 1, now = Date.now()) {
  const positionTotal = totalCount(context.counts?.positions, context.positions?.length || 0)
  const watchlistTotal = totalCount(context.counts?.watchlist, context.watchlist?.length || 0)
  const tradeTotal = totalCount(context.counts?.recentTrades, context.recentTrades?.length || 0)
  const sampled = (total, included, unit, prefix = '提供 ') =>
    total > included ? `（${prefix}${included} ${unit}）` : ''
  return evidence(
    index,
    '当前账户与持仓',
    '用户本地交易账本',
    `${positionTotal} 只持仓${sampled(positionTotal, context.positions?.length || 0, '只明细')}、`
      + `${watchlistTotal} 只自选${sampled(watchlistTotal, context.watchlist?.length || 0, '只明细')}、`
      + `账本 ${tradeTotal} 条交易${sampled(tradeTotal, context.recentTrades?.length || 0, '条', '提供最近 ')}`,
    iso(context.capturedAt, now),
    '',
    'snapshot',
  )
}

export function evidenceFromTool(tool, args = {}, result = {}, options = {}) {
  const start = Number(options.startIndex) || 1
  if (tool === 'web_news') {
    return (result.news || []).slice(0, 5).map((item, offset) =>
      evidence(
        start + offset,
        item.title,
        text(item.src, 30) || '东方财富资讯',
        item.summary || item.title,
        iso(item.date),
        item.url,
        'published',
        item.kind === 'ai_search' ? 'search' : 'data',
      )
    )
  }
  const list = Array.isArray(result.list) ? result.list : []
  const names = list.slice(0, 4).map((item) => item.name || item.code).filter(Boolean).join('、')
  const quoteSources = [...new Set(list.map((item) => text(item.source, 20)).filter(Boolean))]
  const quoteSource = quoteSources.length
    ? `${quoteSources.join('/')}行情`
    : '公开行情接口'
  const quantReads = Array.isArray(result.quant?.reads)
    ? result.quant.reads.join('；')
    : text(result.quant?.reads, 100)
  const config = {
    get_quote: ['行情快照', quoteSource,
      list.slice(0, 3).map((item) =>
        `${item.name || item.code} ${item.price ?? '—'} (${item.pct ?? '—'}%)`
          + (item.tradeDate ? `，交易日${item.tradeDate}` : '')
      ).join('；')],
    get_stock_detail: ['公司资料', '东方财富公司资料',
      `${result.name || result.code || args.code || ''} ${result.industry || ''} ${result.business || ''}`],
    get_quant_score: ['量化与技术指标', '量化预测模型',
      `${result.name || args.code || ''} 量化${result.quant?.score ?? '—'}分 ${result.quant?.bias || ''}；${quantReads}`],
    screen_stocks: ['全市场条件筛选', '东方财富全市场行情', `${result.count ?? list.length} 只：${names}`],
    get_sector_rank: ['板块资金排行', '东方财富板块资金', names],
    get_limit_pool: ['涨停连板池', '东方财富涨停池', `${result.count ?? list.length} 只：${names}`],
    get_movers: ['盘中异动', '东方财富盘中异动', names],
    get_market: ['大盘情绪', '东方财富市场行情',
      `上涨${result.breadth?.up ?? '—'}家、下跌${result.breadth?.down ?? '—'}家、涨停${result.breadth?.limitUp ?? '—'}家`],
    search_stock: ['股票搜索', '东方财富股票搜索', names],
  }[tool] || [tool, '工具查询结果', names || JSON.stringify(result).slice(0, 160)]
  return [evidence(start, config[0], config[1], config[2], iso(result.asOf ?? result.updatedAt))]
}
