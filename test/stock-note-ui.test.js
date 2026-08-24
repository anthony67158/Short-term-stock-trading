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

test('持仓卡移除备注编辑按钮且摘要只打开详情阅读定位', () => {
  assert.doesNotMatch(planTab, /stock-note-edit-button/)
  assert.equal(
    (planTab.match(/<StockNoteSummary/g) || []).length,
    2,
  )
  assert.equal(
    (planTab.match(/focusNote:\s*true/g) || []).length,
    2,
  )
  assert.doesNotMatch(planTab, /editNote:\s*true/)
  assert.match(component, /if \(!text\) return null/)
  assert.match(component, /onClick=\{onOpen\}/)
  assert.match(
    component,
    /'stock-note-summary'[\s\S]*?has-preview[\s\S]*?className="stock-note-summary-text"/,
  )
  assert.match(
    detailStore,
    /openStockDetail\(code,\s*name,\s*options\s*=\s*\{\}\)/,
  )
})

test('个股详情聚焦备注区域但保持阅读态', () => {
  assert.match(stockDetail, /const noteAnchorRef = useRef\(null\)/)
  assert.match(stockDetail, /stock\?\.focusNote/)
  assert.match(stockDetail, /noteAnchorRef\.current\?\.scrollIntoView/)
  assert.match(stockDetail, /noteAnchorRef\.current\?\.focus/)
  assert.match(stockDetail, /className="stock-note-anchor"/)
  assert.doesNotMatch(stockDetail, /initialEditing=/)
  assert.doesNotMatch(component, /initialEditing/)
})

test('移动端三个持仓交易按钮固定在同一行', () => {
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.hold-item\s*>\s*\.pi-actions\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+44px/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.pi-trade-actions\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.pi-card-tools\s*{[^}]*width:\s*44px[^}]*padding-top:\s*0[^}]*border-top:\s*0/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.pi-card-tools\s*>\s*\.chip-btn\s*{[^}]*display:\s*none/s,
  )
  assert.match(
    planTab,
    /className="chip-btn ghost hold-plan-mobile"[\s\S]*?添加计划/,
  )
  assert.match(
    precision,
    /\.hold-plan-mobile\s*{[^}]*display:\s*none/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.hold-plan-mobile\s*{[^}]*display:\s*inline-flex/s,
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
    /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*{[\s\S]*?\.stock-note-summary\.has-preview:hover \.action-command-preview\s*{[^}]*visibility:\s*visible[^}]*opacity:\s*1/s,
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
