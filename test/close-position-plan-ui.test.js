import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const summary = readFileSync(
  new URL('../src/components/DecisionSummary.jsx', import.meta.url),
  'utf8',
)
const closePlan = readFileSync(
  new URL('../src/components/ClosePositionPlan.jsx', import.meta.url),
  'utf8',
)
const planTab = readFileSync(
  new URL('../src/components/PlanTab.jsx', import.meta.url),
  'utf8',
)
const stockDetail = readFileSync(
  new URL('../src/components/StockDetail.jsx', import.meta.url),
  'utf8',
)

test('收盘卡片使用独立次日预案并撤下盘中加仓说明', () => {
  assert.match(summary, /<ClosePositionPlan plan=\{closePositionPlan\}/)
  assert.match(
    summary,
    /detailed && !closePositionPlan && <EntryInstruction/,
  )
  assert.match(closePlan, /次日交易预案/)
  assert.match(closePlan, /次日开盘三种路径/)
  assert.match(closePlan, /至止损额外风险/)
  assert.match(closePlan, /模型动作价值/)
  assert.match(closePlan, /失效条件/)
})

test('持仓卡和详情页都向展示合同提供最近收盘价', () => {
  assert.match(
    planTab,
    /currentPrice: validPx, closePrice: effPx/,
  )
  assert.equal(
    (stockDetail.match(
      /closePrice=\{quoteDisplayState\(overview\)\.price\}/g,
    ) || []).length,
    2,
  )
})
