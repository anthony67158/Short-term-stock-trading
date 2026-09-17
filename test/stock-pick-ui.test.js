import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const tab = read('src/components/StockPickTab.jsx')
const trace = read('src/components/StockPickRunTrace.jsx')
const agent = read('src/components/StockPickAgentPanel.jsx')
const pool = read('src/components/StockPickCandidatePool.jsx')
const client = read('src/stockPickClient.js')
const modes = read('shared/stockPickModes.js')
const styles = read('src/styles/precision.css')

test('选股页提供盘中机会、提前布局和次日关注三种模式', () => {
  assert.match(tab, /STOCK_PICK_MODES/)
  assert.match(modes, /盘中机会/)
  assert.match(modes, /提前布局/)
  assert.match(modes, /次日关注/)
  assert.match(tab, /role="tablist"/)
  assert.match(tab, /aria-selected=/)
})

test('次日关注支持人工名单、手动复算和首报价自动复算', () => {
  assert.match(tab, /saveNextDayStockSelection/)
  assert.match(tab, /recalculateNextDayStocks/)
  assert.match(tab, /firstQuoteRecalculationCodes/)
  assert.match(tab, /FIRST_QUOTE/)
  assert.match(tab, /重新测算/)
  assert.match(pool, /type="checkbox"/)
  assert.match(pool, /加入.*次日关注/)
  assert.match(client, /save_next_day_selection/)
  assert.match(client, /recalculate_next_day/)
})

test('Agent 运行过程展示阶段、工具、进度、异常和最终状态', () => {
  assert.match(tab, /StockPickRunTrace/)
  assert.match(trace, /Agent 执行过程/)
  assert.match(trace, /role="progressbar"/)
  assert.match(trace, /event\.tool/)
  assert.match(trace, /event\.detail/)
  assert.match(trace, /FAILED/)
  assert.match(trace, /aria-live="polite"/)
})

test('选股结果展示T+1、策略、触发、反方、失效和证据', () => {
  assert.match(agent, /T\+1 约束/)
  assert.match(agent, /买入策略/)
  assert.match(agent, /触发时机/)
  assert.match(agent, /反方/)
  assert.match(agent, /失效/)
  assert.match(agent, /selection\.evidence/)
  assert.match(agent, /NEXT_TRADING_DAY|下一交易日/)
})

test('选股布局在移动端收敛且交互控件满足触控尺寸', () => {
  assert.match(styles, /\.stock-pick-mode-tabs/)
  assert.match(styles, /\.stock-pick-trace-events/)
  assert.match(styles, /\.stock-pick-next-day/)
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)[\s\S]*?\.stock-pick-agent-grid[\s\S]*?grid-template-columns:\s*1fr/,
  )
  assert.match(styles, /\.stock-pick-pool-row[\s\S]*?min-height:\s*44px/)
})
