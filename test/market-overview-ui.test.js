import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const research = read('src/components/ResearchTab.jsx')
const today = read('src/components/TodayTab.jsx')
const overview = read('src/components/MarketOverview.jsx')
const styles = read('src/styles/precision.css')

test('盘面研究首屏恢复今日大盘且作战计划不再重复隐藏盘面模块', () => {
  assert.match(research, /import MarketOverview from '\.\/MarketOverview'/)
  assert.match(research, /<MarketOverview[\s\S]*?market=\{snapshot\?\.market\}[\s\S]*?overseas=\{snapshot\?\.overseas\}/)
  assert.ok(
    research.indexOf('<MarketOverview')
      < research.indexOf('<ConceptTrendPanel'),
  )
  assert.doesNotMatch(today, /<MarketOverview|<MarketLight|combat-research/)
})

test('今日大盘同时展示A股、海外指数、商品与市场广度', () => {
  assert.match(overview, /今日大盘/)
  assert.match(overview, /A股指数/)
  assert.match(overview, /海外指数/)
  assert.match(overview, /关键商品/)
  assert.match(overview, /行情可能延迟/)
  assert.match(overview, /market\?\.indices/)
  assert.match(overview, /overseas\?\.indices/)
  assert.match(overview, /overseas\?\.commodities/)
  assert.match(overview, /涨\/跌家数/)
  assert.match(overview, /两市成交额/)
  assert.match(overview, /涨\/跌停/)
})

test('今日大盘优先展示全市场资金方向和可比较的流动性变化', () => {
  assert.match(
    research,
    /marketFunds=\{snapshot\?\.marketFunds\}/,
  )
  assert.match(overview, /全市场主力净额/)
  assert.match(overview, /沪市、深市与北证主力净额汇总/)
  assert.match(overview, /净流强度/)
  assert.match(overview, /流入 \/ 流出市场/)
  assert.match(overview, /最大资金方向/)
  assert.match(overview, /流动性变化/)
  assert.match(overview, /盘中累计/)
  assert.match(overview, /较5日均量/)
})

test('大盘模块桌面双栏并在移动端收敛为单列', () => {
  assert.match(
    styles,
    /\.research-market-overview\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*8fr\)\s+minmax\(280px,\s*4fr\)/s,
  )
  assert.match(
    styles,
    /\.market-board \.mb-stats\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    styles,
    /@media \(max-width:\s*900px\)\s*{[\s\S]*?\.research-market-overview\s*{[^}]*grid-template-columns:\s*1fr/s,
  )
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.market-external-grid\s*{[^}]*grid-template-columns:\s*1fr[\s\S]*?\.market-board \.mb-stats\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    styles,
    /\.market-funds-metrics\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s,
  )
})
