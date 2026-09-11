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
import { buildMarketFundsSnapshot } from '../../shared/marketFunds.js'
import { analyzeOpportunityPortfolio } from '../../shared/opportunityPortfolio.js'
import { buildPositionWorkbench } from '../../shared/positionWorkbench.js'

if (!import.meta.env.DEV) throw new Error('Local fixture only')

const now = Date.now()
const book = structuredClone(fixture)
book.alerts = []
book.jobs = {}
book.settings['advAuto.enabled'] = true
book.settings['advAuto.holdEnabled'] = true
book.settings['advAuto.watchEnabled'] = true
book.settings['advAuto.holdCodes'] = [
  ...new Set(book.holding.map((item) => item.code)),
  '002475',
]
book.settings['advAuto.watchCodes'] = book.plan
  .filter((item) => item.code !== '600519')
  .map((item) => item.code)
book.settings['advReview.disabledCodes'] = []
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
    decisionSource: {
      engine: 'MULTI_TASK',
      state: 'READY',
      evaluatedAt: now,
      modelVersion: 'LOCAL_TEST_DOUBLE',
    },
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: 'decision-demo-monitoring',
      mode: 'hold_advice',
      action: 'HOLD',
      actionability: 'HOLD',
      quantity: { lots: 0 },
      prices: { reference: 54.5, stop: 54, target: 56 },
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
book.advice['000001'] = {
  ...book.advice['000001'],
  at: now,
  cachedAt: now,
  advice: {
    ...book.advice['000001'].advice,
    action: '清仓',
    title: '风险条件成立，清仓10手',
    actionPlan: '清仓10手，按当前可卖数量人工执行并记录成交。',
    nextAction: '清仓10手，按当前可卖数量人工执行并记录成交。',
    opQty: '清仓10手',
    decisionSource: {
      engine: 'MULTI_TASK',
      state: 'READY',
      evaluatedAt: now,
      modelVersion: 'LOCAL_TEST_DOUBLE',
    },
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: 'decision-demo-immediate-exit',
      mode: 'hold_advice',
      action: 'EXIT',
      actionability: 'CONDITIONAL',
      quantity: { lots: 10 },
      prices: { reference: 11.7, stop: 10.26, target: 12.4 },
      validUntil: new Date(now + 86400000).toISOString(),
    },
    monitoringPlan: {
      schemaVersion: 'monitoring-plan.v1',
      planId: 'decision-demo-expired-monitoring',
      code: '000001',
      createdAt: now - 86400000,
      validUntil: new Date(now - 1000).toISOString(),
      state: 'READY',
      errors: [],
      rules: [{
        id: 'expired-stop',
        action: 'EXIT',
        kind: 'RISK_EXIT',
        priority: 1,
        lots: 10,
        logic: 'ANY',
        session: 'CONTINUOUS',
        sustainSeconds: 0,
        conditions: [{
          metric: 'price',
          op: 'lte',
          value: 10.26,
        }],
      }],
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
  pullbackWatchPrice: 84,
  stopPrice: 80,
  targetPrice: 92,
  decisionSource: {
    engine: 'MULTI_TASK',
    state: 'READY',
    evaluatedAt: now,
    modelVersion: 'LOCAL_TEST_DOUBLE',
  },
  decisionPlan: {
    schemaVersion: 'decision-plan.v2',
    decisionId: 'decision-demo-watch',
    action: 'WATCH',
    actionability: 'WATCH',
    quantity: { lots: 0 },
    prices: { reference: 84, stop: 80, target: 92 },
    validUntil: new Date(now + 86400000).toISOString(),
    entryBudget: {
      state: 'ESTIMATED',
      executionAllowed: false,
      lots: 20,
      referencePrice: 84,
      stopPrice: 80,
      targetPrice: 92,
      costs: { estimatedNetAmount: 16805 },
      stopLossAmount: 805,
      reasons: [],
    },
    actionPolicy: {
      riskTier: 'FULL',
      nextSessionPlan: {
        action: 'BUY',
        session: 'NEXT_TRADING_DAY',
        trigger: '回踩84元企稳后重新评估',
      },
    },
  },
  decisionExplanation: {
    schemaVersion: 'decision-explanation.v1',
    status: 'ready',
    decisionId: 'decision-demo-watch',
    model: 'LOCAL_EXPLAIN_DOUBLE',
    generatedAt: now,
    summary: '当前没有费后价值为正的可执行路径。',
    counterCase: '若回踩后资金重新转强，原判断可能过于保守。',
    invalidation: '价格或账户事实变化后重新运行V3。',
    evidenceGap: '缺少真实盘中逐笔成交。',
  },
  priceContract: {
    schemaVersion: 'advice-price-contract.v1',
    levels: [{ key: 'watch_pullback', price: 84, direction: 'LTE', strict: true }],
  },
}
book.advice['688981'].advice.decisionPlan = {
  schemaVersion: 'decision-plan.v2',
  decisionId: 'decision-demo-buy',
  action: 'BUY',
  actionability: 'READY',
  quantity: { lots: 1 },
  prices: { reference: 102, stop: 97, target: 112 },
  actionPolicy: { riskTier: 'FULL' },
  validUntil: new Date(now + 86400000).toISOString(),
}
book.advice['688981'].advice.decisionSource = {
  engine: 'MULTI_TASK',
  state: 'READY',
  evaluatedAt: now,
  modelVersion: 'LOCAL_TEST_DOUBLE',
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
  indices: [
    {
      code: '000001',
      name: '上证指数',
      price: 3200,
      pct: 0.6,
      amount: 600_000_000_000,
      mainInflow: 3_800_000_000,
    },
    {
      code: '399001',
      name: '深证成指',
      price: 10480,
      pct: 0.82,
      amount: 340_000_000_000,
      mainInflow: 2_400_000_000,
    },
    {
      code: '399006',
      name: '创业板指',
      price: 2180,
      pct: -0.21,
      amount: 150_000_000_000,
      mainInflow: -1_000_000_000,
    },
    {
      code: '899050',
      name: '北证50',
      price: 1120,
      pct: 1.08,
      amount: 28_000_000_000,
      mainInflow: -3_200_000_000,
    },
  ],
  breadth: {
    up: 3200,
    down: 1800,
    flat: 100,
    limitUp: 55,
    limitDown: 3,
    amountYi: 9680,
    avg5AmountYi: 8913.4,
    amountDeltaVsAvg5Yi: 766.6,
    volVsAvg5: 8.6,
    volLevel: '平量',
    volumeComparable: true,
  },
}
const overseas = {
  indices: [
    { label: '恒生指数', price: 25832, pct: 0.72 },
    { label: '恒生科技', price: 5681, pct: 1.12 },
    { label: '道琼斯', price: 45210, pct: -0.18 },
    { label: '纳斯达克', price: 21879, pct: 0.44 },
    { label: '标普500', price: 6492, pct: 0.21 },
  ],
  commodities: [
    { label: '伦敦金(现货)', price: 3625.4, pct: 0.31 },
    { label: '美原油(WTI)', price: 63.8, pct: -0.46 },
    { label: 'COMEX黄金', price: 3640.2, pct: 0.28 },
  ],
}
const sectorSnapshot = {
  ok: true,
  updatedAt: now,
  list: [
    { code: 'BK01', name: '电子', pct: 1.8, mainInflow: 3_800_000_000 },
    { code: 'BK02', name: '通信', pct: 1.3, mainInflow: 2_400_000_000 },
    { code: 'BK03', name: '汽车', pct: 0.9, mainInflow: 1_200_000_000 },
    { code: 'BK04', name: '银行', pct: 0.4, mainInflow: 800_000_000 },
    { code: 'BK05', name: '医药', pct: 0.2, mainInflow: 500_000_000 },
    { code: 'BK06', name: '煤炭', pct: -1.1, mainInflow: -2_800_000_000 },
    { code: 'BK07', name: '地产', pct: -0.8, mainInflow: -1_700_000_000 },
    { code: 'BK08', name: '钢铁', pct: -0.5, mainInflow: -1_200_000_000 },
  ],
}
const marketFunds = buildMarketFundsSnapshot({
  market,
  updatedAt: now,
})
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
    ...empty,
    market,
    marketFunds,
    overseas,
    sectors: sectorSnapshot,
    limitUp: empty,
    brokenLimit: empty,
    movers: empty, speed: empty, errors: {},
  }
  if (url.pathname === '/api/quote') data = { ...empty, list: quotes }
  if (url.pathname === '/api/opportunity_radar') data = radar
  if (url.pathname === '/api/position_workbench') data = {
    ok: true,
    partial: false,
    ...buildPositionWorkbench({
      book,
      quoteMap,
      opportunityRadar: radar,
      now,
    }),
  }
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
