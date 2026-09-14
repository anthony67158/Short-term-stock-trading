import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LOW_CORRELATION_SELECTION_VERSION,
  selectLowCorrelationOpportunities,
} from '../shared/lowCorrelationSelection.js'

function cand(code, {
  state = 'READY',
  sector = '',
  concepts = [],
  playbook = '',
} = {}) {
  return {
    code,
    state,
    sector,
    concepts,
    adaptive: { playbook: { key: playbook } },
  }
}

test('同板块超过上限的候选被去重', () => {
  const out = selectLowCorrelationOpportunities([
    cand('600000', { sector: '银行', playbook: 'A' }),
    cand('600016', { sector: '银行', playbook: 'B' }),
    cand('601398', { sector: '银行', playbook: 'C' }),
  ], { maxPerSector: 2, conceptJaccardMax: 0.5 })
  assert.equal(out.effectiveCount, 2)
  assert.deepEqual(out.selected.map((c) => c.code), ['600000', '600016'])
  assert.equal(out.skipped.at(-1).reason, 'SECTOR_LIMIT')
})

test('概念高度重叠的候选按相关性去重', () => {
  const out = selectLowCorrelationOpportunities([
    cand('600111', { concepts: ['稀土', '磁材'], playbook: 'A' }),
    cand('600392', { concepts: ['稀土', '磁材'], playbook: 'B' }),
  ], { conceptJaccardMax: 0.5 })
  assert.equal(out.effectiveCount, 1)
  assert.equal(out.skipped[0].reason, 'HIGH_CORRELATION')
})

test('打法数量上限限制同类打法扎堆', () => {
  const out = selectLowCorrelationOpportunities([
    cand('600001', { sector: 'S1', concepts: ['c1'], playbook: 'MOM' }),
    cand('600002', { sector: 'S2', concepts: ['c2'], playbook: 'MOM' }),
    cand('600003', { sector: 'S3', concepts: ['c3'], playbook: 'MOM' }),
  ], { maxPerPlaybook: 2 })
  assert.equal(out.effectiveCount, 2)
  assert.equal(out.skipped[0].reason, 'PLAYBOOK_LIMIT')
})

test('非READY状态不计入有效机会', () => {
  const out = selectLowCorrelationOpportunities([
    cand('600001', { state: 'WAIT_TRIGGER', sector: 'S1' }),
    cand('600002', { state: 'AVOID', sector: 'S2' }),
    cand('600003', { state: 'READY', sector: 'S3' }),
  ])
  assert.equal(out.effectiveCount, 1)
  assert.deepEqual(out.selected.map((c) => c.code), ['600003'])
})

test('容量上限截断并标记原因', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    cand(`60${String(1000 + i)}`, {
      sector: `S${i}`,
      concepts: [`c${i}`],
      playbook: `P${i}`,
    }),
  )
  const out = selectLowCorrelationOpportunities(many, { maxSelections: 8 })
  assert.equal(out.effectiveCount, 8)
  assert.ok(out.skipped.some((s) => s.reason === 'CAPACITY_FULL'))
  assert.equal(out.schemaVersion, LOW_CORRELATION_SELECTION_VERSION)
})

test('低相关候选全部纳入并给出板块/打法分布', () => {
  const out = selectLowCorrelationOpportunities([
    cand('600001', { sector: '半导体', concepts: ['芯片'], playbook: 'MOM' }),
    cand('600002', { sector: '医药', concepts: ['创新药'], playbook: 'ACC' }),
    cand('600003', { sector: '电力', concepts: ['绿电'], playbook: 'CAT' }),
  ])
  assert.equal(out.effectiveCount, 3)
  assert.equal(out.sectorBreakdown['半导体'], 1)
  assert.equal(out.playbookBreakdown.MOM, 1)
})
