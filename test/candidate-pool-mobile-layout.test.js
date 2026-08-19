import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const todayTab = fs.readFileSync(
  new URL('../src/components/TodayTab.jsx', import.meta.url),
  'utf8',
)
const styles = fs.readFileSync(
  new URL('../src/styles/precision.css', import.meta.url),
  'utf8',
)

test('移动端候选池保留可读名称列并让行情列横向滚动', () => {
  assert.match(todayTab, /className="tbl candidate-pool-table"/)
  assert.match(todayTab, /className="candidate-stock-name"/)
  assert.match(todayTab, /showTags=\{false\}/)
  assert.match(styles, /\.candidate-pool-table\s*\{[\s\S]*min-width:\s*680px/)
  assert.match(
    styles,
    /\.candidate-pool-table :is\(th, td\):first-child\s*\{[\s\S]*width:\s*132px/,
  )
  assert.match(
    styles,
    /\.candidate-stock-name \.stock-name-primary\s*\{[\s\S]*flex-direction:\s*column/,
  )
})
