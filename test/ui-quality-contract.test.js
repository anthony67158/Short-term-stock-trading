import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { finiteNum, formatAdviceTime } from '../src/format.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const precision = read('src/styles/precision.css')
const legacyStyles = read('src/styles.css')
const tokens = read('tokens.css')
const app = read('src/App.jsx')
const assistant = read('src/components/AIAssistant.jsx')
const sectorPanel = read('src/components/SectorPanel.jsx')
const sectorHistory = read('src/components/SectorHistory.jsx')
const stockPanel = read('src/components/StockPanel.jsx')
const stockDetail = read('src/components/StockDetail.jsx')
const advicePresentation = read('src/components/AdvicePresentation.jsx')
const dailyReport = read('src/components/DailyReport.jsx')
const dailyReportSchedule = read('src/components/DailyReportSchedule.jsx')
const lhbBoard = read('src/components/LhbBoard.jsx')
const llmConfig = read('src/components/LLMConfig.jsx')
const quantModelControl = read('src/components/QuantModelControl.jsx')
const planTab = read('src/components/PlanTab.jsx')
const todayTab = read('src/components/TodayTab.jsx')
const generationStatus = read('src/components/AdviceGenerationStatus.jsx')
const holdingPlanDialog = read('src/components/HoldingPlanDialog.jsx')
const reviewTab = read('src/components/ReviewTab.jsx')
const fundFlowCanvas = read('src/components/FundFlowCanvas.jsx')
const calmSurface = precision.slice(precision.indexOf(
  '/* Trade workspace refinement: calm surfaces and content-led height. */',
))
const semanticTabSources = [
  'src/components/AlertCenter.jsx',
  'src/components/AlertPanel.jsx',
  'src/components/LhbBoard.jsx',
  'src/components/LimitPool.jsx',
  'src/components/Movers.jsx',
  'src/components/ReviewTab.jsx',
  'src/components/SectorPanel.jsx',
  'src/components/StockPanel.jsx',
].map(read)

test('龙虎榜同一股票多条上榜原因使用复合行标识', () => {
  assert.match(lhbBoard, /key=\{`\$\{s\.code\}:\$\{i\}`\}/)
  assert.doesNotMatch(lhbBoard, /<tr key=\{s\.code\}>/)
})

test('四个工作区共用紧凑页面身份头部且不展示流程指导', () => {
  assert.match(app, /className="workspace-identity"/)
  assert.doesNotMatch(app, /className="workspace-icon"/)
  assert.doesNotMatch(app, /className="workspace-path"/)
  assert.doesNotMatch(app, /currentSection\.steps/)
  assert.doesNotMatch(app, /className="workspace-state"/)
  assert.match(app, /data-section=\{currentSection\.key\}/)
  assert.match(
    precision,
    /\.workspace-head\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  )
  assert.doesNotMatch(
    precision,
    /\.workspace-head\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.doesNotMatch(precision, /\.workspace-path(?:-step|-index|-copy|-next)?\s*[,{]/)
  assert.doesNotMatch(precision, /\.workspace-state(?:-dot|-copy)?\s*[,{.]/)
  assert.doesNotMatch(precision, /\.workspace-icon\s*{/)
})

test('全站表面使用更柔和的圆角层级和低噪声边框', () => {
  assert.match(tokens, /--radius-control:\s*10px/)
  assert.match(tokens, /--radius-input:\s*12px/)
  assert.match(tokens, /--radius-card:\s*16px/)
  assert.match(
    precision,
    /\.panel:not\(\.plan-section\),[\s\S]*?\.trade-card\s*{[^}]*border-color:\s*color-mix\([^}]*box-shadow:\s*var\(--shadow-card\)/s,
  )
  assert.match(
    precision,
    /\.nav,[\s\S]*?\.plan-section-sticky\s*{[^}]*backdrop-filter:\s*none/s,
  )
})

test('所有按钮受父容器约束且卖出按钮保持短标签', () => {
  assert.match(
    precision,
    /button\s*{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/s,
  )
  assert.match(
    precision,
    /\.btn,[\s\S]*?\.sug-price-btn\s*{[^}]*text-overflow:\s*ellipsis/s,
  )
  assert.match(
    precision,
    /\.hold-item > \.pi-actions > \.chip-btn\s*{[^}]*padding-inline:\s*var\(--space-2xs\)[^}]*font-size:\s*var\(--text-xs\)[^}]*white-space:\s*nowrap/s,
  )
  assert.match(planTab, /onClick=\{startAdd\}>加仓<\/button>/)
  assert.match(planTab, /onClick=\{startT\}>做T<\/button>/)
  assert.match(planTab, /onClick=\{startSell\}>减仓\/清仓<\/button>/)
  assert.doesNotMatch(planTab, /按指令(?:加仓|卖出)/)
  assert.doesNotMatch(planTab, /按浮盈金额排序/)
})

test('全站同组按钮等高且纯图标按钮保持正方形', () => {
  assert.match(tokens, /--control-size-compact:\s*36px/)
  assert.match(tokens, /--radius-badge:\s*var\(--radius-pill\)/)
  assert.match(
    precision,
    /button\.icon-btn\s*{[^}]*width:\s*var\(--icon-button-size\)[^}]*min-width:\s*var\(--icon-button-size\)[^}]*height:\s*var\(--icon-button-size\)[^}]*min-height:\s*var\(--icon-button-size\)[^}]*aspect-ratio:\s*1/s,
  )
  assert.match(
    precision,
    /\.nav-meta button\.icon-btn\s*{[^}]*--icon-button-size:\s*var\(--control-size-compact\)/s,
  )
  assert.match(
    precision,
    /\.sector-forecast-head-actions\s*{[^}]*--sector-control-height:\s*var\(--control-size\)/s,
  )
  assert.match(
    precision,
    /\.portfolio-analysis-controls > :is\([\s\S]*?min-height:\s*var\(--control-size\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?button\.icon-btn\s*{[^}]*--icon-button-size:\s*var\(--touch-target\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.plan-cand \.pc-actions > button\s*{[^}]*height:\s*var\(--touch-target\)/s,
  )
})

test('全站面板、指标、表格与反馈状态使用统一视觉语法', () => {
  assert.match(
    stockPanel,
    /className="panel-title"[\s\S]*?<Icon name="layers" size=\{16\}/,
  )
  assert.match(
    sectorHistory,
    /className="panel-title"[\s\S]*?<Icon name="history" size=\{16\}/,
  )
  assert.match(
    precision,
    /\.panel-title:has\(> \.icon\)\s*{[^}]*display:\s*inline-flex[^}]*align-items:\s*center/s,
  )
  assert.match(
    precision,
    /\.panel-title > \.sub-name,[\s\S]*?\.panel-head > \.panel-sub,[\s\S]*?\.rv-chart-title > \.sub-name,[\s\S]*?\.heatmap-modal-copy > \.sub-name,[\s\S]*?\.detail-kline-head \.sub-name\s*{[^}]*display:\s*none/s,
  )
  assert.match(
    precision,
    /\.panel-title > \.icon\s*{[^}]*width:\s*30px[^}]*height:\s*30px[^}]*background:\s*color-mix\(/s,
  )
  assert.match(
    precision,
    /\.mb-idx-price,[\s\S]*?\.sg-v,[\s\S]*?\.acc-hero-val,[\s\S]*?\.acc-cell-v,[\s\S]*?\.ho-v\s*{[^}]*font-weight:\s*700[^}]*line-height:\s*1\.1/s,
  )
  assert.match(
    precision,
    /\.tbl tbody tr\s*{[^}]*height:\s*44px/s,
  )
  assert.match(
    precision,
    /\.panel > \.loading,[\s\S]*?\.panel > \.empty\s*{[^}]*min-height:\s*128px/s,
  )
  assert.match(
    precision,
    /\.panel > \.loading,[\s\S]*?\.panel > \.empty\s*{[^}]*place-items:\s*center/s,
  )
  assert.match(
    precision,
    /\.hub-tabs\s*{[^}]*min-height:\s*48px[^}]*background:\s*var\(--color-paper-3\)/s,
  )
})

test('异常数值统一降级，交易复盘不会渲染 NaN', () => {
  assert.equal(finiteNum(undefined), 0)
  assert.equal(finiteNum(Number.NaN), 0)
  assert.equal(finiteNum('12.5'), 12.5)
  assert.equal(finiteNum('bad', null), null)
})

test('操作建议生成时间使用固定月日时分格式且拒绝非法时间', () => {
  const at = new Date(2026, 7, 13, 9, 5).getTime()
  assert.equal(formatAdviceTime(at), '08-13 09:05')
  assert.equal(formatAdviceTime(null), '')
  assert.equal(formatAdviceTime('bad'), '')
})

test('个股详情提供可访问的单股持续复核开关', () => {
  assert.match(stockDetail, /className={'advice-review-toggle'/)
  assert.match(stockDetail, /aria-pressed={reviewEnabled}/)
  assert.match(stockDetail, /book\.settings\?\.aiAutoAlert !== false/)
  assert.match(stockDetail, /planStore\.setAdviceReviewEnabled/)
  assert.match(legacyStyles, /\.advice-review-toggle\.on/)
})

test('军师建议头部固定为标题层与状态层且双端不随机换行', () => {
  assert.match(stockDetail, /className="decide-primary"/)
  assert.match(stockDetail, /className="decide-status"/)
  assert.match(stockDetail, /formatQuantAsOf\(quantState\.result\.asOf\)/)
  assert.match(stockDetail, /reviewEnabled \? '事件监控' : '仅手动'/)
  assert.doesNotMatch(stockDetail, /<span>持续复核<\/span>/)
  assert.match(
    legacyStyles,
    /\.decide-primary,\s*\.decide-status\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.match(
    legacyStyles,
    /@media \(max-width:\s*540px\)\s*{[\s\S]*?\.decide-head\s*{[^}]*gap:\s*8px/s,
  )
})

test('持仓与自选卡片共用真实股票题材标签且移动端可换行', () => {
  assert.match(planTab, /<StockName[\s\S]{0,80}code={p\.code}/)
  assert.match(planTab, /<StockName[\s\S]{0,80}code={h\.code}/)
  assert.doesNotMatch(planTab, /<StockTags code={p\.code}[^>]*variant="card"/)
  assert.doesNotMatch(planTab, /<StockTags code={h\.code}[^>]*variant="card"/)
  assert.match(legacyStyles, /\.stock-theme-tags\s*{[^}]*flex-wrap:\s*wrap/s)
  assert.match(legacyStyles, /\.stock-theme-tag\.concept/)
  assert.match(legacyStyles, /\.stock-theme-tag\.industry/)
})

test('持仓与自选卡片使用独立身份行且决策优先于次级指标', () => {
  assert.match(
    planTab,
    /className=\{'trade-card hold-item stock-detail-card-hitarea'[\s\S]*?\(holdAdvice \? ' has-advice' : ' no-advice'\)/,
  )
  assert.match(planTab, /className="stock-card-metrics hold-card-metrics"/)
  assert.match(planTab, /className={'trade-card plan-cand'/)
  assert.doesNotMatch(planTab, /className="stock-card-metrics pc-metrics"/)
  assert.equal(
    (planTab.match(/<MarketPulse quote=\{q\}/g) || []).length,
    2,
  )
  assert.match(planTab, /className={'pc-pin'/)
  assert.match(
    precision,
    /\.hold-card-metrics\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /\.stock-card-metrics\s*{[^}]*border:\s*0[^}]*border-radius:\s*var\(--radius-input\)/s,
  )
  assert.match(
    precision,
    /\.stock-card-metric\s*{[^}]*min-width:\s*0[^}]*padding:\s*var\(--space-xs\)/s,
  )
  assert.match(
    precision,
    /\.pc-top\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+var\(--space-xl\)/s,
  )
  assert.match(
    precision,
    /\.hold-head-market\s*{[^}]*display:\s*flex[^}]*justify-content:\s*flex-end/s,
  )
})

test('持仓交易计划使用独立浮层且不再展开拉长卡片', () => {
  const holdingItem = planTab.slice(
    planTab.indexOf('function HoldingItem'),
    planTab.indexOf('// 单条做T流水行'),
  )

  assert.match(planTab, /import HoldingPlanDialog/)
  assert.match(holdingItem, /'holding-plan-summary'/)
  assert.match(
    holdingPlanDialog,
    /<OverlayPortal>[\s\S]*?className="modal-mask holding-plan-mask"[\s\S]*?className="holding-plan-dialog"/,
  )
  assert.match(
    holdingItem,
    /'modal-mask mobile-trade-mask plan-edit-mask'/,
  )
  assert.doesNotMatch(holdingItem, /className="hold-detail"/)
  assert.doesNotMatch(holdingItem, /setExpanded/)
  assert.match(
    precision,
    /\.holding-plan-dialog\s*{[^}]*width:\s*min\(520px,[^}]*background:\s*var\(--color-paper-2\)/s,
  )
  assert.match(
    precision,
    /\.holding-plan-boundaries\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.holding-plan-mask,\s*[\s\S]*?\.plan-edit-mask\s*{[^}]*align-items:\s*flex-end[^}]*justify-content:\s*flex-end/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.holding-plan-dialog,\s*[\s\S]*?\.plan-edit-dialog\s*{[^}]*position:\s*absolute[^}]*inset-inline:\s*0[^}]*bottom:\s*0/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.holding-plan-footer\s*{[^}]*padding-bottom:\s*max\(var\(--space-sm\),\s*env\(safe-area-inset-bottom\)\)/s,
  )
})

test('面板标题、空态与账户标签只绘制单层边界', () => {
  assert.match(
    precision,
    /\.panel > \.panel-head \+ \.empty:not\(\.err\),[\s\S]*?\.panel > \.panel-head \+ \.loading\s*{[^}]*border-top:\s*0/s,
  )
  assert.match(
    precision,
    /\.panel > \.panel-head:last-child\s*{[^}]*border-bottom:\s*0/s,
  )
  assert.match(
    precision,
    /\.plan-section \.panel-head\s*{[^}]*border-bottom:\s*0/s,
  )
  assert.match(
    precision,
    /\.hub-tabs\s*{[^}]*border:\s*0/s,
  )
  assert.match(
    precision,
    /\.hub-tab\s*{[^}]*border:\s*0/s,
  )
  assert.match(
    precision,
    /\.hub-tab\.active\s*{[^}]*border:\s*0[^}]*box-shadow:\s*inset 0 -2px 0 var\(--color-accent\)/s,
  )
})

test('个股详情标题与边界保持安全距离', () => {
  assert.match(
    precision,
    /\.detail-panel \.modal-bar\s*{[^}]*min-height:\s*80px[^}]*padding-block:\s*var\(--space-sm\)/s,
  )
  assert.match(
    precision,
    /\.detail-title-block\s*{[^}]*gap:\s*var\(--space-2xs\)/s,
  )
  assert.match(
    precision,
    /\.detail-title-meta\s*{[^}]*min-height:\s*var\(--space-sm\)/s,
  )
})

test('卡片指标与阅读型建议用留白和底色分组而不连续画横线', () => {
  assert.match(
    precision,
    /\.action-decision\s*{[^}]*border:\s*0/s,
  )
  assert.match(
    precision,
    /\.action-levels\s*{[^}]*gap:\s*var\(--space-2xs\)[^}]*border:\s*0/s,
  )
  assert.match(
    precision,
    /\.action-level\s*{[^}]*border:\s*0[^}]*border-radius:\s*var\(--radius-control\)[^}]*background:\s*var\(--color-paper-3\)/s,
  )
  assert.match(
    precision,
    /\.detail-panel \.decide-box\s*{[^}]*border:\s*0/s,
  )
  assert.match(
    precision,
    /\.advice-execution-metrics\s*{[^}]*border:\s*0/s,
  )
  assert.match(
    precision,
    /\.advice-tactical-grid\s*{[^}]*border:\s*0/s,
  )
  assert.match(
    precision,
    /\.advice-core-evidence\s*{[^}]*gap:\s*var\(--space-xs\)[^}]*border:\s*0/s,
  )
  assert.match(
    precision,
    /\.advice-evidence-row\s*{[^}]*border:\s*0/s,
  )
})

test('持仓与自选卡把量化分收进建议元信息而不是混入行情首行', () => {
  const holdHeadStart = planTab.indexOf('<div className="hold-head">')
  const holdDecisionStart = planTab.indexOf('<div className="card-decision-slot">', holdHeadStart)
  const holdMetricsStart = planTab.indexOf('<div className="stock-card-metrics hold-card-metrics">', holdDecisionStart)
  const holdHead = planTab.slice(holdHeadStart, holdDecisionStart)
  const holdMetrics = planTab.slice(holdMetricsStart, planTab.indexOf('<MarketPulse quote={q}', holdMetricsStart))
  const candTopStart = planTab.indexOf('<div className="pc-top">')
  const candDecisionStart = planTab.indexOf('<CandDecision p={p} q={q} />', candTopStart)
  const candTop = planTab.slice(candTopStart, candDecisionStart)

  assert.doesNotMatch(holdHead, /<QuantBadge score=\{h\.qScore\}/)
  assert.doesNotMatch(holdMetrics, /<QuantBadge score=\{h\.qScore\}/)
  assert.doesNotMatch(candTop, /<QuantBadge score=\{p\.qScore\}/)
  assert.match(planTab, /function AdviceUpdatedAt\(\{ entry, score, bias \}\)/)
  assert.equal(
    (planTab.match(/<AdviceUpdatedAt\b/g) || []).length,
    2,
  )
  assert.match(
    legacyStyles,
    /\.advice-updated-at \.q-badge\.auxiliary\s*{[^}]*border:\s*0[^}]*background:\s*transparent/s,
  )
})

test('持仓现价和盈亏置于身份行，三列指标带只保留仓位成本与可卖量', () => {
  assert.match(planTab, /className="stock-card-metrics hold-card-metrics"/)
  assert.match(planTab, /'hold-live-quote '/)
  assert.match(planTab, />持仓<\/span>/)
  assert.match(planTab, />成本<\/span>/)
  assert.match(planTab, />今日可卖<\/span>/)
  assert.match(
    precision,
    /\.hold-card-metrics \.stock-card-metric-value\s*{[^}]*font-family:\s*var\(--font-mono\)[^}]*font-variant-numeric:\s*tabular-nums/s,
  )
  assert.match(
    precision,
    /\.hold-card-metrics \.stock-card-metric\s*\+\s*\.stock-card-metric\s*{[^}]*border-inline-start:\s*1px solid var\(--color-rule-2\)/s,
  )
})

test('白天模式使用品牌银蓝层级并保留交易语义色', () => {
  assert.match(
    tokens,
    /html\[data-theme="light"\]\s*{[\s\S]*?--color-paper:\s*#e8eff7[\s\S]*?--color-paper-2:\s*#f8fafd[\s\S]*?--color-paper-3:\s*#edf3f8[\s\S]*?--color-rule:\s*#afc0d3/is,
  )
  assert.match(
    precision,
    /html\[data-theme="light"\]\s*{[\s\S]*?--panel:\s*var\(--color-paper-2\)[\s\S]*?--accent:\s*var\(--color-accent\)[\s\S]*?--sem-buy:\s*var\(--color-accent\)/s,
  )
  assert.match(
    precision,
    /html\[data-theme="light"\] \.ind-tab\.on\s*{[^}]*background:\s*color-mix\(\s*in oklch,\s*var\(--color-accent\) 9%,\s*var\(--color-paper-2\)\s*\)[^}]*color:\s*var\(--color-accent\)/s,
  )
  assert.match(
    precision,
    /html\[data-theme="light"\] \.ht-fill\s*{[^}]*background:\s*color-mix\(\s*in oklch,\s*var\(--color-accent\) 48%,\s*var\(--color-paper-4\)\s*\)/s,
  )
  assert.doesNotMatch(fundFlowCanvas, /hub:\s*'#6c5ce7'/)
  assert.match(fundFlowCanvas, /hub:\s*'#1f5f9f'/)
  assert.match(tokens, /html\[data-theme="light"\][\s\S]*?--color-accent:\s*#1f5f9f/is)
})

test('数据块网格使用独立间距和边框，不再以1px缝隙拼成连体框', () => {
  assert.match(
    precision,
    /\.acc-grid\s*{[^}]*gap:\s*var\(--space-xs\)[^}]*margin:\s*var\(--space-sm\) var\(--space-md\)[^}]*border:\s*0[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /\.senti-gauge \.sg-cells\s*{[^}]*gap:\s*var\(--space-xs\)[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /\.mf-summary,[\s\S]*?\.rv-attr,[\s\S]*?\.rv-kpi\s*{[^}]*gap:\s*var\(--space-xs\)[^}]*border:\s*0[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /\.dq-ma,[\s\S]*?\.tech-prices,[\s\S]*?\.hcs-grid,[\s\S]*?\.sk-cells\s*{[^}]*gap:\s*var\(--space-xs\)[^}]*border:\s*0[^}]*background:\s*transparent/s,
  )
  assert.doesNotMatch(
    legacyStyles,
    /\.(?:sg-cell|acc-cell|rv-kpi-cell|rv-attr-cell|tech-price-cell)[^{]*\{[^}]*border:\s*none\s*!important/s,
  )
})

test('今日工作台双栏等高且情绪指标桌面端为三列', () => {
  assert.match(precision, /\.today\s*{[^}]*align-items:\s*stretch/s)
  assert.match(
    precision,
    /\.senti-gauge \.sg-cells\s*{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('市场情绪指标卡的标签与数值保持水平居中', () => {
  assert.match(
    precision,
    /\.senti-gauge \.sg-cell\s*{[^}]*justify-content:\s*center[^}]*text-align:\s*center/s,
  )
  assert.match(
    precision,
    /\.senti-gauge \.sg-k,[\s\S]*?\.senti-gauge \.sg-v\s*{[^}]*width:\s*100%[^}]*text-align:\s*center/s,
  )
})

test('盘面指标垂直居中并在数据后直接给出结论与操作参考', () => {
  assert.match(
    precision,
    /\.mb-idx,[\s\S]*?\.mb-stat\s*{[^}]*display:\s*flex[^}]*justify-content:\s*center[^}]*text-align:\s*center/s,
  )
  assert.match(
    todayTab,
    /function MarketInterpretation\(\{ guidance, compact = false \}\)/,
  )
  assert.equal(
    (todayTab.match(/<MarketInterpretation\b/g) || []).length,
    2,
  )
  assert.match(todayTab, /这些数据说明/)
  assert.match(todayTab, /操作参考/)
  assert.match(
    precision,
    /\.market-interpretation\s*{[^}]*display:\s*grid[^}]*border-top:\s*1px solid var\(--color-rule-2\)/s,
  )
})

test('持仓区共用页面边线、筛选栏留出安全区且卡片展示建议更新时间', () => {
  assert.match(
    precision,
    /\.plan-section \.hold-overview\s*{[^}]*margin:\s*var\(--space-sm\)\s+0/s,
  )
  assert.match(
    precision,
    /\.plan-section \.hold-overview\s*{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)[^}]*padding:\s*var\(--space-sm\)\s+var\(--space-md\)/s,
  )
  assert.match(
    precision,
    /\.plan-section \.hold-overview > \.ho-cell\s*{[^}]*align-items:\s*center[^}]*padding-inline:\s*var\(--space-2xs\)[^}]*text-align:\s*center/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*1360px\)\s*{[\s\S]*?\.plan-section \.hold-overview\s*{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)[\s\S]*?\.plan-section \.hold-overview > \.ho-cell\s*{[^}]*grid-column:\s*span 3[\s\S]*?\.plan-section \.hold-overview > \.ho-cell:nth-child\(n \+ 5\)\s*{[^}]*grid-column:\s*span 4/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.plan-section \.hold-overview\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[\s\S]*?\.plan-section \.hold-overview > \.ho-cell:nth-child\(n \+ 5\)\s*{[^}]*grid-column:\s*auto[\s\S]*?\.plan-section \.hold-overview > \.ho-cell:last-child\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s,
  )
  assert.match(
    precision,
    /\.stock-group-filter-track\s*{[^}]*display:\s*flex[^}]*overflow:\s*hidden[^}]*padding:\s*var\(--space-2xs\)\s+0/s,
  )
  assert.match(
    precision,
    /\.stock-group-tabs-viewport\s*{[^}]*flex:\s*1 1 auto[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/s,
  )
  assert.match(
    precision,
    /\.stock-group-filter \.stock-group-tabs\s*{[^}]*padding-inline-start:\s*var\(--space-2xs\)[^}]*border-inline-start:\s*1px solid var\(--color-rule-2\)/s,
  )
  assert.match(planTab, /function AdviceUpdatedAt\(\{ entry, score, bias \}\)/)
  assert.equal((planTab.match(/<AdviceUpdatedAt\b/g) || []).length, 2)
  assert.match(planTab, /className="advice-updated-at"/)
  assert.match(precision, /\.hold-grid\s*{[^}]*align-items:\s*stretch/s)
  assert.match(
    precision,
    /\.hold-swipe-wrap > \.hold-item\s*{[^}]*height:\s*100%[^}]*display:\s*flex[^}]*flex-direction:\s*column/s,
  )
  assert.match(
    precision,
    /\.hold-item > \.pi-actions\s*{[^}]*margin-top:\s*auto[^}]*padding-top:\s*var\(--space-xs\)/s,
  )
})

test('移动端持续复核弹层高于导航和持仓吸顶区域', () => {
  assert.match(
    planTab,
    /<OverlayPortal>\s*<div className="auto-ref-mask"/,
  )
  assert.match(
    precision,
    /\.auto-ref-mask\s*{[^}]*z-index:\s*var\(--z-modal\)/s,
  )
})

test('操作建议卡使用语义图标、仓位徽标与固定价位列', () => {
  assert.match(planTab, /className="action-command-primary"[\s\S]*?className="action-command-qty"/)
  assert.match(planTab, /className="action-command-meta">[\s\S]*?当前指令/)
  assert.match(planTab, /'action-levels levels-' \+ Math\.min\(view\.levels\.length,\s*3\)/)
  assert.match(planTab, /progress\.stateLabel/)
  assert.doesNotMatch(planTab, /progress\.metricLabel\}\s*\{progress\.score/)
  assert.match(planTab, /className="action-command-icon"[\s\S]*?<Icon name=\{icon\}/)
  assert.match(
    precision,
    /\.action-command-icon\s*{[^}]*width:\s*32px[^}]*height:\s*32px[^}]*background:\s*color-mix/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot \.action-command\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot \.action-command\s*{[^}]*border-bottom:\s*0/s,
  )
  assert.match(
    precision,
    /\.action-levels\.levels-3\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /\.action-levels\.editable\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('尚无操作建议使用紧凑单行生成入口', () => {
  assert.match(
    planTab,
    /function AdviceActionPanel\(\{ view, currentPrice, onPrompt, conviction = null \}\)/,
  )
  assert.match(planTab, /className="action-prompt-label">尚无操作建议<\/span>/)
  assert.match(planTab, /className="action-prompt-action">生成<\/span>/)
  assert.doesNotMatch(planTab, /尚无 AI 操作建议，点此生成|>待生成</)
  assert.match(
    precision,
    /\.action-prompt\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*20px\s+minmax\(0,\s*1fr\)\s+auto\s+16px[^}]*min-height:\s*48px[^}]*border:\s*1px solid var\(--color-rule-2\)/s,
  )
  assert.doesNotMatch(
    precision,
    /\.action-prompt\s*{[^}]*border:\s*1px dashed/s,
  )
})

test('价格路线图使用单一触发状态且不重复显示到价提醒', () => {
  assert.match(planTab, /className="action-level-icon"/)
  assert.match(planTab, /className="action-level-price"/)
  assert.match(planTab, /className="action-current-marker"/)
  assert.match(planTab, /className=\{'action-trigger-state ' \+ progress\.tone\}/)
  assert.match(planTab, /progress\.reachedHint/)
  assert.match(planTab, /条件已到，正在提交复核/)
  assert.match(planTab, /等待人工确认/)
  assert.match(
    planTab,
    /const adviceAt = getAdvice\(code, 'buy_advice'\)\?\.at/,
  )
  assert.doesNotMatch(planTab, /adviceAt=\{entry\?\.at\}/)
  assert.doesNotMatch(planTab, /className="action-reached"/)
  assert.doesNotMatch(planTab, />买点预警 ≤/)
  assert.match(
    precision,
    /\.action-level-price\s*{[^}]*font-size:\s*var\(--text-xl\)/s,
  )
  assert.match(
    precision,
    /\.action-level:not\(\.active\) \.action-level-price\s*{[^}]*font-size:\s*var\(--text-lg\)/s,
  )
  assert.match(
    precision,
    /\.action-trigger-state\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/s,
  )
})

test('价格路线图窄卡自动切为两列且语义颜色明确区分', () => {
  assert.match(
    precision,
    /@container \(max-width:\s*560px\)\s*{[\s\S]*?\.card-decision-slot \.action-levels\.levels-3\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot \.action-levels\.levels-3 > \.action-level:nth-child\(3\)\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s,
  )
  assert.match(
    precision,
    /@container \(max-width:\s*560px\)\s*{[\s\S]*?\.card-decision-slot \.action-levels\.editable\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot \.action-level\.level-buy\s*{[^}]*--action-level-color:\s*var\(--color-accent\)/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot \.action-level\.level-sell\s*{[^}]*--action-level-color:\s*var\(--color-warning\)/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot \.action-level\.level-risk\s*{[^}]*--action-level-color:\s*var\(--color-danger\)/s,
  )
})

test('持仓页大型展开层统一挂到顶层Portal避免被吸顶区遮盖', () => {
  assert.match(
    planTab,
    /<OverlayPortal>[\s\S]*?className="advisor-score-mask"/,
  )
  assert.match(
    planTab,
    /className="advisor-pop advisor-score-dialog discipline-dialog"/,
  )
  assert.match(
    planTab,
    /<OverlayPortal>[\s\S]*?className="auto-ref-mask"/,
  )
  assert.doesNotMatch(
    planTab,
    /open && \(mobile[\s\S]*?auto-ref-mask/,
  )
  assert.match(
    planTab,
    /busyModal && \([\s\S]*?<OverlayPortal>[\s\S]*?className="busy-modal-mask"/,
  )
  assert.match(
    precision,
    /\.advisor-score-mask\s*{[^}]*z-index:\s*var\(--z-modal\)[^}]*overflow-y:\s*auto/s,
  )
})

test('持仓与自选卡桌面同排以最高卡片等高并分散内部留白', () => {
  assert.match(calmSurface, /\.hold-grid,[\s\S]*?\.plan-cand-grid\s*{[^}]*align-items:\s*stretch[^}]*grid-auto-rows:\s*auto/s)
  assert.match(calmSurface, /\.hold-swipe-wrap,[\s\S]*?\.plan-cand\s*{[^}]*height:\s*100%/s)
  assert.match(
    calmSurface,
    /\.plan-cand \.card-decision-slot,[\s\S]*?\.hold-item \.card-decision-slot\s*{[^}]*min-height:\s*0/s,
  )
  assert.match(
    calmSurface,
    /\.plan-cand,[\s\S]*?\.hold-grid \.hold-item\s*{[^}]*justify-content:\s*space-between/s,
  )
  assert.match(
    calmSurface,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.hold-swipe-wrap,[\s\S]*?\.plan-cand\s*{[^}]*height:\s*auto[\s\S]*?\.plan-cand,[\s\S]*?\.hold-grid \.hold-item\s*{[^}]*justify-content:\s*flex-start/s,
  )
  assert.match(
    precision,
    /\.advice-updated-at\s*{[^}]*border:\s*0[^}]*background:\s*transparent/s,
  )
  assert.match(
    planTab,
    /className="pi-trade-actions"[\s\S]*?className="pi-card-tools"/s,
  )
  assert.match(
    precision,
    /\.pi-trade-actions\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.hold-item > \.pi-actions\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  )
})

test('卡片内只保留单行建议摘要且完整内容进入个股详情', () => {
  assert.match(planTab, /function ActionCommand\(\{ view, onOpen \}\)/)
  assert.match(
    planTab,
    /<button[\s\S]*?className="action-command"[\s\S]*?onClick=\{onOpen\}/,
  )
  assert.doesNotMatch(planTab, /className="action-command-open"/)
  assert.doesNotMatch(precision, /\.action-command-open/)
  assert.doesNotMatch(planTab, /action-command-disclosure|new ResizeObserver\(measure\)/)
  assert.doesNotMatch(planTab, /action-beginner-note|cardBeginnerNote/)
  assert.doesNotMatch(advicePresentation, /advice-beginner-note|beginnerNote/)
  assert.doesNotMatch(precision, /\.action-beginner-note\s*{/)
  assert.doesNotMatch(precision, /\.advice-beginner-note\s*{/)
  assert.match(
    precision,
    /\.card-decision-slot \.action-command-text\s*{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
  )
  assert.match(
    precision,
    /\.action-command:focus-visible\s*{[^}]*outline:\s*2px solid var\(--color-focus\)/s,
  )
})

test('置顶自选卡使用浅蓝表面、整圈蓝框和强化星标', () => {
  assert.match(
    calmSurface,
    /\.plan-cand\.starred,[\s\S]*?html\[data-theme="light"\] \.plan-cand\.starred\s*{[^}]*border-color:\s*color-mix\([^}]*var\(--color-accent\)\s*52%[^}]*background:\s*color-mix\([^}]*var\(--color-accent\)\s*6%[^}]*box-shadow:\s*none/s,
  )
  assert.match(
    calmSurface,
    /\.plan-cand\.starred \.pc-pin\.on\s*{[^}]*background:[^}]*color:\s*var\(--color-accent\)[^}]*opacity:\s*1/s,
  )
})

test('军师建议正文块统一透明且不再叠加分层底色', () => {
  assert.match(
    precision,
    /\.decide-box \.advice-presentation \.decide-verdict,[\s\S]*?\.decide-box \.advice-presentation \.knowledge-action-review-card\s*{[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /\.decide-box \.advice-presentation \.advice-prices \.ap-cell\s*{[^}]*background:\s*transparent\s*!important/s,
  )
  assert.doesNotMatch(precision, /--advice-surface:/)
})

test('股票搜索框加宽并只由外层绘制一层焦点框', () => {
  assert.match(planTab, /placeholder="搜索股票名称、代码或拼音…"/)
  assert.match(
    precision,
    /\.plan-search\s*{[^}]*width:\s*min\(480px,\s*100%\)[^}]*max-width:\s*100%/s,
  )
  assert.match(
    precision,
    /\.ss-input input:focus-visible\s*{[^}]*outline:\s*none/s,
  )
  assert.match(
    precision,
    /\.ss-input:focus-within\s*{[^}]*outline:\s*0[^}]*box-shadow:\s*0 0 0 1px var\(--color-accent\)/s,
  )
})

test('中等桌面宽度压缩军师入口并使用短标签', () => {
  assert.match(
    precision,
    /@media \(max-width:\s*1360px\)\s*{[\s\S]*?\.nav-command\s*{[^}]*display:\s*inline-flex[^}]*width:\s*var\(--control-size-compact\)[^}]*justify-content:\s*center/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*1360px\)\s*{[\s\S]*?\.nav-command > :is\(span,\s*kbd\)\s*{[^}]*display:\s*none/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*1360px\)\s*{[\s\S]*?\.nav-label-full\s*{[^}]*display:\s*none/s,
  )
})

test('平板宽度进一步压缩顶栏工具避免主导航重叠', () => {
  assert.match(
    precision,
    /@media \(max-width:\s*1024px\)\s*{[\s\S]*?\.nav-name,[\s\S]*?\.nav-status,[\s\S]*?\.nav-theme\s*{[^}]*display:\s*none/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*1024px\)\s*{[\s\S]*?\.nav-refresh span\s*{[^}]*display:\s*none/s,
  )
})

test('顶栏刷新使用强调样式且撤回使用独立图标避免误触', () => {
  assert.match(app, /className="nav-refresh-label">刷新</)
  assert.match(app, /className="nav-refresh-count">\{remain\}s</)
  assert.match(app, /className="icon-btn nav-undo"[\s\S]*?<Icon name="undo"/s)
  assert.doesNotMatch(app, /<Icon name="refresh" size=\{15\} className="flip-x"/)
  assert.match(
    precision,
    /\.nav-refresh\s*{[^}]*border-color:\s*var\(--color-accent\)[^}]*background:\s*var\(--color-accent\)[^}]*color:\s*var\(--color-accent-ink\)/s,
  )
  assert.match(
    precision,
    /button\.icon-btn\.nav-undo\s*{[^}]*border-color:\s*var\(--color-rule-2\)[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /button\.icon-btn\.nav-undo:disabled\s*{[^}]*opacity:\s*1[^}]*color:\s*var\(--color-neutral\)/s,
  )
  assert.match(
    precision,
    /\.icon-btn\.nav-bell,[\s\S]*?\.icon-btn\.nav-undo\s*{[^}]*overflow:\s*visible/s,
  )
})

test('每日操作流水统一编辑日期价格手数并提示OSS云端保存', () => {
  assert.match(reviewTab, /planStore\.updateClosedTrade\(/)
  assert.match(reviewTab, /成交价格/)
  assert.match(reviewTab, /成交手数/)
  assert.match(reviewTab, /买入价格/)
  assert.match(reviewTab, /卖出价格/)
  assert.match(reviewTab, /阿里云 OSS/)
  assert.match(
    precision,
    /\.trade-edit-grid\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*520px\)\s*{[\s\S]*?\.trade-edit-grid\s*{[^}]*grid-template-columns:\s*1fr/s,
  )
})

test('交易流水在工具栏下方提供紧凑的周月收益汇总带', () => {
  assert.match(reviewTab, /className="trade-period-performance"/)
  assert.match(reviewTab, /周期收益/)
  assert.match(reviewTab, /periodMode === 'month'/)
  assert.match(reviewTab, /periodMode === 'week'/)
  assert.match(reviewTab, /listTradePeriods/)
  assert.match(reviewTab, /summarizeTradePeriod/)
  assert.match(reviewTab, /账户收益率/)
  assert.match(reviewTab, /当前总资产/)
  assert.match(reviewTab, /交易收益率/)
  assert.match(
    precision,
    /\.trade-period-performance\s*{[^}]*display:\s*grid[^}]*grid-template-columns:/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.trade-period-performance\s*{[^}]*grid-template-columns:\s*1fr/s,
  )
  const periodStyles = precision.slice(precision.indexOf('.trade-period-performance'))
  const tabletStyles = periodStyles.slice(
    periodStyles.indexOf('@media (max-width: 720px)'),
    periodStyles.indexOf('@media (max-width: 520px)'),
  )
  assert.match(
    tabletStyles,
    /\.trade-period-metrics\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('军师抽屉打开时顶栏不被压窄且隐藏重复工具区', () => {
  assert.match(
    precision,
    /\.app\.with-ai \.nav\s*{[^}]*margin-right:\s*0/s,
  )
  assert.match(
    precision,
    /\.app\.with-ai \.nav-command,[\s\S]*?\.app\.with-ai \.nav-meta\s*{[^}]*display:\s*none/s,
  )
})

test('军师输入区使用等高网格且快捷键说明不再塞入 placeholder', () => {
  assert.match(assistant, /className="ai-input-help"/)
  assert.doesNotMatch(assistant, /placeholder=.*Enter 发送/)
  assert.match(
    precision,
    /\.ai-input-row\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.match(
    precision,
    /\.ai-input-row > \.btn\s*{[^}]*height:\s*44px/s,
  )
})

test('移动端复合头部、分段按钮与批量进度使用稳定单列布局', () => {
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.plan-head\s*{[^}]*align-items:\s*stretch[^}]*flex-direction:\s*column/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.portfolio-command-actions\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*width:\s*100%/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.portfolio-command-actions \.advisor-score\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?button\.tab,\s*button\.ai-chip,\s*button\.qa-preset,\s*button\.expand-btn\s*{[^}]*min-height:\s*40px/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?button\.th-inner\s*{[^}]*min-height:\s*40px/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.batch-prog \.bp-head\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.batch-prog \.bp-items\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.batch-prog \.bp-chip\s*{[^}]*width:\s*100%[^}]*min-height:\s*40px/s,
  )
})

test('移动端军师入口并入底部五栏导航且不再悬浮遮挡内容', () => {
  assert.match(assistant, /className={'ai-fab'/)
  assert.match(assistant, /<span className="ai-fab-text">军师<\/span>/)
  assert.match(
    precision,
    /@media \(max-width:\s*900px\)\s*{[\s\S]*?\.nav-tabs\s*{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*900px\)\s*{[\s\S]*?\.ai-fab\s*{[^}]*bottom:\s*calc\(var\(--space-2xs\)\s*\+\s*env\(safe-area-inset-bottom\)\)[^}]*width:\s*calc\(20vw\s*-\s*var\(--space-2xs\)\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*900px\)\s*{[\s\S]*?\.ai-fab-text\s*{[^}]*display:\s*block/s,
  )
})

test('移动端面板标题和说明采用单行省略而不是挤压操作按钮', () => {
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.panel-title\s*{[^}]*min-width:\s*0/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.panel-title \.sub-name\s*{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.hub-tab\s*{[^}]*min-width:\s*0[^}]*min-height:\s*44px/s,
  )
})

test('移动端个股详情填满视口遮罩且上下结构共用同一底色', () => {
  assert.match(
    precision,
    /html\[data-theme="light"\] \.detail-panel\s*{[^}]*background:\s*var\(--color-paper-2\)/s,
  )
  assert.match(
    precision,
    /\.detail-panel \.modal-bar,[\s\S]*?\.detail-panel \.detail-footbar,[\s\S]*?\.detail-panel \.detail-kline\s*{[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.modal-mask:has\(\.detail-panel\)\s*{[^}]*padding:\s*0[^}]*background:\s*var\(--color-paper-2\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.modal-mask:has\(\.detail-panel\) \.detail-panel\s*{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*width:\s*auto[^}]*height:\s*auto[^}]*max-height:\s*none[^}]*border-radius:\s*0/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.detail-panel \.modal-bar\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.detail-panel \.detail-kline-head\s*{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.detail-panel \.detail-footbar\s*{[^}]*padding-bottom:\s*max\(var\(--space-sm\),\s*env\(safe-area-inset-bottom\)\)[^}]*background:\s*var\(--color-paper-2\)/s,
  )
})

test('个股详情头部按身份、标签、图标操作分层且禁止挤压换行', () => {
  assert.match(stockDetail, /className="detail-title-block"/)
  assert.match(stockDetail, /className="detail-title-primary"/)
  assert.match(stockDetail, /className="detail-title-meta"/)
  assert.match(stockDetail, /className="detail-stock-name"/)
  assert.match(stockDetail, /aria-label={watchAction\.label}/)
  assert.doesNotMatch(stockDetail, /<span>{watchAction\.label}<\/span>/)
  assert.doesNotMatch(stockDetail, /className="detail-refresh-txt"/)
  assert.match(
    legacyStyles,
    /\.detail-title-primary\s*{[^}]*flex-wrap:\s*nowrap[^}]*white-space:\s*nowrap/s,
  )
  assert.match(
    legacyStyles,
    /\.detail-title-meta\s*{[^}]*flex-wrap:\s*nowrap[^}]*overflow:\s*hidden/s,
  )
  assert.match(
    legacyStyles,
    /\.detail-panel \.modal-actions\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*40px\)/s,
  )
})

test('个股图表延迟调整尺寸前确认实例仍然存活', () => {
  assert.match(
    stockDetail,
    /if \(!chart\.isDisposed\(\)\) chart\.resize\(\)/,
  )
})

test('详情与汇报采用单层容器且不使用侧色条卡片', () => {
  assert.match(
    precision,
    /\.detail-quote\s*{[^}]*border:\s*0/s,
  )
  assert.match(
    precision,
    /\.decide-box\s*{[^}]*border-inline:\s*0/s,
  )
  assert.match(
    precision,
    /\.qrp-card\s*{[^}]*border-inline-start:\s*0/s,
  )
  assert.match(
    precision,
    /\.dr-sector\s*{[^}]*border-inline-start:\s*0/s,
  )
})

test('白天模式的军师建议区铺满详情宽度且不露出纯白侧边底框', () => {
  assert.match(
    precision,
    /\.detail-panel\s*{[^}]*--detail-inline:\s*var\(--space-lg\)/s,
  )
  assert.match(
    precision,
    /\.detail-panel \.decide-box\s*{[^}]*width:\s*calc\(100% \+ var\(--detail-inline\) \+ var\(--detail-inline\)\)[^}]*max-width:\s*none[^}]*margin-inline:\s*calc\(-1 \* var\(--detail-inline\)\)[^}]*padding-inline:\s*var\(--detail-inline\)[^}]*background:\s*color-mix/s,
  )
  assert.match(
    precision,
    /html\[data-theme="light"\] \.detail-panel \.decide-box\s*{[^}]*background:\s*var\(--color-paper\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.detail-panel\s*{[^}]*--detail-inline:\s*var\(--space-sm\)/s,
  )
})

test('个股详情执行摘要改为纵向节奏并与边线保持稳定留白', () => {
  assert.match(
    precision,
    /\.modal-mask:has\(\.detail-panel\) \.detail-panel\s*{[^}]*width:\s*min\(1040px,\s*calc\(100vw - 48px\)\)/s,
  )
  assert.match(
    precision,
    /\.decide-head\s*{[^}]*padding-block:\s*var\(--space-md\)[^}]*border-bottom:\s*0/s,
  )
  assert.match(
    precision,
    /\.advice-command-body\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*gap:\s*var\(--space-md\)/s,
  )
  assert.match(
    precision,
    /\.advice-execution-metrics\s*{[^}]*width:\s*100%[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)[^}]*border:\s*1px solid var\(--color-rule-2\)/s,
  )
  assert.match(
    precision,
    /\.advice-tactical-grid\s*{[^}]*gap:\s*var\(--space-xl\)[^}]*padding-block:\s*var\(--space-lg\)/s,
  )
})

test('观察价位与到价动作使用同一纵向骨架并在桌面共享对齐基线', () => {
  assert.match(
    advicePresentation,
    /className=\{`advice-observation-status \$\{reviewEnabled \? 'on' : 'off'\}`\}/,
  )
  assert.match(advicePresentation, /任一到价后自动启动复核/)
  assert.match(
    precision,
    /\.advice-tactical-grid\.observation-only\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*gap:\s*0/s,
  )
  assert.match(
    precision,
    /\.advice-tactical-grid\.observation-only \.advice-levels,\s*\.advice-tactical-grid\.observation-only \.advice-trigger\s*{[^}]*grid-template-columns:\s*minmax\(132px,\s*\.28fr\)\s+minmax\(0,\s*1fr\)/s,
  )
  assert.match(
    precision,
    /\.advice-tactical-grid\.observation-only \.advice-trigger-rows\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('军师建议展示本次实际使用的持仓与资金快照', () => {
  assert.match(advicePresentation, /本次决策账户快照/)
  assert.match(advicePresentation, /context\.holdQty/)
  assert.match(advicePresentation, /context\.cash/)
  assert.match(advicePresentation, /context\.stockWeight/)
  assert.match(
    precision,
    /\.advice-decision-context/,
  )
  assert.match(advicePresentation, /账户风险检查/)
  assert.match(advicePresentation, /displayAdvice\.riskOverlay/)
  assert.match(precision, /\.advice-risk-overlay/)
})

test('完整依据与复核使用独立卡片栈间距且内部证据块延续同一节奏', () => {
  assert.match(
    advicePresentation,
    /expanded && \(\s*<div className="advice-deep-content">/,
  )
  assert.match(
    precision,
    /\.advice-deep-content\s*{[^}]*display:\s*grid[^}]*gap:\s*var\(--space-sm\)[^}]*padding-block:\s*var\(--space-xs\)\s*var\(--space-lg\)/s,
  )
  assert.match(
    precision,
    /\.advice-deep-body\s*{[^}]*display:\s*grid[^}]*gap:\s*var\(--space-sm\)/s,
  )
  assert.match(
    precision,
    /\.advice-deep-content\s*>\s*\*[^}]*margin-block:\s*0/s,
  )
})

test('持仓总览提供隔夜新买与卖出执行的当日损益归因', () => {
  assert.match(planTab, /computeDailyAttribution/)
  assert.match(planTab, /当日损益归因/)
  assert.match(planTab, /隔夜持仓/)
  assert.match(planTab, /今日新买/)
  assert.match(planTab, /卖出执行/)
  assert.match(precision, /\.daily-attribution/)
})

test('持仓总览将做T收入收进可展开的今日操作盈亏', () => {
  assert.match(planTab, /computeTodayOperationPnl/)
  assert.match(planTab, /今日操作盈亏/)
  assert.match(planTab, /className="ho-cell ho-operation-pnl"/)
  assert.match(planTab, /aria-expanded={showOperationPnl}/)
  assert.match(planTab, /减仓 \/ 清仓/)
  assert.match(planTab, /扣费后已实现/)
  assert.doesNotMatch(planTab, /<span className="ho-k">今日做T<\/span>/)
  assert.match(precision, /\.ho-operation-pnl/)
  assert.match(precision, /\.operation-pnl-detail/)
})

test('模型配置为角色端点网格提供足够宽度', () => {
  assert.match(
    precision,
    /\.llm-cfg\s*{[^}]*width:\s*min\(960px,/s,
  )
  assert.match(
    precision,
    /\.llm-role-endpoints\.dual\s*{[^}]*grid-template-columns:\s*repeat\(2,/s,
  )
  assert.match(
    precision,
    /\.qmc-options\s*{[^}]*grid-template-columns:\s*1fr/s,
  )
  assert.match(
    precision,
    /\.qmc-option\s*{[^}]*min-height:\s*0/s,
  )
})

test('量化模型配置以生产模型前向回测命中率为主并按日展示', () => {
  assert.match(quantModelControl, /function ProductionAccuracyPanel/)
  assert.match(quantModelControl, /生产模型实际回测/)
  assert.match(quantModelControl, /productionAccuracy\.overall\.accuracyPct/)
  assert.match(quantModelControl, /productionAccuracy\.overall\.correct/)
  assert.match(quantModelControl, /productionAccuracy\.nextTradeDayDirection/)
  assert.match(quantModelControl, /productionAccuracy\.nextTradeDayRange/)
  assert.match(quantModelControl, /次日方向/)
  assert.match(quantModelControl, /次日区间覆盖/)
  assert.match(quantModelControl, /平衡准确率/)
  assert.match(quantModelControl, /强信号命中/)
  assert.match(quantModelControl, /productionAccuracy\.days/)
  assert.match(quantModelControl, /只统计训练截止日后/)
  assert.match(quantModelControl, /AUC仅衡量排序能力/)
  assert.match(precision, /\.qmc-production-metrics/)
  assert.match(precision, /\.qmc-backtest-meta/)
})

test('生产模型每日回测默认折叠且展开后展示所有历史日期', () => {
  assert.match(quantModelControl, /className="qmc-backtest-history"/)
  assert.match(quantModelControl, /<summary>/)
  assert.match(quantModelControl, /每日前向回测/)
  assert.match(quantModelControl, /historyDays\.map\(\(day\)/)
  assert.doesNotMatch(quantModelControl, /days\.slice\(0,\s*6\)/)
  assert.match(precision, /\.qmc-backtest-history > summary/)
  assert.match(precision, /\.qmc-backtest-days/)
})

test('做T使用独立居中弹窗而不是与策略日报共用右侧抽屉定位', () => {
  assert.match(planTab, /className="modal-mask t-trade-mask"/)
  assert.doesNotMatch(planTab, /className="modal-mask mask-drawer t-trade-mask"/)
  assert.match(
    precision,
    /\.t-trade-mask\s*{[^}]*flex-direction:\s*column[^}]*align-items:\s*center[^}]*justify-content:\s*center/s,
  )
  assert.match(
    precision,
    /\.t-trade-mask > \.t-drawer\s*{[^}]*margin:\s*0[^}]*height:\s*auto[^}]*max-height:/s,
  )
})

test('热力图全屏使用独立头部结构避免移动端标题碰撞', () => {
  for (const source of [sectorPanel, stockPanel]) {
    assert.match(source, /heatmap-modal-mask/)
    assert.match(source, /heatmap-modal-bar/)
    assert.match(source, /heatmap-modal-copy/)
  }
})

test('核心 Tab 与关闭控件使用真实 button 元素', () => {
  for (const source of semanticTabSources) {
    assert.doesNotMatch(source, /<div[^>]+className=\{?'tab/)
  }
  for (const source of [
    sectorPanel,
    stockPanel,
    stockDetail,
    dailyReport,
    llmConfig,
  ]) {
    assert.doesNotMatch(source, /<div[^>]+className="modal-close"/)
  }
})

test('策略日报提供云端自动生成开关与三个场次时间', () => {
  const aiClient = read('src/ai.js')

  assert.match(dailyReport, /<DailyReportSchedule/)
  assert.match(dailyReportSchedule, /fetchDailyReportSchedule/)
  assert.match(dailyReportSchedule, /saveDailyReportSchedule/)
  assert.match(dailyReportSchedule, /role="switch"/)
  assert.match(dailyReportSchedule, /aria-label="开启或关闭日报自动生成"/)
  assert.match(dailyReportSchedule, /SESSIONS\.map\(\(item\)/)
  assert.match(dailyReportSchedule, /type="time"/)
  assert.match(dailyReportSchedule, /盘前日报/)
  assert.match(dailyReportSchedule, /午间日报/)
  assert.match(dailyReportSchedule, /收盘日报/)
  assert.doesNotMatch(dailyReport, /planStore|holdings|watchlist/)
  assert.match(aiClient, /body:\s*'\{\}'/)
  assert.match(aiClient, /export async function fetchDailyReportSchedule/)
  assert.match(aiClient, /export async function saveDailyReportSchedule/)
  assert.match(
    precision,
    /\.dr-auto-grid\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('图表、表格与系统材质共用统一布局契约', () => {
  assert.match(precision, /\.data-table-scroll\s*{[^}]*container-name:\s*data-table[^}]*overflow:\s*auto/s)
  assert.match(precision, /@container data-table \(max-width:\s*44rem\)/)
  assert.match(precision, /\.market-treemap-chart\s*{[^}]*height:\s*clamp/s)
  assert.match(precision, /\.portfolio-heatmap-detail\s*{[^}]*grid-template-columns:\s*repeat\(5/s)
  assert.match(precision, /@media \(prefers-reduced-transparency:\s*reduce\)/)
})

test('页面根容器透明、吸顶筛选无框不透底且主内容左右等距', () => {
  assert.match(
    precision,
    /\.today,\s*\.plan,\s*\.hub,\s*\.research,\s*\.review,\s*\.hub-body,\s*\.research-section\s*{[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /\.plan-section-sticky,\s*\.plan-section-hold-sticky\s*{[^}]*border:\s*0[^}]*border-radius:\s*0[^}]*background-color:\s*var\(--color-paper\)[^}]*background-image:\s*var\(--gradient-app\)[^}]*background-attachment:\s*fixed/s,
  )
  assert.match(
    precision,
    /\.main\s*{[^}]*padding:\s*var\(--space-lg\)\s*max\(var\(--space-lg\),\s*env\(safe-area-inset-right\)\)\s*var\(--space-2xl\)\s*max\(var\(--space-lg\),\s*env\(safe-area-inset-left\)\)/s,
  )
  assert.doesNotMatch(
    precision,
    /@media \(min-width:\s*721px\)\s*{[\s\S]*?\.main,\s*\.footer\s*{[^}]*padding-right:\s*max\([^}]*56px/s,
  )
  assert.match(
    precision,
    /@media \(min-width:\s*721px\)\s*{[^}]*\.ai-fab\s*{[^}]*display:\s*none/s,
  )
})

test('休市卡片不显示到价且自动复核状态只在触发后出现', () => {
  assert.match(
    planTab,
    /const executionOpen = isContinuousTrading\(Date\.now\(\)\)/,
  )
  assert.match(
    planTab,
    /const reached = \(alert\) =>\s*executionOpen &&/,
  )
  assert.match(planTab, /<CandidateReviewStatus/)
  assert.match(planTab, /priceReached=\{anyReached\}/)
  assert.doesNotMatch(planTab, /reviewAlerts\.some\(\(alert\) => !alert\.enabled\)/)
  assert.match(
    generationStatus,
    /adviceReviewCardState\(\s*getBatchState\(\),/,
  )
  assert.match(
    planTab,
    /view\.detailActionLabel \|\| '查看后续预案'/,
  )
  assert.match(
    planTab,
    /view\.deferred \? 'clock' : 'spark'/,
  )
})
