import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const reviewTab = readFileSync(
  new URL('../src/components/ReviewTab.jsx', import.meta.url),
  'utf8',
)
const planTab = readFileSync(
  new URL('../src/components/PlanTab.jsx', import.meta.url),
  'utf8',
)
const styles = readFileSync(
  new URL('../src/styles/precision.css', import.meta.url),
  'utf8',
)
const advisor = readFileSync(
  new URL('../src/adviceDaily.js', import.meta.url),
  'utf8',
)
const prompt = readFileSync(
  new URL('../api/_ai_prompts.js', import.meta.url),
  'utf8',
)
const intentSource = readFileSync(
  new URL('../shared/tradeIntent.js', import.meta.url),
  'utf8',
)

test('交易流水编辑器允许在仓位操作与做T之间切换', () => {
  assert.match(reviewTab, /操作类型/)
  assert.match(reviewTab, /value=\{tradeIntent\}/)
  assert.match(reviewTab, /setTradeIntent/)
  assert.match(reviewTab, /tradeIntent:\s*tradeIntent/)
  assert.match(intentSource, /做T买入/)
  assert.match(intentSource, /做T卖出/)
  assert.match(reviewTab, /tradeIntentLabel\(/)
  assert.match(
    reviewTab,
    /intent === 't' && t !== 'T'[\s\S]*待配对/,
  )
  assert.match(styles, /\.trade-edit-intent/)
})

test('军师前后端载荷包含修改后的交易分类与做T配对上下文', () => {
  assert.match(advisor, /tradeActivityContext/)
  assert.match(advisor, /tradeContext/)
  assert.match(prompt, /近期真实交易分类/)
  assert.match(prompt, /待配对/)
})

test('做T分类支持手动选择另一腿并在持仓做T弹窗展示配对结果', () => {
  assert.match(reviewTab, /manualTradePairCandidates/)
  assert.match(reviewTab, /配对另一腿/)
  assert.match(reviewTab, /value=\{pairTradeId\}/)
  assert.match(
    reviewTab,
    /tPairTradeId:\s*tradeIntent === 't' \? pairTradeId : null/,
  )
  assert.match(reviewTab, /已配对/)
  assert.match(planTab, /tradeActivityContext/)
  assert.match(planTab, /交易记录已配对/)
})

test('持仓卡提供成本价直接修改入口', () => {
  assert.match(planTab, /updateHoldingCost/)
  assert.match(planTab, /修改成本价/)
  assert.match(planTab, /mode === 'cost'/)
  assert.match(styles, /\.hold-cost-edit/)
})
