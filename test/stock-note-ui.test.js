import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const component = read('src/components/StockNote.jsx')
const planTab = read('src/components/PlanTab.jsx')
const stockDetail = read('src/components/StockDetail.jsx')
const detailStore = read('src/detailStore.js')
const precision = read('src/styles/precision.css')

test('个股详情提供可清空且有限长的个人备注编辑区', () => {
  assert.match(stockDetail, /<StockNoteEditor/)
  assert.match(stockDetail, /stockNoteText\(book\.stockNotes,\s*stock\.code\)/)
  assert.match(component, /className="stock-note-add"/)
  assert.match(component, /className="stock-note-editor"/)
  assert.match(component, /maxLength=\{STOCK_NOTE_MAX_LENGTH\}/)
  assert.match(component, /planStore\.setStockNote\(code,\s*draft\)/)
  assert.match(component, /保存备注/)
  assert.match(component, /删除备注/)
})

test('持仓卡保留备注入口且持仓与自选仅在有内容时显示摘要', () => {
  assert.match(
    planTab,
    /className=\{'icon-btn stock-note-edit-button'[\s\S]*?editNote:\s*true/,
  )
  assert.equal(
    (planTab.match(/<StockNoteSummary/g) || []).length,
    2,
  )
  assert.match(component, /if \(!text\) return null/)
  assert.match(
    component,
    /className="stock-note-summary"[\s\S]*?className="stock-note-summary-text"/,
  )
  assert.match(
    detailStore,
    /openStockDetail\(code,\s*name,\s*options\s*=\s*\{\}\)/,
  )
})

test('卡片备注复用完整建议的高对比悬浮预览且不改变触屏布局', () => {
  assert.match(
    component,
    /className="action-command-preview stock-note-preview"[\s\S]*?完整备注/,
  )
  assert.match(
    precision,
    /\.stock-note-summary\s*{[^}]*grid-template-columns:\s*auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto/s,
  )
  assert.match(
    precision,
    /\.stock-note-summary-text\s*{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
  )
  assert.match(
    precision,
    /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*{[\s\S]*?\.stock-note-summary:hover \.action-command-preview\s*{[^}]*visibility:\s*visible[^}]*opacity:\s*1/s,
  )
  assert.match(
    precision,
    /@media \(pointer:\s*coarse\)\s*{[\s\S]*?\.action-command-preview\s*{[^}]*display:\s*none/s,
  )
  assert.match(
    precision,
    /body:has\(\.modal-mask\) \.stock-note-summary \.action-command-preview,[\s\S]*?body:has\(\.modal-mask\) \.card-decision-slot \.action-command-preview\s*{[^}]*visibility:\s*hidden[^}]*opacity:\s*0/s,
  )
})
