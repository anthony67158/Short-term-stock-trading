import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

test('持仓执行顶部只有一个人工动作队列入口', () => {
  const planTab = read('src/components/PlanTab.jsx')
  const queue = read('src/components/ExecutionQueue.jsx')

  assert.match(planTab, /<ExecutionQueue/)
  assert.match(queue, /aria-label="人工执行队列"/)
  assert.match(queue, /等待条件/)
  assert.match(queue, /已到价/)
  assert.match(queue, /确认执行/)
  assert.match(queue, /记录成交/)
  assert.match(queue, /已完成/)
  assert.match(queue, /onOpen\?\.\(plan\.code,\s*plan\.name\)/)
  assert.doesNotMatch(queue, /自动下单/)
})

test('个股建议只保留一个主结论并把扩展信息收进详情', () => {
  const presentation = read('src/components/AdvicePresentation.jsx')
  const stockDetail = read('src/components/StockDetail.jsx')
  const generation = read('src/components/AdviceGenerationStatus.jsx')

  assert.match(presentation, /advice-command-center/)
  assert.match(presentation, /执行摘要/)
  assert.match(presentation, /加入执行队列/)
  assert.match(presentation, /完整依据与复核/)
  assert.match(stockDetail, /onArmExecutionPlan/)
  assert.match(stockDetail, /快速生成建议/)
  assert.match(stockDetail, /深度研判/)
  assert.match(stockDetail, /adviceActionCompactLabel/)
  assert.match(stockDetail, /footbar-main-label compact/)
  assert.doesNotMatch(stockDetail, /footbar-deep/)
  assert.doesNotMatch(stockDetail, /className="sk-hint"/)
  assert.match(generation, /advice-generation-flow/)
  assert.match(generation, /adviceGenerationSteps/)
  assert.match(generation, /generation-flow-steps/)
  assert.match(generation, /下方为上次已保存结果/)
})

test('执行队列与建议摘要具备移动端单列布局', () => {
  const css = read('src/styles/precision.css') + read('src/styles.css')

  assert.match(css, /\.execution-queue/)
  assert.match(
    css,
    /\.advice-command-center\s*{[^}]*border-inline:\s*0[^}]*background:\s*transparent/s,
  )
  assert.match(css, /@media \(max-width: 640px\)/)
})
