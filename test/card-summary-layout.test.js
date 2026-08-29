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
const calmSurfaceMarker =
  '/* Trade workspace refinement: calm surfaces and content-led height. */'
const calmSurface = precision.slice(precision.indexOf(calmSurfaceMarker))

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

test('持仓与自选卡使用内容驱动高度且不保留空白占位', () => {
  assert.match(planTab, /className="card-decision-slot"/)
  assert.equal((planTab.match(/className="card-decision-slot"/g) || []).length, 2)
  assert.match(
    calmSurface,
    /\.hold-grid,[\s\S]*?\.plan-cand-grid\s*{[^}]*align-items:\s*start/s,
  )
  assert.match(
    calmSurface,
    /\.plan-cand \.card-decision-slot,[\s\S]*?\.hold-item \.card-decision-slot\s*{[^}]*min-height:\s*0/s,
  )
  assert.match(
    calmSurface,
    /\.card-decision-slot > \.action-prompt\s*{[^}]*min-height:\s*48px[^}]*flex:\s*none/s,
  )
  assert.match(
    design,
    /Cards use content-led compact\s+height:[\s\S]*must not reserve large empty regions/s,
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
    /view\.detailActionLabel \|\| '查看后续预案'/,
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

test('卡片通过留白和弱底色分组而不是连续边线', () => {
  assert.match(precision, new RegExp(calmSurfaceMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(
    calmSurface,
    /\.trade-card,[\s\S]*?\.hold-grid \.hold-item\s*{[^}]*border-color:\s*transparent[^}]*box-shadow:\s*var\(--shadow-card\)/s,
  )
  assert.match(
    calmSurface,
    /\.stock-card-metric \+ \.stock-card-metric\s*{[^}]*border-inline-start:\s*0/s,
  )
  assert.match(
    calmSurface,
    /\.hold-pnl\s*{[^}]*border-inline-start:\s*0/s,
  )
  assert.match(
    calmSurface,
    /\.action-decision\s*{[^}]*border-block:\s*0/s,
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

test('个股详情展示最近收盘快照与近5日关键趋势', () => {
  assert.match(
    stockDetail,
    /stock_detail\?code=\$\{stock\.code\}[^`]*quote=1/,
  )
  assert.match(
    stockDetailApi,
    /fetchQuotes\(\[code\],\s*\{\s*now:\s*requestedAt\s*\}\)/,
  )
  assert.match(stockDetailApi, /fetchResilientStockFund\(code/)
  assert.match(stockDetailApi, /buildStockMarketSnapshot/)
  assert.match(
    quoteApi,
    /export async function fetchQuotes\(codes,\s*dependencies = \{\}\)/,
  )
  assert.match(
    stockDetail,
    /className="detail-market-snapshot"[\s\S]*?最近收盘[\s\S]*?换手[\s\S]*?量比[\s\S]*?主力净额[\s\S]*?小单净额[\s\S]*?近\{marketSnapshot\.recent5\.dayCount\}日[\s\S]*?价格变化[\s\S]*?收涨天数[\s\S]*?主力累计[\s\S]*?小单累计/,
  )
  assert.match(stockDetail, /formatYi\(marketSnapshot\.latest\.mainNetYi\)/)
  assert.match(stockDetail, /formatYi\(marketSnapshot\.recent5\.mainNetYi\)/)
  assert.match(
    precision,
    /\.detail-market-snapshot\s*{[^}]*background:\s*var\(--color-paper-3\)/s,
  )
  assert.match(
    precision,
    /\.detail-market-grid\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.detail-market-grid\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('个股详情以决策优先并移除指标表格线', () => {
  const quoteIndex = stockDetail.indexOf('className="detail-quote"')
  const formulaIndex = stockDetail.indexOf('<FormulaPrice')
  const noteIndex = stockDetail.indexOf(
    'className="stock-note-anchor detail-note-section"',
  )
  assert.ok(quoteIndex >= 0)
  assert.ok(formulaIndex > quoteIndex)
  assert.ok(noteIndex > formulaIndex)
  assert.match(
    calmSurface,
    /\.detail-market-grid\s*{[^}]*border:\s*0[^}]*gap:/s,
  )
  assert.match(
    calmSurface,
    /\.detail-market-metric\s*{[^}]*border-inline-start:\s*0/s,
  )
  assert.match(
    calmSurface,
    /\.detail-panel \.formula-price-panel\s*{[^}]*border-top:\s*0/s,
  )
})

test('观望建议保留重新评估且始终允许用户手动建仓', () => {
  assert.match(
    planTab,
    /className=\{\s*'pc-actions with-review'[\s\S]{0,180}' deferred'/,
  )
  assert.match(
    planTab,
    /className="chip-btn act-buy manual-build"[\s\S]*?onClick=\{\(\) => onBuy\(p, null\)\}[\s\S]*?手动建仓/s,
  )
  assert.match(
    planTab,
    /const detailActionLabel = !view[\s\S]*?'生成建议'[\s\S]*?view\.deferred[\s\S]*?'查看后续预案'[\s\S]*?'重新评估'[\s\S]*?'查看建议'/s,
  )
  assert.match(
    precision,
    /\.plan-cand \.pc-actions\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(88px,\s*112px\)\s+64px\s+40px[^}]*margin-top:\s*auto/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.plan-cand \.pc-actions\.with-review\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s+40px/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.plan-cand \.pc-actions\.with-review \.manual-build\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s,
  )
})

test('自选卡使用紧凑决策区且操作栏保持稳定', () => {
  assert.match(
    calmSurface,
    /\.plan-cand \.card-decision-slot,[\s\S]*?\.hold-item \.card-decision-slot\s*{[^}]*min-height:\s*0/s,
  )
  assert.match(
    precision,
    /\.plan-cand \.pc-actions\s*{[^}]*min-height:\s*40px/s,
  )
})

test('持仓卡使用紧凑决策区并统一操作与工具列', () => {
  assert.match(
    calmSurface,
    /\.hold-item \.card-decision-slot\s*{[^}]*min-height:\s*0/s,
  )
  assert.match(
    precision,
    /\.hold-item > \.pi-actions\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+104px[^}]*min-height:\s*40px[^}]*margin-top:\s*auto/s,
  )
  assert.match(
    precision,
    /\.pi-card-tools\s*{[^}]*width:\s*104px/s,
  )
})
