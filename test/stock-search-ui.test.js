import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const planTab = read('src/components/PlanTab.jsx')
const styles = read('src/styles.css')
const searchStart = planTab.indexOf('function StockSearch()')
const searchEnd = planTab.indexOf(
  '// ---------- 量化得分徽标',
  searchStart,
)
const stockSearch = planTab.slice(searchStart, searchEnd)

test('搜索结果主体只查看详情且右侧按钮才加入或定位', () => {
  assert.match(
    stockSearch,
    /const viewDetail = \(\) => \{[\s\S]*?openStockDetail\(s\.code, s\.name\)[\s\S]*?setOpen\(false\)/s,
  )
  assert.match(
    stockSearch,
    /const onAction = \(\) => \{[\s\S]*?if \(inBook\)[\s\S]*?requestLocate\(s\.code\)[\s\S]*?else pick\(s\)/s,
  )
  assert.match(
    stockSearch,
    /<div className=\{'ss-item'[\s\S]*?className="ss-preview"[\s\S]*?onClick=\{viewDetail\}/s,
  )
  assert.match(
    stockSearch,
    /className=\{'ss-add' \+ \(inBook \? ' locate' : ''\)\}[\s\S]*?onClick=\{onAction\}/s,
  )
  assert.doesNotMatch(
    stockSearch,
    /className=\{'ss-item'[\s\S]{0,160}onClick=\{onAction\}/s,
  )
})

test('搜索结果的查看区与加入区是两个独立可聚焦按钮', () => {
  assert.match(
    styles,
    /\.ss-item\s*{[^}]*display:\s*flex[^}]*align-items:\s*stretch[^}]*padding:\s*0/s,
  )
  assert.match(
    styles,
    /\.ss-preview\s*{[^}]*flex:\s*1[^}]*min-width:\s*0[^}]*cursor:\s*pointer/s,
  )
  assert.match(
    styles,
    /\.ss-add\s*{[^}]*flex:\s*none[^}]*background:\s*transparent[^}]*cursor:\s*pointer/s,
  )
  assert.match(
    styles,
    /\.ss-preview:focus-visible,[\s\S]*?\.ss-add:focus-visible\s*{[^}]*outline:\s*2px solid var\(--color-focus\)/s,
  )
})
