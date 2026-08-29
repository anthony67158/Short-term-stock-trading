import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const selection = fs.readFileSync(
  new URL('../src/components/FormulaSelection.jsx', import.meta.url),
  'utf8',
)
const candidate = fs.readFileSync(
  new URL(
    '../src/components/FormulaSelectionCandidate.jsx',
    import.meta.url,
  ),
  'utf8',
)
const tailPick = fs.readFileSync(
  new URL('../src/components/TailPick.jsx', import.meta.url),
  'utf8',
)
const price = fs.readFileSync(
  new URL('../src/components/FormulaPrice.jsx', import.meta.url),
  'utf8',
)
const today = fs.readFileSync(
  new URL('../src/components/TodayTab.jsx', import.meta.url),
  'utf8',
)
const detail = fs.readFileSync(
  new URL('../src/components/StockDetail.jsx', import.meta.url),
  'utf8',
)
const client = fs.readFileSync(
  new URL('../src/formulaSelectionClient.js', import.meta.url),
  'utf8',
)
const styles = fs.readFileSync(
  new URL('../src/styles/precision.css', import.meta.url),
  'utf8',
)

test('今日决策使用公式选股三视图并保留尾盘反转', () => {
  assert.match(today, /FormulaSelection/)
  assert.doesNotMatch(today, /<TailPick/)
  assert.match(selection, /公式选股/)
  assert.match(selection, /盘中机会/)
  assert.match(selection, /次日关注/)
  assert.match(selection, /尾盘反转/)
  assert.match(selection, /<TailPick/)
})

test('尾盘反转复用公式选股单面板而不是上下叠两张卡', () => {
  assert.match(
    selection,
    /mode === 'tail'[\s\S]*<TailPick[\s\S]*title="公式选股"/,
  )
  assert.match(selection, /navigation=\{tabs\}/)
  assert.doesNotMatch(
    selection,
    /<\/section>\s*\{mode === 'tail' && <TailPick/,
  )
  assert.match(tailPick, /title = '尾盘拾金'/)
  assert.match(tailPick, /\{navigation\}/)
})

test('公式候选只允许加入自选且展示唯一主价位', () => {
  assert.match(candidate, /primaryPrice/)
  assert.match(candidate, /priceType/)
  assert.match(candidate, /加入自选/)
  assert.match(candidate, /OBSERVE_ONLY/)
  assert.doesNotMatch(selection, /planStore\.buy/)
})

test('个股详情独立展示公式价位和军师参考权重', () => {
  assert.match(detail, /<FormulaPrice/)
  assert.match(price, /公式价位/)
  assert.match(price, /effectiveWeight/)
  assert.match(price, /唯一/)
  assert.match(price, /refreshFormulaPrice/)
})

test('公式选股请求携带账号凭证和明确超时', () => {
  assert.match(client, /accountRequestHeaders/)
  assert.match(client, /AbortController/)
  assert.match(client, /\/api\/formula_selection/)
  assert.match(client, /loadStockFormulaPrice/)
})

test('公式选股桌面信息密集且移动端稳定单列', () => {
  assert.match(styles, /\.formula-selection-tabs/)
  assert.match(styles, /\.formula-selection-row/)
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.formula-selection-row/,
  )
  assert.match(styles, /\.formula-price-panel/)
})
