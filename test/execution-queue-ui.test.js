import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

test('持仓执行顶部只有一个可移除的手动操作计划入口', () => {
  const planTab = read('src/components/PlanTab.jsx')
  const queue = read('src/components/ExecutionQueue.jsx')

  assert.match(planTab, /<ExecutionQueue/)
  assert.match(queue, /aria-label="待执行计划"/)
  assert.match(queue, /这里只提醒，不会自动交易/)
  assert.match(queue, /等待条件/)
  assert.match(queue, /价格已触发/)
  assert.match(queue, /确认准备/)
  assert.match(queue, /记录成交/)
  assert.match(queue, /已完成/)
  assert.match(queue, /planStore\.dismissExecutionPlan/)
  assert.match(queue, /移除.*操作计划/)
  assert.match(queue, /onOpen\?\.\(plan\.code,\s*plan\.name\)/)
  assert.doesNotMatch(queue, /自动下单/)
})

test('候选卡买入框与预警只读取统一动作视图的契约价', () => {
  const planTab = read('src/components/PlanTab.jsx')
  const planStore = read('src/planStore.js')

  assert.match(
    planTab,
    /const contractEntry = baseView\?\.levels\.find/,
  )
  assert.match(
    planTab,
    /roundActionPrice\(contractEntry\?\.price\)/,
  )
  assert.doesNotMatch(
    planTab,
    /const aiPrice = actionable \? roundActionPrice\(advice\?\.buyPrice\)/,
  )
  assert.match(planStore, /projectAdviceAlerts\(state, code/)
  assert.match(planStore, /requirePriceContract:\s*true/)
  assert.match(planTab, /pc-buyalert review-paths/)
  assert.match(planTab, /anyReached/)
  assert.match(planTab, /if \(!reviewing && !anyReached\) return null/)
  assert.match(planTab, /条件已触发，正在自动复核/)
  assert.doesNotMatch(planTab, /reviewAlerts\.map/)
})

test('个股建议只保留一个主结论并把扩展信息收进详情', () => {
  const presentation = read('src/components/AdvicePresentation.jsx')
  const stockDetail = read('src/components/StockDetail.jsx')
  const generation = read('src/components/AdviceGenerationStatus.jsx')
  const css = read('src/styles/precision.css')

  assert.match(presentation, /advice-command-center/)
  assert.match(presentation, /执行摘要/)
  assert.match(presentation, /加入待执行计划/)
  assert.match(presentation, /完整依据与复核/)
  assert.match(stockDetail, /onArmExecutionPlan/)
  assert.match(stockDetail, /className="btn btn-primary footbar-generate footbar-quick"/)
  assert.match(stockDetail, /onClick=\{\(\) => loadQuant\(false\)\}/)
  assert.match(stockDetail, /className="btn footbar-generate footbar-deep"/)
  assert.match(stockDetail, /onClick=\{\(\) => loadQuant\(true\)\}/)
  assert.match(stockDetail, /adviceActions\.quick\.label/)
  assert.match(stockDetail, /adviceActions\.deep\.label/)
  assert.doesNotMatch(stockDetail, /className="quant-cta-actions"/)
  assert.match(stockDetail, /完整结果/)
  assert.doesNotMatch(stockDetail, /className="sk-hint"/)
  assert.match(generation, /advice-generation-flow/)
  assert.match(generation, /adviceGenerationSteps/)
  assert.match(generation, /generation-flow-steps/)
  assert.match(generation, /下方是上次结论，不是本轮结果/)
  assert.match(
    css,
    /\.advice-generation-flow\.deep \.generation-flow-steps\s*{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    css,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.advice-generation-flow\.deep \.generation-flow-steps\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('个股建议展示短线窗口优势风险与下一复核条件', () => {
  const presentation = read('src/components/AdvicePresentation.jsx')
  const precision = read('src/styles/precision.css')

  assert.match(presentation, /advice-short-horizon/)
  assert.match(presentation, /短线窗口/)
  assert.match(presentation, /核心优势/)
  assert.match(presentation, /最大风险/)
  assert.match(presentation, /重评：/)
  assert.match(precision, /\.advice-short-horizon-grid/)
})

test('个股详情用紧凑提示说明生成模式、Judge 与止损纪律', () => {
  const stockDetail = read('src/components/StockDetail.jsx')
  const css = read('src/styles/precision.css')

  assert.match(stockDetail, /adviceModeGuidance/)
  assert.match(stockDetail, /role="note"/)
  assert.match(stockDetail, /aria-label="建议生成方式说明"/)
  assert.match(stockDetail, /id="advice-mode-guide"/)
  assert.match(stockDetail, /modeGuidance\.items\.map/)
  assert.match(stockDetail, /modeGuidance\.deepBadge/)
  assert.match(stockDetail, /modeGuidance\.deepUseCase/)
  assert.match(stockDetail, /modeGuidance\.deepTitle/)
  assert.match(stockDetail, /className="footbar-mode-usecase"/)
  assert.match(stockDetail, /aria-describedby="advice-mode-guide"/)
  assert.match(
    css,
    /\.advice-mode-guide\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s,
  )
  assert.match(
    css,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.advice-mode-guide\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  )
})

test('证据缺失时主视图展示来源原因影响与恢复方式', () => {
  const presentation = read('src/components/AdvicePresentation.jsx')
  const css = read('src/styles/precision.css')

  assert.match(presentation, /function EvidenceGapNotice/)
  assert.match(presentation, /aria-label="缺失证据说明"/)
  assert.match(presentation, /失败原因/)
  assert.match(presentation, /决策影响/)
  assert.match(presentation, /恢复方式/)
  assert.match(presentation, /view\.decisionPlan\?\.evidenceIssues/)
  assert.match(presentation, /数据口径/)
  assert.match(presentation, /evidenceBasis/)
  assert.match(css, /\.advice-evidence-gap\s*{/)
  assert.match(css, /\.aeg-item\s*{/)
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
