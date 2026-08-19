import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const stockName = read('src/components/StockName.jsx')
const planTab = read('src/components/PlanTab.jsx')
const todayTab = read('src/components/TodayTab.jsx')
const movers = read('src/components/Movers.jsx')
const stockPanel = read('src/components/StockPanel.jsx')
const stockDetail = read('src/components/StockDetail.jsx')
const alertCenter = read('src/components/AlertCenter.jsx')
const alertPanel = read('src/components/AlertPanel.jsx')
const dailyReport = read('src/components/DailyReport.jsx')
const assistant = read('src/components/AIAssistant.jsx')
const stockTags = read('src/components/StockTags.jsx')
const stockTagStore = read('src/stockTagStore.js')
const styles = read('src/styles.css')

test('通用股票身份默认按名称代码在上、题材行业在下排列', () => {
  assert.match(stockName, /import StockTags from '\.\/StockTags'/)
  assert.match(stockName, /showTags = true/)
  assert.match(stockName, /className="stock-name-primary"/)
  assert.match(stockName, /className="stock-name-code"/)
  assert.match(stockName, /variant="stacked"/)
  assert.match(stockName, /stock-name-cluster/)
})

test('通用股票身份在窄列内约束两层内容并使用省略号', () => {
  assert.match(
    styles,
    /\.stock-name-cluster > \.stock-name-link,[\s\S]*?\.stock-name-cluster > \.stock-name-static\s*{[^}]*overflow:\s*hidden/s,
  )
  assert.match(
    styles,
    /\.stock-name-primary\s*{[^}]*width:\s*100%[^}]*overflow:\s*hidden/s,
  )
  assert.match(
    styles,
    /\.stock-theme-tags\.stacked\s*{[^}]*width:\s*100%[^}]*max-width:\s*100%/s,
  )
  assert.match(
    styles,
    /\.stock-theme-tags\.stacked \.stock-theme-tag\s*{[^}]*flex:\s*0 1 auto[^}]*min-width:\s*0/s,
  )
})

test('持仓自选复用两层股票身份且不再渲染独立标签横条', () => {
  assert.doesNotMatch(planTab, /\/api\/stock_tags\?codes=/)
  assert.match(planTab, /<StockName[\s\S]{0,80}code={p\.code}/)
  assert.match(planTab, /<StockName[\s\S]{0,80}code={h\.code}/)
  assert.doesNotMatch(planTab, /<StockTags code={p\.code}[^>]*variant="card"/)
  assert.doesNotMatch(planTab, /<StockTags code={h\.code}[^>]*variant="card"/)
})

test('核心个股场景全部接入统一标签', () => {
  for (const source of [
    todayTab,
    movers,
    stockPanel,
    alertCenter,
    alertPanel,
    dailyReport,
    assistant,
  ]) {
    assert.match(source, /StockName|StockTags/)
  }
  assert.match(stockDetail, /<StockTags[\s\S]{0,100}code={stock\.code}/)
  assert.match(stockPanel, /<StockName code={s\.code}/)
  assert.match(dailyReport, /<StockName code={h\.code}/)
  assert.match(assistant, /<StockName[\s\S]{0,120}code={s\.code}/)
})

test('概念标签区分F10精确题材与资料回退并升级缓存版本', () => {
  assert.match(stockTagStore, /\/api\/stock_tags\?codes=\$\{codes\.join\(','\)\}&v=4/)
  assert.match(stockTags, /info\?\.conceptVerified/)
  assert.match(stockTags, /东方财富 F10 精确题材/)
  assert.match(stockTags, /data-verified=/)
})
