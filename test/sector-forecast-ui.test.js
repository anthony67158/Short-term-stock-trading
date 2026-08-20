import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const research = read('src/components/ResearchTab.jsx')
const component = read('src/components/SectorForecast.jsx')
const progress = read('src/components/SectorForecastProgress.jsx')
const settings = read('src/components/SectorForecastSettings.jsx')
const client = read('src/sectorForecastClient.js')
const view = read('src/sectorForecastView.js')
const styles = read('src/styles/precision.css')

test('板块前瞻位于盘面研究的概念走势之前', () => {
  assert.match(
    research,
    /import SectorForecast from '\.\/SectorForecast'/,
  )
  assert.ok(
    research.indexOf('<SectorForecast')
      < research.indexOf('<ConceptTrendPanel'),
  )
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
  assert.match(component, /结论优先/)
  assert.match(component, /分数从高到低/)
  assert.match(component, /分数从低到高/)
  assert.match(component, /sortSectorForecasts/)
  assert.match(view, /actionability/)
  assert.match(view, /score_desc/)
  assert.match(view, /score_asc/)
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
  assert.match(component, /SectorForecastSettings/)
  assert.match(settings, /autoEnabled/)
  assert.match(settings, /overnightEnabled/)
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
})

test('板块前瞻桌面信息密集且移动端稳定单列', () => {
  assert.match(styles, /\.sector-forecast-panel\s*{/)
  assert.match(styles, /\.sector-forecast-row\s*{/)
  assert.match(styles, /@media[\s\S]*\.sector-forecast-row\s*{[\s\S]*grid-template-columns:\s*1fr/)
  assert.match(styles, /\.sector-forecast-settings\s*{/)
})
