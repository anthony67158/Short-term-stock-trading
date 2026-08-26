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
  assert.match(planTab, /className="action-command-open"/)
  assert.match(planTab, /aria-label="查看完整操作建议"/)
  assert.doesNotMatch(planTab, /action-command-disclosure/)
  assert.doesNotMatch(planTab, /useLayoutEffect/)
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
    /\{view\?\.reviewActionLabel \|\| '下一交易时段复核'\}/,
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
})

test('策略摘要不再使用遮挡卡片的悬浮预览并保留详情入口', () => {
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
    /className="action-command-open"[\s\S]*?title="查看完整建议"/,
  )
})

test('持仓卡在同一指标带展示盘中活跃度与主力散户资金', () => {
  const metricsStart = planTab.indexOf(
    '<div className="stock-card-metrics hold-card-metrics"',
  )
  const decisionStart = planTab.indexOf(
    '<div className="card-decision-slot">',
    metricsStart,
  )
  const metrics = planTab.slice(metricsStart, decisionStart)

  assert.match(
    metrics,
    />现价<\/span>[\s\S]*?>持仓<\/span>[\s\S]*?>成本<\/span>[\s\S]*?>换手<\/span>[\s\S]*?>量比<\/span>[\s\S]*?>主力<\/span>[\s\S]*?>散户<\/span>/,
  )
  assert.match(metrics, /fmtNum\(q\?\.turnover,\s*1\)/)
  assert.match(metrics, /fmtNum\(q\?\.volRatio,\s*1\)/)
  assert.match(metrics, /fmtInflow\(q\?\.mainInflow\)/)
  assert.match(metrics, /fmtInflow\(q\?\.retailInflow\)/)
  assert.equal(
    (metrics.match(/className="stock-card-metrics/g) || []).length,
    1,
  )
  assert.match(
    precision,
    /\.hold-card-metrics \.stock-card-market-metric\s*{[^}]*min-height:\s*44px/s,
  )
  assert.match(
    precision,
    /\.hold-card-metrics \.stock-card-market-metric\s*{[^}]*border-top:\s*1px solid var\(--color-rule-2\)/s,
  )
  assert.match(
    precision,
    /\.hold-card-metrics\s*{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /\.hold-card-metrics \.stock-card-market-metric\s*{[^}]*grid-column:\s*span 3/s,
  )
})

test('自选卡使用四列指标带展示散户资金', () => {
  assert.match(
    planTab,
    /className="stock-card-metrics pc-metrics"[\s\S]*?>换手<\/span>[\s\S]*?>量比<\/span>[\s\S]*?>主力<\/span>[\s\S]*?>散户<\/span>/,
  )
  assert.match(planTab, /fmtInflow\(q\.retailInflow\)/)
  assert.match(
    precision,
    /\.pc-metrics\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('个股详情复用详情请求展示换手量比与主力散户资金', () => {
  assert.match(
    stockDetail,
    /stock_detail\?code=\$\{stock\.code\}[^`]*quote=1/,
  )
  assert.match(stockDetailApi, /fetchQuotes\(\[code\]\)/)
  assert.match(quoteApi, /export async function fetchQuotes\(codes\)/)
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

test('观望建议同时保留手动建仓与复核入口', () => {
  assert.match(
    planTab,
    /className=\{\s*'pc-actions'[\s\S]{0,180}' with-review'[\s\S]{0,180}' deferred'/,
  )
  assert.match(
    planTab,
    /!actionable[\s\S]*?className="chip-btn ghost manual-build"[\s\S]*?onClick=\{\(\) => onBuy\(p, null\)\}[\s\S]*?手动建仓/s,
  )
  assert.match(
    planTab,
    /className="chip-btn ghost review-action"[\s\S]*?复核建议/s,
  )
  assert.match(
    precision,
    /\.plan-cand \.pc-actions\.with-review\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto\s+40px/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.plan-cand \.pc-actions\.with-review\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s+40px/s,
  )
})
