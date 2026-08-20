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
const llmConfig = read('src/components/LLMConfig.jsx')
const quantModelControl = read('src/components/QuantModelControl.jsx')
const planTab = read('src/components/PlanTab.jsx')
const reviewTab = read('src/components/ReviewTab.jsx')
const fundFlowCanvas = read('src/components/FundFlowCanvas.jsx')
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
  assert.match(stockDetail, /planStore\.setAdviceReviewEnabled/)
  assert.match(legacyStyles, /\.advice-review-toggle\.on/)
})

test('军师建议头部固定为标题层与状态层且双端不随机换行', () => {
  assert.match(stockDetail, /className="decide-primary"/)
  assert.match(stockDetail, /className="decide-status"/)
  assert.match(stockDetail, /formatQuantAsOf\(quantState\.result\.asOf\)/)
  assert.match(stockDetail, /reviewEnabled \? '复核已开启' : '复核已关闭'/)
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

test('持仓与自选卡片顶部信息固定单行且长名称省略', () => {
  assert.match(
    legacyStyles,
    /\.hold-head\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto[^}]*flex-wrap:\s*nowrap/s,
  )
  assert.match(
    legacyStyles,
    /\.hold-head-l\s*{[^}]*flex-wrap:\s*nowrap[^}]*overflow:\s*hidden/s,
  )
  assert.match(
    legacyStyles,
    /\.hold-pnl\s*{[^}]*flex-direction:\s*row[^}]*white-space:\s*nowrap/s,
  )
  assert.match(
    legacyStyles,
    /\.pc-top\s*{[^}]*flex-wrap:\s*nowrap/s,
  )
  assert.match(
    legacyStyles,
    /\.pc-name\s*{[^}]*flex-wrap:\s*nowrap[^}]*overflow:\s*hidden/s,
  )
  assert.match(
    legacyStyles,
    /\.pc-top-r\s*{[^}]*flex-direction:\s*row[^}]*white-space:\s*nowrap/s,
  )
})

test('持仓与自选卡把量化分收进建议元信息而不是混入行情首行', () => {
  const holdHeadStart = planTab.indexOf('<div className="hold-head">')
  const holdMetaStart = planTab.indexOf('<div className="hold-meta">', holdHeadStart)
  const adviceStart = planTab.indexOf('<AdviceUpdatedAt', holdMetaStart)
  const holdHead = planTab.slice(holdHeadStart, holdMetaStart)
  const holdMeta = planTab.slice(holdMetaStart, adviceStart)
  const candTopStart = planTab.indexOf('<div className="pc-top">')
  const candMetricsStart = planTab.indexOf('<div className="pc-metrics">', candTopStart)
  const candTop = planTab.slice(candTopStart, candMetricsStart)

  assert.doesNotMatch(holdHead, /<QuantBadge score=\{h\.qScore\}/)
  assert.doesNotMatch(holdMeta, /<QuantBadge score=\{h\.qScore\}/)
  assert.doesNotMatch(candTop, /<QuantBadge score=\{p\.qScore\}/)
  assert.match(planTab, /function AdviceUpdatedAt\(\{ entry, score, bias \}\)/)
  assert.equal(
    (planTab.match(/<AdviceUpdatedAt entry=\{[^}]+\} score=\{[^}]+\.qScore\} bias=\{[^}]+\.qBias\}\s*\/>/g) || []).length,
    2,
  )
  assert.match(
    legacyStyles,
    /\.advice-updated-at \.q-badge\.auxiliary\s*{[^}]*border:\s*0[^}]*background:\s*transparent/s,
  )
})

test('持仓手数与成本在同一水平线且成本加粗', () => {
  assert.match(planTab, /className="hold-qty-value"/)
  assert.match(
    precision,
    /\.hold-meta\s*{[^}]*align-items:\s*center/s,
  )
  assert.match(
    precision,
    /\.hold-qty-value,[\s\S]*?\.hold-cost-value\s*{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*min-height:\s*24px/s,
  )
  assert.match(
    precision,
    /\.hold-cost-value\s*{[^}]*font-weight:\s*700/s,
  )
})

test('白天模式建立明确表面层级并将遗留强调色统一映射到钴蓝系统', () => {
  assert.match(
    tokens,
    /html\[data-theme="light"\]\s*{[\s\S]*?--color-paper:\s*oklch\(96% 0\.01 255\)[\s\S]*?--color-paper-2:\s*oklch\(99% 0\.004 255\)[\s\S]*?--color-paper-3:\s*oklch\(93\.5% 0\.012 255\)[\s\S]*?--color-rule:\s*oklch\(78% 0\.016 255\)/s,
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
  assert.match(fundFlowCanvas, /hub:\s*'#0874d8'/)
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
  assert.equal((planTab.match(/<AdviceUpdatedAt entry=/g) || []).length, 2)
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

test('操作建议卡使用固定价位列且数量与动作保持同组', () => {
  assert.match(planTab, /className="action-command-badge"[\s\S]*?className="action-command-qty"/)
  assert.match(planTab, /'action-levels levels-' \+ Math\.min\(view\.levels\.length,\s*3\)/)
  assert.doesNotMatch(planTab, />当前指令</)
  assert.match(planTab, /progress\.stateLabel/)
  assert.doesNotMatch(planTab, /progress\.metricLabel\}\s*\{progress\.score/)
  assert.match(
    precision,
    /\.action-command\s*{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/s,
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
    /function AdviceActionPanel\(\{ view, currentPrice, onPrompt \}\)/,
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

test('价格路线图放大价格并在到价后有限脉冲提醒', () => {
  assert.match(planTab, /className="action-level-icon"/)
  assert.match(planTab, /className="action-level-price"/)
  assert.match(planTab, /className="action-current-marker"/)
  assert.match(planTab, /progress\.reached\s*&&\s*\([\s\S]*?<span className="action-reached"/)
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
    /\.action-level\.reached\s*{[^}]*animation:\s*action-price-reached[^}]*3/s,
  )
  assert.match(
    precision,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*?\.action-level\.reached\s*{[^}]*animation:\s*none/s,
  )
})

test('价格路线图标题使用固定图标列并允许完整换行', () => {
  assert.match(
    precision,
    /\.action-level-name\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*22px\s+minmax\(0,\s*1fr\)[^}]*white-space:\s*normal[^}]*overflow:\s*visible/s,
  )
  assert.doesNotMatch(
    precision,
    /\.action-level-name\s*{[^}]*overflow:\s*hidden/s,
  )
})

test('持仓页大型展开层统一挂到顶层Portal避免被吸顶区遮盖', () => {
  assert.match(
    planTab,
    /<OverlayPortal>[\s\S]*?className="advisor-score-mask"/,
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

test('持仓卡桌面同高且移动端恢复自然高度', () => {
  assert.match(precision, /\.hold-swipe-wrap\s*{[^}]*height:\s*100%/s)
  assert.match(precision, /\.hold-item > \.pi-actions\s*{[^}]*margin-top:\s*auto/s)
  assert.match(
    precision,
    /\.advice-updated-at\s*{[^}]*border:\s*0[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /\.hold-item > \.pi-actions\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /\.hold-item > \.pi-actions \.chip-btn:not\(\.recommended\)[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*50rem\)\s*{[\s\S]*?\.hold-grid\s*{[^}]*align-items:\s*start[^}]*}[\s\S]*?\.hold-swipe-wrap,[\s\S]*?\.hold-select-wrap\s*{[^}]*height:\s*auto[^}]*}[\s\S]*?\.hold-swipe-wrap > \.hold-item\s*{[^}]*height:\s*auto[^}]*}[\s\S]*?\.hold-item > \.pi-actions\s*{[^}]*margin-top:\s*var\(--space-xs\)/s,
  )
})

test('完整建议只在真实截断时支持点击原位展开', () => {
  assert.match(planTab, /function ActionCommand\(\{ view \}\)/)
  assert.match(planTab, /const \[isTruncated, setIsTruncated\] = useState\(false\)/)
  assert.match(planTab, /textNode\.scrollHeight > textNode\.clientHeight \+ 1/)
  assert.match(planTab, /new ResizeObserver\(measure\)/)
  assert.match(planTab, /isTruncated \? \([\s\S]*?className="action-command-copy"/)
  assert.match(planTab, /className="action-command-copy action-command-copy-static"/)
  assert.doesNotMatch(planTab, /action-command-popover|完整建议<\/strong>/)
  assert.match(planTab, /aria-expanded=\{expanded\}/)
  assert.match(planTab, /document\.addEventListener\('keydown', closeWithEscape\)/)
  assert.match(planTab, /event\.key !== 'Escape'[\s\S]*?setExpanded\(false\)[\s\S]*?\.blur\(\)/)
  assert.match(
    precision,
    /\.action-command-text\s*{[^}]*min-height:\s*4\.5em[^}]*-webkit-line-clamp:\s*3/s,
  )
  assert.doesNotMatch(precision, /action-command-popover/)
  assert.match(
    precision,
    /\.action-command-disclosure\.is-expanded \.action-command-text\s*{[^}]*display:\s*block[^}]*max-height:\s*none[^}]*-webkit-line-clamp:\s*unset/s,
  )
  assert.match(
    precision,
    /\.action-command-copy-static\s*{[^}]*display:\s*block[^}]*cursor:\s*default/s,
  )
})

test('置顶自选卡保留独立金色层级且不被普通卡背景覆盖', () => {
  assert.match(
    precision,
    /\.plan-cand\.starred\s*{[^}]*border-color:\s*color-mix\([^}]*var\(--color-warning\)[^}]*background:\s*color-mix\([^}]*var\(--color-warning\)[^}]*box-shadow:\s*inset\s+0\s+3px\s+0/s,
  )
  assert.match(
    precision,
    /html\[data-theme="light"\] \.plan-cand\.starred\s*{[^}]*border-color:\s*color-mix\([^}]*var\(--color-warning\)[^}]*background:\s*color-mix\([^}]*var\(--color-warning\)/s,
  )
  assert.match(
    precision,
    /\.plan-cand\.starred \.pc-pin\.on\s*{[^}]*color:\s*var\(--color-warning\)/s,
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

test('中等桌面宽度在导航拥挤前收起命令入口并使用短标签', () => {
  assert.match(
    precision,
    /@media \(max-width:\s*1360px\)\s*{[\s\S]*?\.nav-command\s*{[^}]*display:\s*none/s,
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

test('移动端个股详情铺满视口且上下结构共用同一底色', () => {
  assert.match(
    precision,
    /html\[data-theme="light"\] \.detail-panel\s*{[^}]*background:\s*var\(--color-paper\)/s,
  )
  assert.match(
    precision,
    /\.detail-panel \.modal-bar,[\s\S]*?\.detail-panel \.detail-footbar,[\s\S]*?\.detail-panel \.detail-kline\s*{[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.modal-mask:has\(\.detail-panel\)\s*{[^}]*padding:\s*0[^}]*background:\s*var\(--color-paper\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.modal-mask:has\(\.detail-panel\) \.detail-panel\s*{[^}]*height:\s*100dvh[^}]*max-height:\s*100dvh[^}]*border-radius:\s*0/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.detail-panel \.modal-bar\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.detail-panel \.detail-kline-head\s*{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s,
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

test('军师建议展示本次实际使用的持仓与资金快照', () => {
  assert.match(advicePresentation, /本次决策账户快照/)
  assert.match(advicePresentation, /context\.holdQty/)
  assert.match(advicePresentation, /context\.cash/)
  assert.match(advicePresentation, /context\.stockWeight/)
  assert.match(
    precision,
    /\.advice-decision-context/,
  )
  assert.match(advicePresentation, /账户风险闸门/)
  assert.match(advicePresentation, /advice\.riskOverlay/)
  assert.match(precision, /\.advice-risk-overlay/)
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

test('模型配置改为单列选择并给复杂表单足够宽度', () => {
  assert.match(
    precision,
    /\.llm-cfg\s*{[^}]*width:\s*min\(720px,/s,
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
