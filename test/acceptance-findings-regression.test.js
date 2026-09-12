import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('持仓导航只统计真实持仓而不是自选数量', () => {
  const app = source('../src/App.jsx')
  assert.match(app, /const planCount = book\.holding\.length/)
  assert.doesNotMatch(
    app,
    /const planCount = book\.plan\.length \+ book\.holding\.length/,
  )
})

test('执行队列明确展示已成交进度而不是无标签的剩余手数', () => {
  const queue = source('../src/components/ExecutionQueue.jsx')
  const planTab = source('../src/components/PlanTab.jsx')
  const presentation = source('../shared/reviewPresentation.js')
  assert.match(presentation, /已成交/)
  assert.doesNotMatch(
    queue,
    /\{plan\.remainingLots\}\/\{plan\.targetLots\}手/,
  )
  assert.match(planTab, /quoteMap=\{executionQuote\}/)
})

test('交易复盘按模拟账户切换语义且负期望不再称为可赚', () => {
  const review = source('../src/components/ReviewTab.jsx')
  const selection = source(
    '../src/components/SelectionPerformance.jsx',
  )
  assert.match(review, /book\.account\?\.simulation/)
  assert.match(review, /系统决策/)
  assert.doesNotMatch(review, />每笔平均可赚</)
  assert.match(selection, /simulation/)
  assert.doesNotMatch(
    selection,
    /当前账本中的真实费后卖出结果/,
  )
})
