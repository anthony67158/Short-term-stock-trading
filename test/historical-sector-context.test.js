import test from 'node:test'
import assert from 'node:assert/strict'

import {
  activeSectorMembershipByCode,
  buildHistoricalSectorOpportunities,
} from '../scripts/lib/historical-sector-context.mjs'


const memberships = [
  {
    code: '600001',
    sectorCode: '801780.SI',
    sectorName: '银行',
    inDate: '20200101',
    outDate: null,
  },
  {
    code: '600002',
    sectorCode: '801780.SI',
    sectorName: '银行',
    inDate: '20200101',
    outDate: null,
  },
  {
    code: '600003',
    sectorCode: '801880.SI',
    sectorName: '汽车',
    inDate: '20200101',
    outDate: '20251231',
  },
]

test('历史行业成员严格按生效区间选择', () => {
  const selected = activeSectorMembershipByCode(
    memberships,
    '20260910',
  )

  assert.equal(selected.get('600001').sectorName, '银行')
  assert.equal(selected.has('600003'), false)
})

test('历史板块上下文由当时可见涨跌和资金聚合', () => {
  const result = buildHistoricalSectorOpportunities({
    tradeDate: '20260910',
    memberships,
    quotes: [
      { code: '600001', pct: 1.5 },
      { code: '600002', pct: 0.5 },
    ],
    funds: new Map([
      ['600001', { main5dYi: 1.2 }],
      ['600002', { main5dYi: 0.8 }],
    ]),
  })

  const bank = result.get('600001')
  assert.equal(bank.matched, true)
  assert.equal(bank.sector.code, '801780.SI')
  assert.equal(bank.sector.phase, 'STARTUP')
  assert.equal(bank.sector.actionability, 'LAYOUT')
  assert.equal(bank.sector.mainNetYi, 2)
  assert.equal(bank.sector.breadthPct, 100)
  assert.equal(bank.sector.memberCount, 2)
  assert.equal(bank.sector.rank, 1)
})
