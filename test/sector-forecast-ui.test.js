import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const research = read('src/components/ResearchTab.jsx')
const today = read('src/components/TodayTab.jsx')
const component = read('src/components/SectorForecast.jsx')
const progress = read('src/components/SectorForecastProgress.jsx')
const settings = read('src/components/SectorForecastSettings.jsx')
const client = read('src/sectorForecastClient.js')
const view = read('src/sectorForecastView.js')
const styles = read('src/styles/precision.css')

test('板块前瞻迁入今日决策并替代AI选股入口', () => {
  assert.match(
    today,
    /import SectorForecast from '\.\/SectorForecast'/,
  )
  assert.ok(
    today.indexOf('<SectorForecast')
      < today.indexOf('<CandidatePool'),
  )
  assert.doesNotMatch(research, /SectorForecast/)
  assert.doesNotMatch(today, /<DailyPlay/)
  assert.doesNotMatch(today, /function DailyPlay/)
  assert.doesNotMatch(today, /AI 选股/)
  assert.doesNotMatch(today, /下一交易日观察池/)
  assert.doesNotMatch(today, /ai_pick_v2/)
  assert.doesNotMatch(today, /callAI\('scan_pick'/)
  assert.doesNotMatch(today, /\/api\/screen/)
})

test('板块前瞻提供双周期排名、展开解释与真实成分股', () => {
  assert.match(component, /板块前瞻/)
  assert.match(component, /次日/)
  assert.match(component, /一周/)
  assert.match(component, /weekRank/)
  assert.match(component, /explanation/)
  assert.match(component, /stocks/)
  assert.match(component, /phaseLabel/)
  assert.match(component, /actionLabel/)
  assert.match(component, /<details[^>]*className="sector-forecast-history"/)
})

test('板块前瞻支持结论优先和预测分数升降序', () => {
  assert.match(component, /sector-forecast-sort/)
  assert.match(component, /useState\('layout'\)/)
  assert.match(component, /提前布局优先/)
  assert.match(component, /结论优先/)
  assert.match(component, /分数从高到低/)
  assert.match(component, /分数从低到高/)
  assert.match(component, /sortSectorForecasts/)
  assert.match(view, /actionability/)
  assert.match(view, /score_desc/)
  assert.match(view, /score_asc/)
})

test('成分股明确拆分提前布局与已走强跟踪', () => {
  assert.match(component, /提前布局候选/)
  assert.match(component, /已走强，仅跟踪/)
  assert.match(component, /entryStage/)
  assert.match(component, /entryLabel/)
  assert.match(component, /追高风险/)
  assert.match(component, /布局时机/)
})

test('板块前瞻直接展示提前布局数量和每个板块的操作指令', () => {
  assert.match(component, /sector-forecast-action-summary/)
  assert.match(component, /可提前布局/)
  assert.match(component, /提前布局观察/)
  assert.match(component, /sector-forecast-guidance/)
  assert.match(component, /sectorForecastActionView/)
  assert.match(view, /可以买入/)
  assert.match(view, /暂不买/)
})

test('板块前瞻成分股点击后打开全局个股详情侧栏', () => {
  assert.match(component, /import\s*{\s*openStockDetail\s*}/)
  assert.match(component, /openStockDetail\(stock\.code,\s*stock\.name\)/)
  assert.match(component, /className="sector-forecast-stock"/)
  assert.match(component, /查看个股详情/)
})

test('生成中展示权威任务阶段、百分比和完整步骤', () => {
  assert.match(component, /SectorForecastProgress/)
  assert.match(progress, /aria-live="polite"/)
  assert.match(progress, /role="progressbar"/)
  assert.match(progress, /采集盘面/)
  assert.match(progress, /量化预测/)
  assert.match(progress, /搜索证据/)
  assert.match(progress, /深度解释/)
  assert.match(progress, /保存正式版/)
})

test('板块前瞻支持手动生成和运行时自动时间设置', () => {
  assert.match(component, /action:\s*'generate'/)
  assert.match(component, /session:\s*generationSession/)
  assert.match(component, /刷新盘中版/)
  assert.match(component, /复核盘前证据/)
  assert.match(component, /resolveSectorForecastGenerationSession/)
  assert.match(component, /assessSectorForecastGeneration/)
  assert.match(view, /本次没有生成新版本/)
  assert.match(component, /重算最近正式版/)
  assert.match(component, /本版没有有效板块数据/)
  assert.match(component, /sector-forecast-version-switch/)
  assert.match(component, /盘中动态/)
  assert.match(component, /正式基线/)
  assert.match(component, /market\?\.phase === 'lunch'/)
  assert.match(component, /SectorForecastSettings/)
  assert.match(settings, /autoEnabled/)
  assert.match(settings, /overnightEnabled/)
  assert.match(settings, /intradayEnabled/)
  assert.match(settings, /intradayIntervalMinutes/)
  assert.match(settings, /收盘生成正式排名/)
  assert.match(settings, /盘前更新隔夜证据/)
  assert.match(settings, /盘中刷新实时排名/)
  assert.match(settings, /sector-setting-list/)
  assert.match(settings, /sector-setting-row/)
  assert.match(settings, /sector-setting-switch/)
  assert.match(settings, /保存自动设置/)
  assert.doesNotMatch(settings, />生成时间</)
  assert.doesNotMatch(settings, />复核时间</)
  assert.doesNotMatch(settings, />刷新间隔</)
  assert.match(settings, /<option value=\{5\}>5分钟<\/option>/)
  assert.match(settings, /<option value=\{10\}>10分钟<\/option>/)
  assert.match(settings, /<option value=\{15\}>15分钟<\/option>/)
  assert.match(settings, /type="time"/)
  assert.match(settings, /15:05/)
  assert.match(settings, /09:25/)
  assert.match(settings, /save_settings/)
})

test('板块前瞻请求携带账号令牌且有明确超时', () => {
  assert.match(client, /accountRequestHeaders\(\)/)
  assert.match(client, /\/api\/sector_forecast/)
  assert.match(client, /AbortController/)
  assert.match(client, /clearTimeout/)
  assert.match(component, /action:\s*'bootstrap'/)
  assert.doesNotMatch(
    component,
    /Promise\.all\(\[\s*sectorForecastRequest\(\),\s*sectorForecastRequest\(\{\s*action:\s*'history'/,
  )
})

test('板块前瞻桌面信息密集且移动端稳定单列', () => {
  assert.match(styles, /\.sector-forecast-panel\s*{/)
  assert.match(styles, /\.sector-forecast-row\s*{/)
  assert.match(styles, /@media[\s\S]*\.sector-forecast-row\s*{[\s\S]*grid-template-columns:\s*1fr/)
  assert.match(styles, /\.sector-forecast-settings\s*{/)
  assert.match(
    styles,
    /\.sector-setting-row\s*{[\s\S]*grid-template-columns:\s*32px minmax\(0,\s*1fr\) minmax\(150px,\s*auto\)/,
  )
  assert.match(
    styles,
    /@media[\s\S]*\.sector-setting-row\s*{[\s\S]*grid-template-columns:\s*32px minmax\(0,\s*1fr\)/,
  )
  assert.match(styles, /\.sector-forecast-version-switch\s*{/)
  assert.match(styles, /\.sector-forecast-empty-result\s*{/)
  assert.match(
    styles,
    /\.sector-forecast-head-actions\s*{[\s\S]*--sector-control-height:\s*36px/,
  )
  assert.match(
    styles,
    /\.sector-forecast-head-actions\s*>\s*\.tabs,[\s\S]*\.sector-forecast-sort,[\s\S]*\.sector-forecast-generate,[\s\S]*\.sector-forecast-settings-trigger\s*{[\s\S]*height:\s*var\(--sector-control-height\)/,
  )
  assert.match(
    styles,
    /@media[\s\S]*\.sector-forecast-head-actions\s*{[\s\S]*--sector-control-height:\s*44px/,
  )
  const headBlocks = [
    ...styles.matchAll(
      /\.sector-forecast-head-actions\s*\{([^}]*)\}/g,
    ),
  ].map((match) => match[1])
  const mobileHead = headBlocks.find((block) =>
    block.includes('--sector-control-height: 44px'))
  assert.match(mobileHead, /display:\s*grid/)
  assert.match(
    mobileHead,
    /grid-template-columns:[^;]*minmax\(0,\s*0\.9fr\)[^;]*minmax\(0,\s*1\.1fr\)[^;]*44px/,
  )
  assert.match(mobileHead, /overflow:\s*visible/)

  const guidanceBlocks = [
    ...styles.matchAll(
      /\.sector-forecast-guidance strong,\s*\.sector-forecast-guidance small\s*\{([^}]*)\}/g,
    ),
  ].map((match) => match[1])
  const mobileGuidance = guidanceBlocks.find((block) =>
    block.includes('white-space: normal'))
  assert.match(mobileGuidance, /line-clamp:\s*2/)

  const rankBlocks = [
    ...styles.matchAll(
      /\.sector-forecast-rank\s*\{([^}]*)\}/g,
    ),
  ].map((match) => match[1])
  const mobileRank = rankBlocks.find((block) =>
    block.includes('position: absolute'))
  assert.match(
    mobileRank,
    /inset-inline-start:\s*var\(--space-sm\)/,
  )
  assert.match(
    mobileRank,
    /top:\s*calc\(var\(--space-sm\)\s*\+\s*2px\)/,
  )

  const scoreBlocks = [
    ...styles.matchAll(
      /\.sector-forecast-score\s*\{([^}]*)\}/g,
    ),
  ].map((match) => match[1])
  const mobileScore = scoreBlocks.find((block) =>
    block.includes('position: absolute'))
  assert.match(
    mobileScore,
    /inset-inline-end:\s*var\(--space-sm\)/,
  )
  assert.match(mobileScore, /top:\s*var\(--space-sm\)/)
})
