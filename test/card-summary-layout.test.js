import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const planTab = read('src/components/PlanTab.jsx')
const stockDetail = read('src/components/StockDetail.jsx')
const stockDetailData = read('src/stockDetailData.js')
const stockDetailApi = read('api/stock_detail.js')
const quoteApi = read('api/quote.js')
const precision = read('src/styles/precision.css')
const design = read('design.md')
const designGuide = read('docs/DESIGN.md')
const calmSurfaceMarker =
  '/* Trade workspace refinement: calm surfaces and content-led height. */'
const calmSurface = precision.slice(precision.indexOf(calmSurfaceMarker))
const fixedCardMarker =
  '/* Stable trade-card anatomy: compact by default, expands only for real content. */'
const fixedCards = precision.slice(precision.indexOf(fixedCardMarker))

test('持仓与自选卡直接展示核心摘要并保留详情入口', () => {
  assert.equal((planTab.match(/<V3DecisionSummary/g) || []).length, 3)
  assert.match(planTab, /openDetailFromCardEvent/)
  assert.match(planTab, /v3DecisionPresentation/)
  assert.doesNotMatch(planTab, /CardAdviceDisclosure|embeddedFull/)
  assert.doesNotMatch(planTab, /useLayoutEffect/)
})

test('卡片当前动作由V3与账本止损共同投影而不读取旧军师', () => {
  assert.match(
    planTab,
    /const decisionView = v3DecisionPresentation/,
  )
  assert.doesNotMatch(planTab, /TrackingRepairAction|repairTracking/)
  assert.doesNotMatch(planTab, /旧建议只有结论|生成可追踪建议/)
})

test('卡片直接显示最多三条核心监控规则', () => {
  assert.match(
    planTab,
    /const visibleRules = sortedRules\.slice\(0, 3\)/,
  )
  assert.match(
    precision,
    /\.monitoring-rule:nth-child\(n \+ 4\)\s*{[^}]*display:\s*none/s,
  )
  assert.doesNotMatch(planTab, /monitoring-rule-more/)
})

test('卡片主结论使用统一的重要程度与交易语义色', () => {
  assert.match(
    planTab,
    /const importance = actionImportance\(view\)[\s\S]*?className={`action-command importance-\$\{importance\}`}/s,
  )
  assert.match(
    precision,
    /\.action-command\.importance-critical\s*{[^}]*--action-command-emphasis:\s*var\(--color-danger\)/s,
  )
  assert.match(
    precision,
    /\.tone-buy \.action-command\.importance-execute\s*{[^}]*--action-command-emphasis:\s*var\(--color-up\)/s,
  )
  assert.match(
    precision,
    /\.tone-sell \.action-command\.importance-execute\s*{[^}]*--action-command-emphasis:\s*var\(--color-down\)/s,
  )
  assert.match(
    precision,
    /\.action-command\.importance-ready\s*{[^}]*--action-command-emphasis:\s*var\(--color-accent\)/s,
  )
  assert.match(
    precision,
    /\.action-command\.importance-conditional\s*{[^}]*--action-command-emphasis:\s*var\(--color-warning\)/s,
  )
  assert.match(
    precision,
    /\.action-command\.importance-steady\s*{[^}]*--action-command-emphasis:\s*var\(--color-accent-2\)/s,
  )
  assert.match(
    precision,
    /\.action-command\.importance-watch\s*{[^}]*--action-command-emphasis:\s*var\(--color-muted\)/s,
  )
})

test('持仓与自选支持整卡进入详情且保留卡内独立操作', () => {
  assert.match(
    planTab,
    /const CARD_DETAIL_CONTROL_SELECTOR = \[[\s\S]*?'button'[\s\S]*?'input'[\s\S]*?'\.pc-actions'[\s\S]*?'\.pi-actions'/s,
  )
  assert.match(
    planTab,
    /function openDetailFromCardEvent\(event, code, name\)\s*{[\s\S]*?control !== event\.currentTarget[\s\S]*?openStockDetail\(code, name\)/s,
  )
  assert.match(
    planTab,
    /trade-card plan-cand stock-detail-card-hitarea[\s\S]*?role="button"[\s\S]*?onClick=\{\(event\) => openDetailFromCardEvent/s,
  )
  assert.match(
    planTab,
    /trade-card hold-item stock-detail-card-hitarea[\s\S]*?role="button"[\s\S]*?onClick={\(event\) => {[\s\S]*?openDetailFromCardEvent\(event, h\.code, h\.name\)/s,
  )
  assert.match(planTab, /<StockName[\s\S]{0,100}code={p\.code}/)
  assert.match(planTab, /<StockName[\s\S]{0,100}code={h\.code}/)
  assert.match(
    precision,
    /\.stock-detail-card-hitarea\s*{[^}]*cursor:\s*pointer[^}]*}[\s\S]*?\.stock-detail-card-hitarea:focus-visible\s*{[^}]*outline:\s*2px solid var\(--color-focus\)/s,
  )
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

test('交易卡片保留稳定区域且V3空状态按内容收缩', () => {
  assert.match(
    planTab,
    /'trade-card plan-cand stock-detail-card-hitarea v3-card'[\s\S]*?\(cardAdvice \? ' has-advice' : ' no-advice'\)/,
  )
  assert.match(
    planTab,
    /'trade-card hold-item stock-detail-card-hitarea v3-card'[\s\S]*?\(holdAdvice \? ' has-advice' : ' no-advice'\)/,
  )
  assert.match(precision, new RegExp(fixedCardMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(fixedCards, /\.hold-grid \.hold-head,[\s\S]*?\.plan-cand \.pc-top\s*{[^}]*height:\s*64px[^}]*max-height:\s*64px/s)
  assert.match(fixedCards, /\.hold-card-metrics\s*{[^}]*height:\s*76px[^}]*max-height:\s*76px/s)
  assert.match(fixedCards, /\.trade-card-evidence-slot\s*{[^}]*height:\s*24px[^}]*max-height:\s*24px/s)
  assert.match(fixedCards, /\.holding-plan-summary\s*{[^}]*height:\s*44px[^}]*max-height:\s*44px/s)
  assert.match(fixedCards, /\.hold-item > \.pi-actions,[\s\S]*?\.plan-cand \.pc-actions\s*{[^}]*min-height:\s*56px[^}]*max-height:\s*56px/s)
  assert.match(
    design,
    /card shell uses a compact\s+minimum height and collapses empty review or evidence regions/s,
  )
  assert.match(
    fixedCards,
    /\.hold-grid \.hold-item\.v3-card\s*{[^}]*height:\s*auto[^}]*min-height:\s*500px[^}]*max-height:\s*none/s,
  )
  assert.match(
    fixedCards,
    /\.plan-cand\.v3-card\s*{[^}]*height:\s*auto[^}]*min-height:\s*350px[^}]*max-height:\s*none/s,
  )
  assert.match(
    fixedCards,
    /\.trade-card\.v3-card \.v3-decision-summary\s*{[^}]*flex:\s*none/s,
  )
  assert.match(
    fixedCards,
    /\.trade-card\.v3-card \.trade-card-review-slot:empty\s*{[^}]*display:\s*none/s,
  )
  assert.match(
    calmSurface,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.hold-grid,[\s\S]*?\.plan-cand-grid\s*{[^}]*grid-auto-flow:\s*column[^}]*grid-auto-columns:\s*min\(88vw,\s*28rem\)[^}]*overflow-x:\s*auto[^}]*scroll-snap-type:\s*inline mandatory[\s\S]*?\.hold-swipe-wrap,[\s\S]*?\.plan-cand\s*{[^}]*height:\s*100%[^}]*scroll-snap-align:\s*start/s,
  )
})

test('策略摘要分离状态、主动作、仓位和执行条件', () => {
  assert.match(planTab, /className="action-progress-summary"/)
  assert.doesNotMatch(planTab, /className="action-progress-head"/)
  assert.match(
    planTab,
    /\{view\.commandLabel \|\| '当前指令'\}/,
  )
  assert.match(
    planTab,
    /const qtyLabel = actionQtyLabel\(view\.quantity\)/,
  )
  assert.match(
    planTab,
    /\$\{view\.quantityLabel\} · \$\{qtyLabel\}/,
  )
  assert.match(
    planTab,
    /const cardInstruction = view\.cardInstruction \|\| instruction/,
  )
  assert.match(
    planTab,
    /className="action-command-kicker"[\s\S]*?<Icon name="flag"[\s\S]*?className="action-command-main"[\s\S]*?className="action-command-icon"/,
  )
  assert.match(
    planTab,
    /className="action-command-detail"[\s\S]*?className="action-command-detail-label">执行条件[\s\S]*?<Icon name="chevronRight"/,
  )
  assert.match(planTab, /查看跟踪条件/)
  assert.match(
    fixedCards,
    /\.card-decision-slot \.action-command-text\s*{[^}]*max-height:\s*none[^}]*overflow:\s*visible[^}]*-webkit-line-clamp:\s*unset/s,
  )
  assert.match(
    calmSurface,
    /\.action-command-main\s*{[^}]*grid-template-columns:\s*32px\s+minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.match(
    calmSurface,
    /\.action-command-detail\s*{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+16px[^}]*border-top:\s*1px solid var\(--color-rule-2\)/s,
  )
  assert.match(
    calmSurface,
    /\.action-command-main \.action-command-qty\s*{[^}]*border-radius:\s*var\(--radius-badge\)[^}]*background:\s*var\(--action-command-emphasis-bg\)/s,
  )
  assert.match(
    calmSurface,
    /\.plan-cand \.pc-top\s*{[^}]*align-items:\s*center/s,
  )
  assert.match(
    calmSurface,
    /\.plan-cand \.pc-price\s*{[^}]*display:\s*inline-flex[^}]*align-items:\s*baseline[^}]*gap:\s*var\(--space-2xs\)/s,
  )
  assert.match(
    calmSurface,
    /\.plan-cand \.pc-pct\s*{[^}]*align-items:\s*center[^}]*border-radius:\s*var\(--radius-badge\)/s,
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

test('系统跟踪使用状态条，规则正文保持无框且不重复进度条', () => {
  assert.match(
    planTab,
    /className="monitoring-rule-list" role="list"[\s\S]*?role="listitem"/,
  )
  assert.match(
    planTab,
    /\{!view\.monitoring && \([\s\S]*?<ActionProgress/s,
  )
  assert.match(
    precision,
    /\.monitoring-rules\s*{[^}]*border:\s*0[^}]*background:\s*transparent/s,
  )
  assert.match(
    precision,
    /\.monitoring-rules-head\s*{[^}]*border:\s*1px solid var\(--color-rule-2\)[^}]*border-inline-start:\s*3px solid var\(--color-accent\)[^}]*background:\s*var\(--color-paper-4\)/s,
  )
  assert.match(
    precision,
    /\.monitoring-rule-list\s*{[^}]*display:\s*grid[^}]*gap:\s*var\(--space-2xs\)/s,
  )
  assert.match(
    precision,
    /\.monitoring-rule\s*{[^}]*border:\s*0[^}]*background:\s*transparent/s,
  )
  assert.doesNotMatch(
    precision,
    /\.monitoring-rule\s*{[^}]*border-top:/s,
  )
  assert.match(
    designGuide,
    /规则清单不表格化[\s\S]*系统状态标题可以使用单个描边状态条[\s\S]*规则正文禁止卡片化/,
  )
})

test('到价观察使用真实一秒时钟和带边界的倒计时状态', () => {
  assert.match(
    planTab,
    /const \[, setMonitoringTick\] = useState\(0\)[\s\S]*?monitoringRuntimeRef[\s\S]*?runtimeState[\s\S]*?window\.setInterval\([\s\S]*?1000/s,
  )
  assert.match(
    planTab,
    /OBSERVING:\s*'观察中'[\s\S]*?className="monitoring-countdown"[\s\S]*?aria-label=\{`倒计时\$\{rule\.remainingSeconds\}秒`\}/s,
  )
  assert.match(
    precision,
    /\.monitoring-countdown\s*{[^}]*border:\s*1px solid[^}]*border-radius:\s*var\(--radius-badge\)[^}]*background:\s*color-mix/s,
  )
  assert.match(
    designGuide,
    /观察倒计时必须真实[\s\S]*逐秒显示“倒计时 xx 秒”[\s\S]*matchedSince/,
  )
})

test('卡片关键文字建立层级且长内容收敛为固定摘要', () => {
  assert.match(
    planTab,
    /splitRuleText\(rule\.text\)[\s\S]*?monitoring-rule-condition[\s\S]*?monitoring-rule-action/s,
  )
  assert.match(
    planTab,
    /const stateRank = \{[\s\S]*?OBSERVING:\s*1[\s\S]*?const sortedRules = \[\.\.\.monitoring\.rules\]\.sort\([\s\S]*?const visibleRules = sortedRules\.slice\(0, 3\)/s,
  )
  assert.equal(
    (planTab.match(/className="trade-card-evidence-slot"/g) || []).length,
    0,
  )
  assert.match(planTab, /className="adaptive-value-strip"/)
  assert.match(planTab, /className="trade-card-review-slot"/)
  assert.match(
    planTab,
    /className="holding-plan-summary holding-plan-empty"[\s\S]*?>设置止盈止损</s,
  )
  assert.match(
    calmSurface,
    /\.hh-name,[\s\S]*?\.pc-nm\s*{[^}]*font-size:\s*var\(--text-md\)/s,
  )
  assert.match(
    calmSurface,
    /\.card-decision-slot \.action-command-meta\s*{[^}]*font-size:\s*var\(--text-sm\)/s,
  )
  assert.match(
    precision,
    /\.monitoring-rule > strong\s*{[^}]*font-size:\s*var\(--text-base\)/s,
  )
  assert.match(
    fixedCards,
    /\.monitoring-rule:nth-child\(n \+ 4\)\s*{[^}]*display:\s*none/s,
  )
  assert.match(
    fixedCards,
    /\.hold-item > \.selection-origin,[\s\S]*?\.plan-cand > \.stock-note-summary\s*{[^}]*display:\s*none/s,
  )
  assert.match(
    designGuide,
    /移动端先给交易摘要[\s\S]*最多三项核心执行条件/,
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

test('卡片通过留白分组并用克制阴影建立整卡边界', () => {
  assert.match(precision, new RegExp(calmSurfaceMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(
    calmSurface,
    /Portfolio cards:[\s\S]*?\.plan-cand,[\s\S]*?\.hold-grid \.hold-item\s*{[^}]*border-color:\s*var\(--color-trade-card-border\)[^}]*background:\s*var\(--color-trade-card\)[^}]*box-shadow:\s*var\(--shadow-trade-card\)/s,
  )
  assert.match(
    precision,
    /\.hold-swipe-wrap\s*{[^}]*height:\s*100%[^}]*border-radius:\s*var\(--radius-card\)/s,
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

test('置顶自选卡使用浅蓝表面、整圈蓝框并保留卡片阴影', () => {
  assert.match(
    calmSurface,
    /\.plan-cand\.starred,[\s\S]*?html\[data-theme="light"\] \.plan-cand\.starred\s*{[^}]*border-color:\s*color-mix\([^}]*var\(--color-accent\)\s*58%[^}]*background:\s*color-mix\([^}]*var\(--color-accent\)\s*7%[^}]*box-shadow:[^}]*var\(--shadow-trade-card\)/s,
  )
  assert.doesNotMatch(
    calmSurface.match(
      /\.plan-cand\.starred,[\s\S]*?html\[data-theme="light"\] \.plan-cand\.starred\s*{[^}]*}/s,
    )?.[0] || '',
    /inset\s+0\s+3px/,
  )
  assert.match(
    calmSurface,
    /\.plan-cand\.starred \.pc-pin\.on\s*{[^}]*background:\s*color-mix\([^}]*var\(--color-accent\)\s*14%[^}]*color:\s*var\(--color-accent\)[^}]*opacity:\s*1/s,
  )
})

test('持仓与自选卡内部次级按钮使用实体表面和清晰边界', () => {
  assert.match(
    precision,
    /Card controls stay visually attached[\s\S]*?\.pi-trade-actions > \.chip-btn:not\(\.recommended\)[\s\S]*?\.plan-cand \.pc-actions > \.chip-btn:not\(\.act-buy\)[\s\S]*?\.holding-plan-summary,[\s\S]*?\.plan-cand \.pc-pin[\s\S]*?border:\s*1px solid var\(--color-trade-control-border\)[\s\S]*?background:\s*var\(--color-trade-control\)[\s\S]*?box-shadow:\s*var\(--shadow-trade-control\)/s,
  )
})

test('成本编辑是贴近数值的低权重图标而不是独立描边按钮', () => {
  assert.match(
    precision,
    /\.hold-card-metrics \.hold-cost-edit\s*{[^}]*width:\s*22px[^}]*border:\s*0[^}]*background:\s*transparent[^}]*box-shadow:\s*none[^}]*opacity:\s*0\.72/s,
  )
})

test('策略摘要不使用悬浮预览且文字区域进入股票详情', () => {
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
    /className={`action-command importance-\$\{importance\}`}[\s\S]*?title="查看股票详情与完整建议"[\s\S]*?onClick=\{onOpen\}/,
  )
  assert.doesNotMatch(planTab, /aria-label="卡片内完整研判"/)
})

test('持仓卡先展示指令再展示仓位核心数据与次级盘面证据', () => {
  const holdStart = planTab.indexOf(
    "<div className={'trade-card hold-item stock-detail-card-hitarea v3-card'",
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

test('自选卡直接展示操作摘要并把概率依据移入详情', () => {
  assert.match(
    planTab,
    /<CandDecision[\s\S]*?p=\{p\}[\s\S]*?q=\{q\}[\s\S]*?managed=\{managed\}[\s\S]*?\/>/,
  )
  assert.doesNotMatch(
    planTab,
    /className="stock-card-metrics pc-metrics"/,
  )
  assert.equal(
    (planTab.match(/<MarketPulse quote=\{q\}/g) || []).length,
    0,
  )
  assert.match(planTab, /<V3DecisionSummary advice=\{advice\} view=\{baseView\}/)
  assert.doesNotMatch(planTab.slice(planTab.indexOf('function CandDecision')), /<AdaptiveValueStrip/)
  assert.match(read('src/components/V3DecisionSummary.jsx'), /detailed &&[\s\S]*决策依据/)
})

test('个股详情展示最近收盘快照与近5日关键趋势', () => {
  assert.match(
    stockDetailData,
    /stock_detail\?code=\$\{encodeURIComponent\(code\)\}/,
  )
  assert.match(stockDetailData, /trends=1&quote=1/)
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
  const formulaIndex = stockDetail.indexOf('<V3DecisionSummary')
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

test('普通收藏先纳入作战且自主成交记录不冒充系统推荐', () => {
  assert.match(
    planTab,
    /className=\{\s*'pc-actions with-review'[\s\S]{0,180}' deferred'/,
  )
  assert.match(
    planTab,
    /systemExecutable && managed[\s\S]*?记录买入[\s\S]*?!managed[\s\S]*?纳入作战[\s\S]*?记录自主成交/s,
  )
  assert.match(
    planTab,
    /generation\?\.active \|\| enrolling[\s\S]*?正在更新决策[\s\S]*?!view\.waiting[\s\S]*?更新 V3 决策[\s\S]*?查看跟踪条件/s,
  )
  assert.match(
    precision,
    /\.plan-cand \.pc-actions\.with-review\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
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
    /\.hold-item > \.pi-actions\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+40px[^}]*min-height:\s*40px[^}]*margin-top:\s*auto/s,
  )
  assert.match(
    precision,
    /\.pi-card-tools\s*{[^}]*width:\s*40px/s,
  )
})
