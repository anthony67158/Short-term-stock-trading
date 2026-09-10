import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import fixture from '../fixtures/comprehensive-test-account.json'
import { MainApp } from '../../src/App.jsx'
import { planStore } from '../../src/planStore.js'
import { getAllAdvice } from '../../src/adviceCache.js'
import { buildPositionWorkbench } from '../../shared/positionWorkbench.js'

if (!import.meta.env.DEV) throw new Error('Local fixture only')
const now = Date.now()
const book = structuredClone(fixture)
book.alerts = []
book.executionPlans = []
book.jobs = {}
book.reviewJobs = {}
book.advice = {}
book.plan.push({
  code: '600522',
  name: '中天科技',
  star: true,
  industry: '通信设备',
  concept: 'PCB',
})
book.settings = {
  ...book.settings, aiAutoAlert: true,
  'advAuto.holdEnabled': true, 'advAuto.watchEnabled': true,
  'advAuto.holdCodes': book.holding.map((item) => item.code),
  'advAuto.watchCodes': ['002594', '688981', '600522'],
  'advReview.disabledCodes': [],
}
const values = [
  ['000001', '平安银行', 11.7, 'EXIT', 10, 'READY'],
  ['600036', '招商银行', 41, 'HOLD', 0, 'READY'],
  ['300750', '宁德时代', 336, 'HOLD', 0, 'MODEL_NOT_READY'],
  ['002594', '比亚迪', 86, 'WATCH', 0, 'READY'],
  ['688981', '中芯国际', 120, 'BUY', 1, 'READY'],
  ['600519', '贵州茅台', 1290, 'WATCH', 0, 'MODEL_NOT_READY'],
]
const quotes = values.map(([code, name, price]) => ({
  code, name, price, prevClose: price, high: price * 1.01, low: price * 0.99,
  amount: 2e8, pct: 0, isLivePrice: true, live: true, priceStatus: 'LIVE',
  priceLabel: '实时', tradeDate: '2026-09-10', industry: '本地测试',
}))
quotes.push({
  code: '600522',
  name: '中天科技',
  price: 33.48,
  prevClose: 34.12,
  high: 34.2,
  low: 33.1,
  amount: 1.8e8,
  pct: -1.88,
  isLivePrice: false,
  live: false,
  priceStatus: 'CLOSE',
  priceLabel: '午间收盘',
  tradeDate: '2026-09-10',
  industry: '通信设备',
})
const quoteMap = Object.fromEntries(quotes.map((quote) => [quote.code, quote]))
for (const [code, name, price, action, lots, state] of values) {
  const holding = book.holding.find((item) => item.code === code)
  const item = holding || book.plan.find((row) => row.code === code)
  item.name = name
  if (holding) holding.sl = +(price * 0.96).toFixed(2)
  const mode = holding ? 'hold_advice' : 'buy_advice'
  book.advice[code] = {
    mode, at: now, cachedAt: now,
    advice: {
      name, action: { EXIT: '清仓', HOLD: '持有', BUY: '买入', WATCH: '观望' }[action],
      title: '本地测试决策',
      actionPlan: action === 'EXIT' ? '卖出可卖10手并记录成交'
        : action === 'BUY' ? '买入1手，成交后记录' : '本次不加仓、不减仓',
      opQty: action === 'EXIT' ? '清仓10手' : null,
      planQty: lots,
      buyPrice: action === 'BUY' ? price : null,
      reducePrice: action === 'EXIT' ? price : null,
      stopPrice: +(price * 0.96).toFixed(2), targetPrice: +(price * 1.06).toFixed(2),
      pullbackWatchPrice: code === '002594' ? 84 : null,
      decisionSource: { engine: 'V3', state, evaluatedAt: now, modelVersion: 'LOCAL_TEST_DOUBLE' },
      decisionPlan: {
        schemaVersion: 'decision-plan.v2', decisionId: `test-${code}`, mode,
        action, actionability: ['BUY', 'EXIT'].includes(action) ? 'READY' : 'WATCH',
        quantity: { lots, holdingLots: holding?.qty || 0 },
        prices: { reference: price, stop: price * 0.96, target: price * 1.06 },
        validUntil: new Date(now + 3600000).toISOString(),
        blockedReasons: [],
      },
      quantNote: '本地确定性模型替身，不代表真实预测。',
      fundNote: '本地验收数据，不用于投资决策。',
      invalidation: '报价或账户变化后重新评估',
      nextOpenPlan: '下一交易时段重新评估',
      futurePlan: '按价格与风险条件管理',
      ...(code === '600036'
        ? {
            v3Explanation: {
              schemaVersion: 'v3-explanation.v1',
              status: 'ready',
              decisionId: `test-${code}`,
              model: 'LOCAL_EXPLAIN_DOUBLE',
              generatedAt: now,
              summary: '当前持有路径的费后价值高于立即减仓。',
              counterCase: '资金转弱时持有优势可能消失。',
              invalidation: '价格或账户事实变化后重新运行V3。',
              evidenceGap: '缺少真实盘中逐笔成交。',
            },
          }
        : {}),
    },
  }
}
const originalFetch = window.fetch
window.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.origin)
  if (!url.pathname.startsWith('/api/')) {
    if (url.origin !== location.origin) throw new Error('External network blocked')
    return originalFetch(input, options)
  }
  let body = { ok: true, list: [], updatedAt: now }
  if (url.pathname === '/api/quote') body.list = quotes
  if (url.pathname === '/api/position_workbench') body = {
    ok: true, ...buildPositionWorkbench({
      book: { ...planStore.get(), advice: getAllAdvice() }, quoteMap, now,
    }),
  }
  if (url.pathname === '/api/stock_detail') body = {
    ok: true, quote: quoteMap[url.searchParams.get('code')], candles: [], info: {},
  }
  if (url.pathname === '/api/stock_tags') body.list = quotes.map((quote) => ({
    ...quote, concepts: ['本地测试'], conceptVerified: true,
  }))
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}
planStore.setData(book)
ReactDOM.createRoot(document.getElementById('root')).render(<MainApp />)
