import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { strategyGovernanceSnapshot } from '../api/strategy_governance.js'
import { strategySpecResponse } from '../api/strategy_specs.js'
import {
  buildStrategyResearchView,
} from '../shared/strategyResearch.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

test('策略研究视图合并五类策略与回测影子真实成绩', () => {
  const catalog = strategySpecResponse('').body
  const governance = strategyGovernanceSnapshot({})
  const view = buildStrategyResearchView({ catalog, governance })

  assert.equal(view.schemaVersion, 'strategy-research-view.v1')
  assert.equal(view.rows.length, 5)
  assert.equal(view.summary.active, 0)
  assert.equal(view.summary.rejected, 1)
  const baseline = view.rows.find(
    (item) => item.strategyId === 'market-quant-resonance',
  )
  assert.equal(baseline.state, 'rejected')
  assert.equal(baseline.backtest.folds, 4)
  assert.equal(baseline.backtest.returnPct, -1.19)
  assert.match(baseline.blockerText, /尚未|不足|未达到/)
  assert.doesNotMatch(baseline.blockerText, /[A-Z_]{4,}/)
  assert.match(baseline.modelVersion, /lgb-score-36/)
})

test('盘面研究优先展示今日策略雷达并折叠验证明细', () => {
  const research = read('src/components/ResearchTab.jsx')
  const panel = read('src/components/StrategyResearchPanel.jsx')
  const css = read('src/components/StrategyResearchPanel.css')

  assert.match(research, /StrategyResearchPanel/)
  assert.match(research, /<StrategyResearchPanel/)
  assert.match(panel, /\/api\/strategy_specs/)
  assert.match(panel, /\/api\/strategy_governance/)
  assert.match(panel, /buildStrategyRadar/)
  assert.match(panel, /usePlanStore/)
  assert.match(panel, /openStockDetail/)
  assert.match(panel, /aria-label="今日策略雷达"/)
  assert.match(panel, /当前主参考/)
  assert.match(panel, /对当前持仓/)
  assert.match(panel, /对自选买入/)
  assert.match(panel, /验证明细/)
  assert.match(panel, /<details/)
  assert.match(panel, /回测/)
  assert.match(panel, /模拟观察/)
  assert.match(panel, /真实成交/)
  assert.match(panel, /盈亏效率/)
  assert.doesNotMatch(panel, /\{row\.specVersion\}|\bPF\b| fold/)
  assert.match(css, /\.strategy-radar-overview/)
  assert.match(css, /\.strategy-radar-impact-grid/)
  assert.match(css, /\.strategy-research-table/)
  assert.match(css, /@media \(max-width:\s*720px\)/)
  assert.match(
    css,
    /@media \(max-width:\s*720px\)[\s\S]*?\.strategy-radar-impact-grid\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  )
})
