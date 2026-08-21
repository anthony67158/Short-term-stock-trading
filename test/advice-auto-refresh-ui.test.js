import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const planTab = readFileSync(
  new URL('../src/components/PlanTab.jsx', import.meta.url),
  'utf8',
)
const selector = readFileSync(
  new URL(
    '../src/components/AutoRefreshStockSelector.jsx',
    import.meta.url,
  ),
  'utf8',
)
const styles = readFileSync(
  new URL('../src/styles/precision.css', import.meta.url),
  'utf8',
)

test('持续复核在持仓和自选下分别选择具体股票', () => {
  assert.match(planTab, /AutoRefreshStockSelector/)
  assert.match(planTab, /scope:\s*'hold'/)
  assert.match(planTab, /scope:\s*'watch'/)
  assert.match(planTab, /scope=\{scope\}/)
  assert.match(planTab, /setAutoSelectedCodes/)
  assert.match(planTab, /立即复核已选股票/)
  assert.doesNotMatch(planTab, /立即刷新全部/)
})

test('持续复核股票选择复用概念行业多选与自选置顶过滤', () => {
  assert.match(selector, /StockGroupFilter/)
  assert.match(selector, /buildStockGroups/)
  assert.match(selector, /selectBatchGroupCodes/)
  assert.match(selector, /toggleBatchGroupSelection/)
  assert.match(selector, /pinnedOption=/)
  assert.match(selector, /starFill/)
  assert.match(selector, /aria-pressed=\{selected\}/)
})

test('持续复核选择器限制高度并适配移动端', () => {
  assert.match(styles, /\.arp-stock-selector\s*{/)
  assert.match(styles, /\.arp-stock-list\s*{[^}]*max-height:/s)
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)[\s\S]*?\.auto-ref-dialog\s*{[^}]*width:\s*100%/s,
  )
})
