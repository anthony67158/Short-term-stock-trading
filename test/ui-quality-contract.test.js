import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { finiteNum } from '../src/format.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const precision = read('src/styles/precision.css')
const legacyStyles = read('src/styles.css')
const tokens = read('tokens.css')
const assistant = read('src/components/AIAssistant.jsx')
const sectorPanel = read('src/components/SectorPanel.jsx')
const stockPanel = read('src/components/StockPanel.jsx')
const stockDetail = read('src/components/StockDetail.jsx')
const dailyReport = read('src/components/DailyReport.jsx')
const llmConfig = read('src/components/LLMConfig.jsx')
const planTab = read('src/components/PlanTab.jsx')
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

test('异常数值统一降级，交易复盘不会渲染 NaN', () => {
  assert.equal(finiteNum(undefined), 0)
  assert.equal(finiteNum(Number.NaN), 0)
  assert.equal(finiteNum('12.5'), 12.5)
  assert.equal(finiteNum('bad', null), null)
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

test('持仓区共用页面边线且同一行卡片操作区固定到底部', () => {
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
    /\.plan-section \.ind-tabs\s*{[^}]*margin-top:\s*0[^}]*padding-block:\s*0\s+var\(--space-3xs\)/s,
  )
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
