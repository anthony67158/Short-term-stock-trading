import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const planTab = read('src/components/PlanTab.jsx')
const groupFilter = read('src/components/StockGroupFilter.jsx')
const styles = read('src/styles/precision.css')

test('持仓与自选默认按概念胶囊筛选，并可切换到行业', () => {
  assert.match(planTab, /useStockTags\(codes\)/)
  assert.ok((planTab.match(/useState\('concept'\)/g) || []).length >= 2)
  assert.ok((planTab.match(/<StockGroupFilter/g) || []).length >= 3)
  assert.match(groupFilter, /aria-label="切换概念或行业筛选"/)
  assert.match(groupFilter, /aria-pressed={dimension === 'concept'}/)
  assert.match(groupFilter, /aria-pressed={dimension === 'industry'}/)
  assert.match(groupFilter, />概念</)
  assert.match(groupFilter, />行业</)
})

test('普通筛选保持单行布局并让胶囊在独立视口横向滚动', () => {
  const track = groupFilter.indexOf('className="stock-group-filter-track"')
  const dimensions = groupFilter.indexOf('className="stock-group-dimensions"')
  const viewport = groupFilter.indexOf('className="stock-group-tabs-viewport"')
  const tabs = groupFilter.indexOf('className="ind-tabs stock-group-tabs"')

  assert.ok(track >= 0, '筛选组件应提供统一横向轨道')
  assert.ok(dimensions > track, '概念/行业开关应位于轨道内')
  assert.ok(viewport > dimensions, '胶囊滚动视口应紧接在维度开关后')
  assert.ok(tabs > viewport, '筛选胶囊应位于独立滚动视口内')
  assert.doesNotMatch(groupFilter, /className="stock-group-filter-head"/)
  assert.match(groupFilter, /{compact && <span className="stock-group-filter-label">{label}<\/span>}/)
  assert.match(styles, /\.stock-group-filter-track\s*\{[\s\S]*display:\s*flex/)
  assert.match(styles, /\.stock-group-filter-track\s*\{[^}]*overflow:\s*hidden/s)
  assert.match(
    styles,
    /\.stock-group-filter-track\s*\{[^}]*padding:\s*var\(--space-2xs\)\s+0/s,
  )
  assert.match(styles, /\.stock-group-tabs-viewport\s*\{[^}]*overflow-x:\s*auto/s)
})

test('移动端筛选保持单行横滑且胶囊不会穿到维度开关下方', () => {
  assert.doesNotMatch(styles, /\.stock-group-dimensions\s*\{[^}]*position:\s*sticky/s)
  assert.match(styles, /\.stock-group-dimensions\s*\{[^}]*flex:\s*none/s)
  assert.match(styles, /\.stock-group-tabs-viewport\s*\{[^}]*min-width:\s*0[^}]*scroll-snap-type:\s*x proximity/s)
  assert.match(styles, /\.stock-group-tabs > \.ind-tab\s*\{[^}]*scroll-snap-align:\s*start/s)
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)\s*\{[\s\S]*?\.stock-group-tabs-viewport\s*\{[^}]*scroll-padding-inline:/s,
  )
  assert.match(
    styles,
    /@media \(pointer:\s*coarse\)\s*\{[\s\S]*?\.stock-group-dimensions button[\s\S]*?min-height:\s*44px/s,
  )
})

test('一次性生成保留股票池范围并增加概念或行业板块维度', () => {
  assert.match(planTab, /className="batch-scope-options"/)
  assert.match(planTab, /持仓 \(\{holdCodes\.length\}\)/)
  assert.match(planTab, /自选 \(\{watchCodes\.length\}\)/)
  assert.match(planTab, /两者 \(\{allCodes\.length\}\)/)
  assert.match(planTab, /selectBatchGroupCodes\(/)
  assert.match(planTab, /className="batch-filter-stack"/)
})

test('一次性生成的概念和行业板块支持多选', () => {
  assert.match(planTab, /const \[batchGroup, setBatchGroup\] = useState\(\(\) => \[\]\)/)
  assert.match(planTab, /toggleBatchGroupSelection\(batchGroup, group\)/)
  assert.match(planTab, /groups: nextGroups/)
  assert.match(planTab, /multiSelect/)
  assert.match(groupFilter, /multiSelect = false/)
  assert.match(groupFilter, /Array\.isArray\(active\)/)
  assert.match(groupFilter, /aria-label=\{`按\$\{dimensionLabel\}\$\{multiSelect \? '多选' : '筛选'\}股票`\}/)
})

test('卡片最近生成时间展示相对新鲜度并按三档状态突出', () => {
  assert.match(planTab, /adviceRecency\(entry && entry\.at\)/)
  assert.match(planTab, /data-recency={recency\.tone}/)
  assert.match(planTab, /<span>最近生成<\/span>/)
  assert.match(styles, /\.advice-updated-at\[data-recency="fresh"\]/)
  assert.match(styles, /\.advice-updated-at\[data-recency="today"\]/)
  assert.match(styles, /\.advice-updated-at\[data-recency="older"\]/)
})

test('持仓区和自选区的标题与分组筛选在页面下滑时保持吸顶', () => {
  assert.ok(
    (planTab.match(/className="plan-section-sticky[^"]*"/g) || []).length >= 3,
  )
  assert.match(styles, /\.plan-section-sticky\s*\{[\s\S]*position:\s*sticky/)
  assert.match(styles, /\.plan-section-sticky\s*\{[\s\S]*top:/)
  assert.match(styles, /\.plan-section-sticky\s*\{[\s\S]*z-index:/)
  assert.match(styles, /\.plan-section\s*\{[\s\S]*overflow:\s*visible/)
})

test('持仓总览位于当前持仓标题和筛选胶囊上方', () => {
  const holdingSection = planTab.slice(planTab.indexOf('function HoldingList'))
  const heading = holdingSection.indexOf('plan-section-head-sticky')
  const overview = holdingSection.indexOf('<HoldOverview')
  const filter = holdingSection.indexOf('plan-section-filter-sticky')

  assert.ok(overview >= 0, '持仓总览必须存在')
  assert.ok(heading > overview, '当前持仓标题应位于持仓总览下方')
  assert.ok(filter > heading, '筛选胶囊应位于当前持仓标题下方')
  assert.match(styles, /\.plan-section-filter-sticky\s*\{[\s\S]*position:\s*sticky/)
  assert.doesNotMatch(
    styles,
    /@media \(max-width:\s*720px\)\s*\{[\s\S]*?\.plan-section-hold-sticky\s*\{[^}]*display:\s*contents/s,
  )
})

test('胜率、复核、批量生成与进度统一归入整体总览区', () => {
  const holdingSection = planTab.slice(planTab.indexOf('function HoldingList'))
  const overviewZone = holdingSection.indexOf('className="portfolio-overview-zone"')
  const overview = holdingSection.indexOf('<HoldOverview')
  const controls = holdingSection.indexOf('className="portfolio-command-actions"')
  const batchBar = holdingSection.indexOf('className="batch-bar"')
  const progress = holdingSection.indexOf("className={'batch-prog'")
  const heading = holdingSection.indexOf('plan-section-head-sticky')
  const headingEnd = holdingSection.indexOf('plan-section-filter-sticky')
  const holdingHeader = holdingSection.slice(heading, headingEnd)

  assert.ok(overviewZone >= 0, '整体账户总览区必须存在')
  assert.ok(overview > overviewZone, '财务总览应位于整体区内')
  assert.ok(controls > overview, '整体控制条应紧接财务总览')
  assert.ok(batchBar > controls, '批量选择工具应归入整体区')
  assert.ok(progress > controls, '生成进度应归入整体区')
  assert.ok(heading > batchBar, '当前持仓标题必须位于整体批量工具之后')
  assert.ok(heading > progress, '当前持仓标题必须位于整体生成进度之后')
  assert.doesNotMatch(holdingHeader, /<AdvisorScore|<AutoRefreshControl|batch-entry/)
  assert.match(styles, /\.portfolio-overview-zone\s*\{/)
  assert.match(styles, /\.portfolio-command-actions\s*\{/)
})

test('桌面与移动端持仓标题和筛选轨道共用吸顶容器', () => {
  const holdingSection = planTab.slice(planTab.indexOf('function HoldingList'))

  assert.match(
    holdingSection,
    /className="plan-section-hold-sticky"[\s\S]*?plan-section-head-sticky[\s\S]*?plan-section-filter-sticky/,
  )
  assert.match(
    styles,
    /\.plan-section-hold-sticky\s*\{[^}]*position:\s*sticky[^}]*top:/s,
  )
  assert.match(
    styles,
    /\.plan-section-hold-sticky > \.plan-section-sticky\s*\{[^}]*position:\s*static[^}]*top:\s*auto[^}]*margin:\s*0/s,
  )
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)\s*\{[\s\S]*?\.plan-section-hold-sticky\s*\{[^}]*display:\s*block[^}]*position:\s*sticky[^}]*top:\s*calc\(60px \+ env\(safe-area-inset-top\)\)[^}]*background:\s*var\(--color-paper\)/s,
  )
})
