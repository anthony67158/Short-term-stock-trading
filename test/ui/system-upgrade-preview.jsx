import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import fixture from '../fixtures/comprehensive-test-account.json'
import { MainApp } from '../../src/App.jsx'
import { planStore } from '../../src/planStore.js'
import { projectAdviceAlerts } from '../../shared/adviceAlerts.js'
import { selectionOriginFromOpportunity } from '../../shared/selectionOrigin.js'
import { buildAccountRiskContext, allocateOpportunityBudget } from '../../shared/accountRiskBudget.js'
import { analyzeOpportunityPortfolio } from '../../shared/opportunityPortfolio.js'

if (!import.meta.env.DEV) throw new Error('Local fixture only')

const now = Date.now()
const book = structuredClone(fixture)
book.alerts = []
book.jobs = {}
book.settings['advAuto.enabled'] = false
book.settings.aiAutoAlert = true
book.holding.unshift({
  id: 'demo-hold-monitoring',
  code: '002475',
  name: '立讯精密',
  qty: 1,
  buyPrice: 54.165,
  buyFee: 5,
  buyAt: now - 86400000,
  industry: '消费电子',
  concept: 'AI终端',
  tRealizedPnl: 0,
  tFlows: [],
  muteAdd: false,
  muteReduce: false,
  muteTp: false,
  muteSl: false,
})
book.advice['002475'] = {
  mode: 'hold_advice',
  at: now,
  cachedAt: now,
  advice: {
    name: '立讯精密',
    action: '持有',
    title: '继续持有1手',
    actionPlan: '继续持有1手，系统自动跟踪风险与利润退出条件。',
    invalidation: '跌破54元或主力净流出达到3亿元时退出。',
    fundNote: '当前主力净流入0.5亿元，未触发资金退出条件。',
    techNote: '现价54.5元位于分时均价54.3元上方。',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: 'decision-demo-monitoring',
      mode: 'hold_advice',
      action: 'HOLD',
      actionability: 'HOLD',
      quantity: { lots: 0 },
      validUntil: new Date(now + 86400000).toISOString(),
    },
    monitoringPlan: {
      schemaVersion: 'monitoring-plan.v1',
      planId: 'decision-demo-monitoring',
      code: '002475',
      createdAt: now,
      validUntil: new Date(now + 86400000).toISOString(),
      state: 'READY',
      errors: [],
      rules: [
        {
          id: 'risk-exit',
          action: 'EXIT',
          kind: 'RISK_EXIT',
          priority: 1,
          lots: 1,
          logic: 'ANY',
          session: 'CONTINUOUS',
          sustainSeconds: 0,
          conditions: [
            { metric: 'price', op: 'lte', value: 54 },
            { metric: 'mainNetYi', op: 'lte', value: -3 },
          ],
        },
        {
          id: 'profit-exit',
          action: 'EXIT',
          kind: 'PROFIT_EXIT',
          priority: 2,
          lots: 1,
          logic: 'ANY',
          session: 'CONTINUOUS',
          sustainSeconds: 0,
          conditions: [
            { metric: 'price', op: 'gte', value: 56 },
          ],
        },
        {
          id: 'hold-confirmation',
          action: 'HOLD',
          kind: 'HOLD',
          priority: 3,
          lots: 0,
          logic: 'ALL',
          session: 'CONTINUOUS',
          sustainSeconds: 60,
          conditions: [
            { metric: 'mainNetYi', op: 'gte', value: 0 },
            { metric: 'priceVsVwapPct', op: 'gte', value: 0 },
          ],
        },
      ],
    },
  },
}
book.executionPlans = [{
  schemaVersion: 'execution-plan.v1',
  planId: 'execution.demo-sell',
  decisionId: 'decision.demo-sell',
  code: '600036',
  name: '演示标准仓',
  action: 'REDUCE',
  actionLabel: '减仓',
  side: 'SELL',
  status: 'USER_CONFIRMED',
  canArm: true,
  createdAt: now,
  updatedAt: now,
  validUntil: new Date(now + 60 * 60 * 1000).toISOString(),
  targetLots: 1,
  filledLots: 0,
  remainingLots: 1,
  referencePrice: 44,
  triggerPrice: 44,
  triggerDirection: 'GTE',
  stopPrice: 41,
  targetPrice: 46,
  trigger: '反弹到44元后减仓1手',
  riskAmount: 300,
  reservedCash: 0,
  expectedNetProceeds: 4390,
  executionMethod: { type: 'SINGLE_LIMIT' },
  fills: [],
  transitions: [],
}]
book.advice['002594'].advice = {
  ...book.advice['002594'].advice,
  decisionPlan: {
    schemaVersion: 'decision-plan.v2',
    action: 'WATCH',
    actionability: 'WATCH',
    quantity: { lots: 0 },
    prices: { reference: 10, stop: 9.5, target: 11.5 },
    entryBudget: {
      state: 'ESTIMATED',
      executionAllowed: false,
      lots: 20,
      referencePrice: 10,
      stopPrice: 9.5,
      targetPrice: 11.5,
      costs: { estimatedNetAmount: 2005 },
      stopLossAmount: 105,
      reasons: [],
    },
    actionPolicy: {
      riskTier: 'FULL',
      nextSessionPlan: {
        action: 'BUY',
        session: 'NEXT_TRADING_DAY',
        trigger: '回踩10元企稳后确认本次买点',
      },
    },
  },
  priceContract: {
    schemaVersion: 'advice-price-contract.v1',
    levels: [{ key: 'watch_pullback', price: 10, direction: 'LTE', strict: true }],
  },
}
book.advice['688981'].advice.decisionPlan = {
  schemaVersion: 'decision-plan.v2',
  action: 'BUY',
  actionability: 'READY',
  quantity: { lots: 1 },
  prices: { reference: 102, stop: 97, target: 112 },
  actionPolicy: { riskTier: 'FULL' },
}
for (const entry of Object.values(book.advice)) {
  entry.at = now
  entry.cachedAt = now
  entry.advice.nextOpenPlan = '演示：次日按原定止损和目标检查，不追高。'
  entry.advice.futurePlan = '演示：五日内按目标退出，先触及止损则停止本计划。'
}
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
const monitoredQuote = quotes.find((quote) => quote.code === '002475')
Object.assign(monitoredQuote, {
  price: 54.5,
  prevClose: 54.2,
  open: 54.3,
  pct: 0.55,
  mainInflow: 50000000,
  vwap: 54.3,
  tradeDate: new Date(now + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10),
  priceStatus: 'LIVE',
  priceLabel: '实时',
  isLivePrice: true,
})
projectAdviceAlerts(book, '002475', book.advice['002475'].advice, {
  now,
  t1Status: {
    liveQty: 1,
    boughtToday: 0,
    sellableToday: 1,
  },
  requirePriceContract: true,
})
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
  if (url.pathname === '/api/cron_advice') data = {
    ok: true,
    alerts: book.alerts,
  }
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}
planStore.setData(book)
ReactDOM.createRoot(document.getElementById('root')).render(<MainApp />)
