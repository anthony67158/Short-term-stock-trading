import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const research = read('src/components/ResearchTab.jsx')
const concept = read('src/components/ConceptTrendPanel.jsx')
const styles = read('src/styles/precision.css')

test('盘面研究新增独立概念走势区并可联动现有成分股面板', () => {
  assert.match(research, /import ConceptTrendPanel from '\.\/ConceptTrendPanel'/)
  assert.match(research, /useRef\(null\)/)
  assert.match(research, /<ConceptTrendPanel[\s\S]*onInspect=/)
  assert.match(research, /setType\('concept'\)/)
  assert.match(research, /setSelected\(sector\)/)
  assert.match(research, /scrollIntoView\(\{\s*behavior:/)
  assert.match(research, /ref={constituentsRef}/)
  assert.match(research, /tabIndex="-1"/)
})

test('概念走势展示完整可搜索目录而非只截取前10个', () => {
  assert.match(concept, /\/api\/sectors\?type=concept&sort=/)
  assert.match(concept, /filterConceptSectors\(/)
  assert.doesNotMatch(concept, /\.slice\(0,\s*10\)/)
  assert.match(concept, /placeholder="搜索全部概念"/)
  assert.match(concept, /共 \{allSectors\.length\} 个概念/)
})

test('概念走势支持分时日K周K月K并明确真实数据日期', () => {
  assert.match(concept, /\/api\/sector_history\?code=\$\{selected\.code\}&mode=intraday/)
  assert.match(concept, /mode=kline&period=\$\{chartMode\}&v=15/)
  assert.match(concept, />分时</)
  assert.match(concept, />日K</)
  assert.match(concept, />周K</)
  assert.match(concept, />月K</)
  assert.match(concept, /概念走势/)
  assert.match(concept, /data\?\.tradingDate/)
  assert.match(concept, /data\?\.summary\?\.lastDate/)
  assert.match(concept, /东方财富概念板块行情/)
  assert.match(concept, /东方财富概念板块历史行情/)
})

test('概念走势同时绘制分时、K线和成交量且移动端单列', () => {
  assert.match(concept, /name: '概念涨跌'/)
  assert.match(concept, /name: '分时均价'/)
  assert.match(concept, /name: '成交量'/)
  assert.match(concept, /type: 'line'/)
  assert.match(concept, /type: 'bar'/)
  assert.match(concept, /type: 'candlestick'/)
  assert.match(styles, /\.concept-trend-layout\s*{[^}]*grid-template-columns:/s)
  assert.match(styles, /\.concept-rank\s*{[^}]*overflow-y:\s*auto/s)
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.concept-trend-layout\s*{[^}]*grid-template-columns:\s*1fr/s,
  )
})
