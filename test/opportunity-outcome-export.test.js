import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOpportunityOutcomeExport,
} from '../scripts/export-opportunity-outcomes.mjs'

test('机会训练导出只保留成熟且带冻结特征的市场级结果', () => {
  const values = [{
    decisionId: 'formula:2026-09-02:close:1505:600001',
    tradeDate: '2026-09-02',
    maturity: 'MATURED',
    code: '600001',
    scoreInput: {
      schemaVersion: 'opportunity-score-feature.v1',
      code: '600001',
      formulaId: 'CLOSE_TREND_PULLBACK',
      factors: { cheapScore: 40 },
    },
    metrics: { netR: 1 },
    account: { cash: 999999 },
  }, {
    decisionId: 'formula:2026-09-03:close:1505:600002',
    tradeDate: '2026-09-03',
    maturity: 'PENDING',
    code: '600002',
  }]

  const exported = buildOpportunityOutcomeExport(values, {
    from: '2026-09-01',
    to: '2026-09-30',
    exportedAt: 1_788_406_400_000,
  })

  assert.equal(exported.schemaVersion, 'opportunity-outcome-export.v1')
  assert.equal(exported.outcomes.length, 1)
  assert.equal(exported.outcomes[0].code, '600001')
  assert.equal('account' in exported.outcomes[0], false)
  assert.equal(exported.summary.excluded, 1)
})

test('机会训练导出按决策ID稳定排序并拒绝非法范围', () => {
  const values = ['600002', '600001'].map((code) => ({
    decisionId: `formula:2026-09-02:close:1505:${code}`,
    tradeDate: '2026-09-02',
    maturity: 'MATURED',
    code,
    scoreInput: {
      schemaVersion: 'opportunity-score-feature.v1',
      code,
      formulaId: 'CLOSE_TREND_PULLBACK',
      factors: {},
    },
  }))

  const exported = buildOpportunityOutcomeExport(values, {
    from: '2026-09-01',
    to: '2026-09-30',
  })

  assert.deepEqual(
    exported.outcomes.map((item) => item.code),
    ['600001', '600002'],
  )
  assert.throws(() => buildOpportunityOutcomeExport([], {
    from: 'bad',
    to: '2026-09-30',
  }), /日期范围无效/)
})
