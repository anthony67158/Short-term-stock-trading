import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const planTab = read('src/components/PlanTab.jsx')
const precision = read('src/styles/precision.css')
const design = read('design.md')

test('持仓与自选卡只展示固定策略摘要并从详情入口查看完整建议', () => {
  assert.match(planTab, /function ActionCommand\(\{ view, onOpen \}\)/)
  assert.equal((planTab.match(/<ActionCommand[\s\S]{0,120}onOpen=/g) || []).length, 2)
  assert.match(planTab, /className="action-command-open"/)
  assert.match(planTab, /aria-label="查看完整操作建议"/)
  assert.doesNotMatch(planTab, /action-command-disclosure/)
  assert.doesNotMatch(planTab, /useLayoutEffect/)
})

test('桌面卡片使用同高摘要骨架且移动端恢复自然高度', () => {
  assert.match(planTab, /className="card-decision-slot"/)
  assert.equal((planTab.match(/className="card-decision-slot"/g) || []).length, 2)
  assert.match(
    precision,
    /\.hold-grid,[\s\S]*?\.plan-cand-grid\s*{[^}]*align-items:\s*stretch/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot\s*{[^}]*display:\s*flex[^}]*flex:\s*1[^}]*min-height:/s,
  )
  assert.match(precision, /\.card-decision-slot\s*{[^}]*flex-direction:\s*column/s)
  assert.match(
    precision,
    /\.card-decision-slot > \.action-decision,[\s\S]*?\.card-decision-slot > \.action-prompt,[\s\S]*?\.card-decision-slot > \.advice-generation-status\s*{[^}]*flex:\s*1/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*50rem\)\s*{[\s\S]*?\.card-decision-slot\s*{[^}]*min-height:\s*0/s,
  )
  assert.match(
    design,
    /Desktop uses a uniform compact[\s\S]*Mobile restores natural height/s,
  )
})

test('策略摘要压缩为单行指令、紧凑价位和单行进度', () => {
  assert.match(planTab, /className="action-progress-summary"/)
  assert.doesNotMatch(planTab, /className="action-progress-head"/)
  assert.match(
    precision,
    /\.card-decision-slot \.action-command-text\s*{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
  )
  assert.match(
    precision,
    /\.card-decision-slot \.action-level\s*{[^}]*min-height:\s*56px/s,
  )
  assert.match(
    precision,
    /\.action-progress-summary\s*{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/s,
  )
})

test('持仓卡在同一三列指标带展示盘中活跃度与主力资金', () => {
  const metricsStart = planTab.indexOf(
    '<div className="stock-card-metrics hold-card-metrics"',
  )
  const decisionStart = planTab.indexOf(
    '<div className="card-decision-slot">',
    metricsStart,
  )
  const metrics = planTab.slice(metricsStart, decisionStart)

  assert.match(
    metrics,
    />现价<\/span>[\s\S]*?>持仓<\/span>[\s\S]*?>成本<\/span>[\s\S]*?>换手<\/span>[\s\S]*?>量比<\/span>[\s\S]*?>主力<\/span>/,
  )
  assert.match(metrics, /fmtNum\(q\?\.turnover,\s*1\)/)
  assert.match(metrics, /fmtNum\(q\?\.volRatio,\s*1\)/)
  assert.match(metrics, /fmtInflow\(q\?\.mainInflow\)/)
  assert.equal(
    (metrics.match(/className="stock-card-metrics/g) || []).length,
    1,
  )
  assert.match(
    precision,
    /\.hold-card-metrics \.stock-card-market-metric\s*{[^}]*min-height:\s*44px/s,
  )
  assert.match(
    precision,
    /\.hold-card-metrics \.stock-card-market-metric\s*{[^}]*border-top:\s*1px solid var\(--color-rule-2\)/s,
  )
})

test('观望建议同时保留手动建仓与复核入口', () => {
  assert.match(
    planTab,
    /className=\{'pc-actions' \+ \(!actionable \? ' with-review' : ''\)\}/,
  )
  assert.match(
    planTab,
    /!actionable[\s\S]*?className="chip-btn ghost manual-build"[\s\S]*?onClick=\{\(\) => onBuy\(p, null\)\}[\s\S]*?手动建仓/s,
  )
  assert.match(
    planTab,
    /className="chip-btn ghost review-action"[\s\S]*?复核建议/s,
  )
  assert.match(
    precision,
    /\.plan-cand \.pc-actions\.with-review\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto\s+40px/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*30rem\)\s*{[\s\S]*?\.plan-cand \.pc-actions\.with-review\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s+40px/s,
  )
})
