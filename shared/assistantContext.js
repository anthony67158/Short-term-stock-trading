const text = (value, max = 80) => String(value || '').trim().slice(0, max)
const number = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const codeOf = (value) => (/^\d{6}$/.test(String(value || '')) ? String(value) : '')
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && item !== ''))

export function sanitizeAccountContext(input = {}) {
  const account = input.account && typeof input.account === 'object' ? input.account : {}
  const positions = (Array.isArray(input.positions) ? input.positions : []).slice(0, 12)
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
  const watchlist = (Array.isArray(input.watchlist) ? input.watchlist : []).slice(0, 20)
    .map((item) => compact({
      code: codeOf(item.code),
      name: text(item.name, 20),
      qScore: number(item.qScore),
      qBias: text(item.qBias, 12),
    })).filter((item) => item.code)
  const recentTrades = (Array.isArray(input.recentTrades) ? input.recentTrades : []).slice(0, 10)
    .map((item) => compact({
      type: ['BUY', 'SELL', 'CLOSE', 'T'].includes(item.type) ? item.type : 'OTHER',
      code: codeOf(item.code),
      name: text(item.name, 20),
      qty: number(item.qty),
      price: number(item.price ?? item.sellPrice ?? item.buyPrice),
      at: number(item.at ?? item.sellAt ?? item.buyAt),
    })).filter((item) => item.code)
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
    decision,
  })
}

function iso(value, now) {
  const date = new Date(value == null || value === '' ? now : value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(now).toISOString()
}
function safeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  } catch { return '' }
}
function evidence(id, title, source, summary, asOf, url = '') {
  return { id: `证据${id}`, title: text(title, 80), source, asOf, url: safeUrl(url), summary: text(summary, 220) }
}

export function accountEvidence(context, index = 1, now = Date.now()) {
  return evidence(
    index,
    '当前账户与持仓',
    '用户本地交易账本',
    `${context.positions?.length || 0} 只持仓、${context.watchlist?.length || 0} 只自选、${context.recentTrades?.length || 0} 条最近交易`,
    iso(now, now)
  )
}

export function evidenceFromTool(tool, args = {}, result = {}, options = {}) {
  const start = Number(options.startIndex) || 1
  const now = options.now ?? Date.now()
  if (tool === 'web_news') {
    return (result.news || []).slice(0, 5).map((item, offset) =>
      evidence(start + offset, item.title, text(item.src, 30) || '东方财富资讯', item.title, iso(item.date, now), item.url)
    )
  }
  const list = Array.isArray(result.list) ? result.list : []
  const names = list.slice(0, 4).map((item) => item.name || item.code).filter(Boolean).join('、')
  const quantReads = Array.isArray(result.quant?.reads)
    ? result.quant.reads.join('；')
    : text(result.quant?.reads, 100)
  const config = {
    get_quote: ['实时行情', '东方财富实时行情',
      list.slice(0, 3).map((item) => `${item.name || item.code} ${item.price ?? '—'} (${item.pct ?? '—'}%)`).join('；')],
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
  return [evidence(start, config[0], config[1], config[2], iso(result.asOf ?? result.updatedAt, now))]
}
