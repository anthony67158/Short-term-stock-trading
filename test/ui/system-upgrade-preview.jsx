import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import fixture from '../fixtures/comprehensive-test-account.json'
import { MainApp } from '../../src/App.jsx'
import { planStore } from '../../src/planStore.js'
import { selectionOriginFromOpportunity } from '../../shared/selectionOrigin.js'
import { buildAccountRiskContext, allocateOpportunityBudget } from '../../shared/accountRiskBudget.js'
import { analyzeOpportunityPortfolio } from '../../shared/opportunityPortfolio.js'

if (!import.meta.env.DEV) throw new Error('Local fixture only')

const now = Date.now()
const book = structuredClone(fixture)
book.alerts = []
book.jobs = {}
book.settings['advAuto.enabled'] = false
book.settings.aiAutoAlert = false
const candidates = book.plan.map((stock, index) => ({
  code: stock.code, name: stock.name, origin: 'PRE_CATALYST',
  lane: 'intraday', state: 'WAIT_TRIGGER',
  discoveredAt: now, activationScore: 72,
  underReactionScore: 65, flowProbeScore: 68,
  sector: { code: `demo-${index}`, name: '演示产业', phase: 'ACCUMULATION' },
  tags: { industry: '演示产业', concepts: ['测试题材'] },
  quote: { price: 10.2 + index, pct: 1.5 },
  evidence: ['测试公告形成潜在催化，价格尚待量价确认', '关注回踩后能否重新站稳均价线'],
  blockers: ['当前只观察，不代表可买入'],
  sourceSignals: ['预催化扫描'],
  entryPlan: {
    price: 10 + index, maxPositionPct: 5, type: 'PULLBACK',
    trigger: '回踩企稳且主力与量能确认', window: '下一交易时段复核',
    validUntil: now + 86400000,
  },
  exitPlan: {
    hardStopPrice: 9.5 + index, takeProfitPrice: 11.5 + index,
    timeStopDate: '2026-09-14', rule: '失效先退出，目标分批止盈',
  },
}))
book.plan.forEach((stock, index) => {
  stock.selectionOrigin = selectionOriginFromOpportunity(candidates[index], {}, now)
})
book.holding.forEach((stock) => {
  stock.sl = +(stock.buyPrice * 0.95).toFixed(2)
  stock.selectionOrigin = selectionOriginFromOpportunity({
    ...candidates[0], code: stock.code,
  }, {}, now)
})
book.closed.forEach((record) => {
  record.selectionOrigin = selectionOriginFromOpportunity({
    ...candidates[0], code: record.code,
  }, {}, now)
})
const quotes = [...book.holding, ...book.plan].map((stock) => ({
  code: stock.code, name: stock.name, price: stock.buyPrice || 10.2,
  prevClose: stock.buyPrice || 10, pct: 1.5, amount: 200000000,
  industry: stock.industry || '演示产业', tradeDate: '2026-09-08',
  priceStatus: 'CLOSE', priceLabel: '收盘', isLivePrice: false,
}))
const quoteMap = Object.fromEntries(quotes.map((quote) => [quote.code, quote]))
const account = buildAccountRiskContext(book, quoteMap, now)
const portfolio = allocateOpportunityBudget(analyzeOpportunityPortfolio({ rows: candidates }), account)
const radar = {
  ok: true, schemaVersion: 'opportunity-radar.v2', generatedAt: now,
  phase: 'INTRADAY', defaultLane: 'intraday', tasks: {},
  lanes: { intraday: candidates, next: candidates },
  portfolios: { intraday: portfolio, next: portfolio },
  sourceStatus: Object.fromEntries(['sector', 'formulaIntraday', 'preCatalyst', 'tail'].map((key) => [
    key, { status: 'fresh', dataAsOf: now },
  ])),
}
const market = {
  updatedAt: now,
  indices: [{ code: '000001', name: '上证指数', price: 3200, pct: 0.6 }],
  breadth: { up: 3200, down: 1800, flat: 100, limitUp: 55, limitDown: 3 },
}
const originalFetch = window.fetch
window.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.origin)
  if (!url.pathname.startsWith('/api/')) {
    if (url.origin !== location.origin) throw new Error('External network blocked in fixture')
    return originalFetch(input, options)
  }
  const empty = { ok: true, list: [], history: [], updatedAt: now }
  let data = empty
  if (url.pathname === '/api/market_snapshot') data = {
    ...empty, market, sectors: empty, limitUp: empty, brokenLimit: empty,
    movers: empty, speed: empty, errors: {},
  }
  if (url.pathname === '/api/quote') data = { ...empty, list: quotes }
  if (url.pathname === '/api/opportunity_radar') data = radar
  if (url.pathname === '/api/stock_tags') data = {
    ...empty, list: quotes.map((quote) => ({ ...quote, concepts: ['测试题材'], conceptVerified: true })),
  }
  if (url.pathname === '/api/portfolio_analysis') data = { ...empty, result: null, job: null }
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}
planStore.setData(book)
ReactDOM.createRoot(document.getElementById('root')).render(<MainApp />)
