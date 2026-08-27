import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const planTab = read('src/components/PlanTab.jsx')
const stockDetail = read('src/components/StockDetail.jsx')
const stockDetailApi = read('api/stock_detail.js')
const quoteApi = read('api/quote.js')
const precision = read('src/styles/precision.css')
const design = read('design.md')

test('持仓与自选卡只展示固定策略摘要并从详情入口查看完整建议', () => {
  assert.match(planTab, /function ActionCommand\(\{ view, onOpen \}\)/)
  assert.equal((planTab.match(/<ActionCommand[\s\S]{0,120}onOpen=/g) || []).length, 2)
  assert.match(
    planTab,
    /<button[\s\S]*?className="action-command"[\s\S]*?onClick=\{onOpen\}/,
  )
  assert.doesNotMatch(planTab, /className="action-command-open"/)
  assert.doesNotMatch(planTab, /action-command-disclosure/)
  assert.doesNotMatch(planTab, /useLayoutEffect/)
})

test('持仓和自选卡展示最近有效价但只用连续竞价价触发动作', () => {
  assert.match(
    planTab,
    /import\s*{\s*quoteDisplayState\s*}\s*from\s*'\.\.\/\.\.\/shared\/quoteDisplay\.js'/,
  )
  assert.match(
    planTab,
    /function QuotePrice\([\s\S]*?const priceView = quoteDisplayState\(quote\)[\s\S]*?fmtRaw\(priceView\.price\)[\s\S]*?quoteSecondaryText\(priceView\)/,
  )
  assert.match(
    planTab,
    /const quoteView = quoteDisplayState\(q\)[\s\S]*?const validPx = quoteView\.livePrice/,
  )
  assert.match(
    planTab,
    /const livePrice = quoteDisplayState\(q\)\.livePrice[\s\S]*?currentPrice: livePrice/,
  )
  assert.match(
    planTab,
    /executionOpen && priceView\.livePrice != null[\s\S]*?priceView\.livePrice >= alert\.value/,
  )
  assert.doesNotMatch(
    planTab,
    /className=\{'pc-price '[\s\S]*?fmtRaw\(q\.price\)/,
  )
})

test('桌面卡片使用同高摘要骨架且移动端恢复自然高度', () => {
  assert.match(planTab, /className="card-decision-slot"/)
  assert.equal((planTab.match(/className="card-decision-slot"/g) || []).length, 2)
  assert.match(
    precision,
    /\.hold-grid,[\s\S]*?\.plan-cand-grid\s*{[^}]*align-items:\s*stretch/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot\s*{[^}]*display:\s*flex[^}]*flex:\s*1[^}]*min-height:/s,
  )
  assert.match(precision, /\.card-decision-slot\s*{[^}]*flex-direction:\s*column/s)
  assert.match(
    precision,
    /\.card-decision-slot > \.action-decision,[\s\S]*?\.card-decision-slot > \.action-prompt,[\s\S]*?\.card-decision-slot > \.advice-generation-status\s*{[^}]*flex:\s*1/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*50rem\)\s*{[\s\S]*?\.card-decision-slot\s*{[^}]*min-height:\s*0/s,
  )
  assert.match(
    design,
    /Desktop uses a uniform compact[\s\S]*Mobile restores natural height/s,
  )
})

test('策略摘要使用两行主指令、紧凑价位和单行进度', () => {
  assert.match(planTab, /className="action-progress-summary"/)
  assert.doesNotMatch(planTab, /className="action-progress-head"/)
  assert.match(
    planTab,
    /\{view\.commandLabel \|\| '当前指令'\}/,
  )
  assert.match(
    planTab,
    /view\.quantityLabel \|\| actionQtyLabel\(view\.quantity\)/,
  )
  assert.match(
    planTab,
    /\{view\?\.detailActionLabel \|\| '查看后续预案'\}/,
  )
  assert.match(
    precision,
    /\.card-decision-slot \.action-command-text\s*{[^}]*display:\s*-webkit-box[^}]*white-space:\s*normal[^}]*-webkit-line-clamp:\s*2/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot \.action-levels\.editable > \.action-level\s*{[^}]*min-height:\s*72px/s,
  )
  assert.match(
    precision,
    /\.action-progress-summary\s*{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.match(planTab, /className="card-decision-meta"/)
  assert.match(
    precision,
    /\.card-decision-meta\s*{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s,
  )
})

test('卡片操作区用推荐动作建立主次且不再额外画顶部分隔线', () => {
  assert.match(
    precision,
    /\.hold-item > \.pi-actions\s*{[^}]*border-top:\s*0/s,
  )
  assert.match(
    precision,
    /\.plan-cand \.pc-actions\s*{[^}]*border-top:\s*0/s,
  )
  assert.match(
    precision,
    /\.pi-trade-actions \.act-add\.recommended\s*{[^}]*background:\s*var\(--color-accent\)/s,
  )
  assert.match(
    precision,
    /\.pi-trade-actions \.act-reduce\.recommended\s*{[^}]*background:\s*var\(--color-warning\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*21\.25rem\)\s*{[\s\S]*?\.pi-trade-actions\s*{[^}]*minmax\(0,\s*7fr\)/s,
  )
})

test('策略摘要不再使用遮挡卡片的悬浮预览且文字区域直接进入详情', () => {
  assert.doesNotMatch(
    planTab,
    /className="action-command-preview"[\s\S]*?完整操作建议[\s\S]*?\{instruction\}/,
  )
  assert.match(
    planTab,
    /className="action-command-text"\s+title=\{instruction\}/,
  )
  assert.match(
    planTab,
    /className="action-command"[\s\S]*?title="查看完整建议"[\s\S]*?onClick=\{onOpen\}/,
  )
  assert.doesNotMatch(planTab, /className="action-command-open"/)
})

test('持仓卡先展示指令再展示仓位核心数据与次级盘面证据', () => {
  const holdStart = planTab.indexOf(
    '<div className="trade-card hold-item"',
  )
  const holdEnd = planTab.indexOf(
    '{operationForm && (mobileOperations',
    holdStart,
  )
  const holdCard = planTab.slice(holdStart, holdEnd)
  const metricsStart = planTab.indexOf(
    '<div className="stock-card-metrics hold-card-metrics"',
  )
  const pulseStart = planTab.indexOf(
    '<MarketPulse quote={q}',
    metricsStart,
  )
  const metrics = planTab.slice(metricsStart, pulseStart)

  assert.match(
    metrics,
    />持仓<\/span>[\s\S]*?>成本<\/span>[\s\S]*?>今日可卖<\/span>/,
  )
  assert.ok(
    holdCard.indexOf('className="card-decision-slot"')
    < holdCard.indexOf('className="stock-card-metrics hold-card-metrics"'),
  )
  assert.match(
    precision,
    /\.hold-card-metrics\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('自选卡把当前指令放在盘面证据之前并取消四格指标墙', () => {
  assert.match(
    planTab,
    /<CandDecision p=\{p\} q=\{q\} \/>[\s\S]*?<MarketPulse quote=\{q\}/,
  )
  assert.doesNotMatch(
    planTab,
    /className="stock-card-metrics pc-metrics"/,
  )
  assert.equal(
    (planTab.match(/<MarketPulse quote=\{q\}/g) || []).length,
    2,
  )
  assert.match(
    planTab,
    /className="trade-card-pulse" role="group" aria-label="盘面证据"/,
  )
  assert.match(
    precision,
    /\.trade-card-pulse\s*{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s,
  )
})

test('个股详情复用详情请求展示换手量比与主力散户资金', () => {
  assert.match(
    stockDetail,
    /stock_detail\?code=\$\{stock\.code\}[^`]*quote=1/,
  )
  assert.match(stockDetailApi, /fetchQuotes\(\[code\]\)/)
  assert.match(
    quoteApi,
    /export async function fetchQuotes\(codes,\s*dependencies = \{\}\)/,
  )
  assert.match(
    stockDetail,
    /className="detail-market-metrics"[\s\S]*?>换手<\/span>[\s\S]*?>量比<\/span>[\s\S]*?>主力<\/span>[\s\S]*?>散户<\/span>/,
  )
  assert.match(stockDetail, /fmtNum\(quote\?\.turnover,\s*1\)/)
  assert.match(stockDetail, /fmtNum\(quote\?\.volRatio,\s*1\)/)
  assert.match(stockDetail, /fmtInflow\(quote\?\.mainInflow\)/)
  assert.match(stockDetail, /fmtInflow\(quote\?\.retailInflow\)/)
  assert.match(stockDetail, /function hasMarketMetric\(value\)/)
  assert.equal(
    (stockDetail.match(/hasMarketMetric\(quote\?\./g) || []).length,
    4,
  )
  assert.match(
    precision,
    /\.detail-market-metrics\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.detail-market-metrics\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('观望建议只提供重新评估入口且不伪装成建仓建议', () => {
  assert.match(
    planTab,
    /className=\{\s*'pc-actions'[\s\S]{0,180}' with-review'[\s\S]{0,180}' deferred'/,
  )
  assert.match(
    planTab,
    /!actionable[\s\S]*?className="chip-btn ghost review-action"[\s\S]*?重新评估/s,
  )
  assert.doesNotMatch(
    planTab,
    /className="chip-btn ghost manual-build"/,
  )
  assert.match(
    precision,
    /\.plan-cand \.pc-actions\.with-review\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+40px/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.plan-cand \.pc-actions\.with-review\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s+40px/s,
  )
})
