import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPPORTUNITY_PORTFOLIO_SCHEMA_VERSION,
  analyzeOpportunityPortfolio,
} from '../shared/opportunityPortfolio.js'

function row(overrides = {}) {
  return {
    code: '600001',
    name: '示例股份',
    lane: 'intraday',
    state: 'READY',
    sector: { code: 'BK1001', name: '先进制造' },
    riskReward: 2.2,
    entryPlan: { maxPositionPct: 5 },
    ...overrides,
  }
}

test('组合分析不修改任何个股结论字段', () => {
  const rows = [
    row({ code: '600001' }),
    row({ code: '600002', state: 'WAIT_TRIGGER' }),
  ]
  const snapshot = JSON.parse(JSON.stringify(rows))
  const result = analyzeOpportunityPortfolio({ rows })

  assert.equal(result.schemaVersion, OPPORTUNITY_PORTFOLIO_SCHEMA_VERSION)
  // 原始行对象保持不变（未被 mutate）
  assert.deepEqual(rows, snapshot)
  // 每个入场候选都在组合视图里被标注，但 state 保持原值
  const first = result.candidates.find((item) => item.code === '600001')
  assert.equal(first.state, 'READY')
})

test('同板块暴露超过上限时把超出的候选降级为观察但不改原state', () => {
  const rows = [
    row({ code: '600001', score: 90 }),
    row({ code: '600002', score: 85 }),
    row({ code: '600003', score: 80 }),
  ]
  const result = analyzeOpportunityPortfolio({
    rows,
    maxPerSectorPct: 8,
  })

  const included = result.candidates.filter(
    (item) => item.portfolioState === 'INCLUDED',
  )
  const trimmed = result.candidates.filter(
    (item) => item.portfolioState === 'SECTOR_CAPPED',
  )
  // 单板块上限 8%、每只 5%，最多纳入 1 只（第 2 只累计到 10% 超限）
  assert.equal(included.length, 1)
  assert.equal(included[0].code, '600001')
  assert.equal(trimmed.length, 2)
  // 被降级候选保留原始 state，仅新增组合层标签
  assert.equal(trimmed[0].state, 'READY')
  assert.match(trimmed[0].portfolioReason, /先进制造|板块/)
  // 板块暴露聚合
  const sector = result.sectorExposure.find(
    (item) => item.sectorCode === 'BK1001',
  )
  assert.equal(sector.requestedPct, 15)
  assert.equal(sector.approvedPct, 5)
})

test('总新增风险预算限制同时可纳入的独立机会', () => {
  const rows = [
    row({ code: '600001', sector: { code: 'BK1', name: '板块一' } }),
    row({ code: '600002', sector: { code: 'BK2', name: '板块二' } }),
    row({ code: '600003', sector: { code: 'BK3', name: '板块三' } }),
    row({ code: '600004', sector: { code: 'BK4', name: '板块四' } }),
  ]
  const result = analyzeOpportunityPortfolio({
    rows,
    maxTotalNewRiskPct: 12,
  })

  const included = result.candidates.filter(
    (item) => item.portfolioState === 'INCLUDED',
  )
  // 每只 5%，总预算 12% → 只能纳入 2 只
  assert.equal(included.length, 2)
  assert.equal(result.budget.approvedPct, 10)
  assert.equal(result.budget.limitPct, 12)
  const capped = result.candidates.filter(
    (item) => item.portfolioState === 'BUDGET_CAPPED',
  )
  assert.equal(capped.length, 2)
  assert.match(capped[0].portfolioReason, /预算|风险/)
})

test('高相关去重：同板块高分候选优先，其余标记为冗余', () => {
  const rows = [
    row({ code: '600001', sector: { code: 'BK1', name: '板块一' }, score: 70 }),
    row({ code: '600002', sector: { code: 'BK1', name: '板块一' }, score: 92 }),
  ]
  const result = analyzeOpportunityPortfolio({
    rows,
    maxPerSectorPct: 5,
  })
  const included = result.candidates.filter(
    (item) => item.portfolioState === 'INCLUDED',
  )
  assert.equal(included.length, 1)
  // 同板块内更高分的优先纳入
  assert.equal(included[0].code, '600002')
})

test('已持仓的同板块暴露计入板块上限', () => {
  const rows = [
    row({ code: '600002', sector: { code: 'BK1001', name: '先进制造' } }),
  ]
  const result = analyzeOpportunityPortfolio({
    rows,
    maxPerSectorPct: 8,
    holdings: [
      { code: '600009', sectorCode: 'BK1001', positionPct: 6 },
    ],
  })
  // 已占 6%，再加 5% 超过 8% 上限 → 候选被板块降级
  const candidate = result.candidates[0]
  assert.equal(candidate.portfolioState, 'SECTOR_CAPPED')
  const sector = result.sectorExposure.find(
    (item) => item.sectorCode === 'BK1001',
  )
  assert.equal(sector.heldPct, 6)
})

test('只有可入场候选参与组合预算，观察方向类不占预算', () => {
  const rows = [
    row({ code: '600001', state: 'READY' }),
    row({
      code: '600002',
      state: 'SECTOR_WATCH',
      entryPlan: null,
      riskReward: null,
    }),
    row({ code: '600003', state: 'AVOID', entryPlan: null }),
  ]
  const result = analyzeOpportunityPortfolio({ rows })
  // 只有 600001 进入预算占用
  assert.equal(result.budget.approvedPct, 5)
  const watch = result.candidates.find((item) => item.code === '600002')
  assert.equal(watch.portfolioState, 'NOT_ACTIONABLE')
  assert.equal(watch.state, 'SECTOR_WATCH')
})

test('组合视图按原始展示顺序还原，不因内部预算排序而错位', () => {
  const rows = [
    row({ code: '600001', score: 60, sector: { code: 'BK1', name: '一' } }),
    row({ code: '600002', score: 99, sector: { code: 'BK2', name: '二' } }),
    row({ code: '600003', score: 75, sector: { code: 'BK3', name: '三' } }),
  ]
  const result = analyzeOpportunityPortfolio({ rows })
  assert.deepEqual(
    result.candidates.map((item) => item.code),
    ['600001', '600002', '600003'],
  )
  // 内部按分数优先占预算：高分 600002 先纳入，但展示顺序不变
  assert.equal(
    result.candidates.find((i) => i.code === '600002').portfolioState,
    'INCLUDED',
  )
  // 输出不残留内部排序字段
  assert.equal('_order' in result.candidates[0], false)
})

test('空输入与缺失字段安全降级', () => {
  const empty = analyzeOpportunityPortfolio({ rows: [] })
  assert.equal(empty.candidates.length, 0)
  assert.equal(empty.budget.approvedPct, 0)
  assert.deepEqual(empty.sectorExposure, [])

  const missing = analyzeOpportunityPortfolio({
    rows: [{ code: '600001', state: 'READY' }],
  })
  // 无 sector / entryPlan 时用默认仓位，且不抛错
  assert.equal(missing.candidates.length, 1)
})
