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
const stockPanel = read('src/components/StockPanel.jsx')
const stockDetail = read('src/components/StockDetail.jsx')
const advicePresentation = read('src/components/AdvicePresentation.jsx')
const dailyReport = read('src/components/DailyReport.jsx')
const llmConfig = read('src/components/LLMConfig.jsx')
const planTab = read('src/components/PlanTab.jsx')
const reviewTab = read('src/components/ReviewTab.jsx')
const fundFlowCanvas = read('src/components/FundFlowCanvas.jsx')
const todayTab = read('src/components/TodayTab.jsx')
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

test('白天模式建立明确表面层级并将遗留紫色变量统一映射到钴蓝系统', () => {
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
    /\.plan-section \.ind-tabs\s*{[^}]*margin-top:\s*var\(--space-sm\)[^}]*padding:\s*0\s+var\(--space-2xs\)\s+var\(--space-xs\)/s,
  )
  assert.match(planTab, /function AdviceUpdatedAt\(\{ entry \}\)/)
  assert.equal((planTab.match(/<AdviceUpdatedAt entry=/g) || []).length, 2)
  assert.match(planTab, /className="advice-updated-at"/)
  assert.match(precision, /\.hold-swipe-wrap\s*{[^}]*height:\s*100%/s)
  assert.match(
    precision,
    /\.hold-swipe-wrap > \.hold-item\s*{[^}]*height:\s*100%[^}]*display:\s*flex[^}]*flex-direction:\s*column/s,
  )
  assert.match(
    precision,
    /\.hold-item > \.pi-actions\s*{[^}]*margin-top:\s*auto/s,
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
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.hold-head-actions\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*width:\s*100%/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.hold-head-actions \.advisor-score\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s,
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

test('移动端个股详情铺满视口且正文不叠加大块白色底', () => {
  assert.match(
    precision,
    /html\[data-theme="light"\] \.detail-panel\s*{[^}]*background:\s*var\(--color-paper\)/s,
  )
  assert.match(
    precision,
    /\.detail-panel \.detail-scroll,[\s\S]*?\.detail-panel \.detail-kline\s*{[^}]*background:\s*transparent/s,
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

test('移动端AI选股使用分层卡片与可视化筛选漏斗', () => {
  assert.match(todayTab, /className="pick-funnel"/)
  assert.match(todayTab, /className="pick-identity"/)
  assert.match(todayTab, /className="pick-badges"/)
  assert.match(todayTab, /className="pick-reason-label">研判/)
  assert.match(todayTab, /className="pick-row-value"/)
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.pick-top\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.pick-identity\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*32px\s+minmax\(0,\s*1fr\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.pick-badges\s*{[^}]*display:\s*flex[^}]*grid-column:\s*1\s*\/\s*-1/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.pick-row\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*56px\s+minmax\(0,\s*1fr\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.pick-funnel\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s,
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
