import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSectorOpportunity,
} from '../shared/sectorOpportunity.js'

const snapshot = ({
  generatedAt = 100,
  session = 'close',
  actionability = 'LAYOUT',
  stockCode = '002594',
  role = 'leader',
} = {}) => ({
  signalDate: '2026-08-25',
  generatedAt,
  session,
  sectors: [{
    code: 'BK1234',
    name: '新能源车',
    rank: 1,
    phase: 'STARTUP',
    actionability,
    breadth: {
      upPct: 72,
      inflowPct: 68,
      memberCount: 25,
    },
    forecast: {
      next: { score: 76 },
      week: { score: 70 },
    },
    reasons: ['资金持续流入', '成分股扩散'],
    risks: ['高开过多不追'],
    stocks: [{
      code: stockCode,
      name: '比亚迪',
      role,
      roleLabel: role === 'leader' ? '总龙头' : '趋势中军',
      score: 82,
      pct: 3.2,
      mainInflow: 320000000,
    }],
  }],
})

test('板块可以买入且个股位于前排时形成短线试仓机会', () => {
  const opportunity = buildSectorOpportunity({
    code: '002594',
    latest: snapshot(),
    now: 200,
  })

  assert.equal(opportunity.schemaVersion, 'sector-opportunity.v1')
  assert.equal(opportunity.matched, true)
  assert.equal(opportunity.probeEligible, true)
  assert.equal(opportunity.entryMode, 'MANUAL_PROBE')
  assert.equal(opportunity.sector.name, '新能源车')
  assert.equal(opportunity.stock.role, 'leader')
  assert.equal(opportunity.sector.breadth, 68)
})

test('盘中快照较新时优先使用盘中结论', () => {
  const opportunity = buildSectorOpportunity({
    code: '002594',
    latest: snapshot({
      generatedAt: 100,
      actionability: 'WAIT_PULLBACK',
    }),
    intraday: snapshot({
      generatedAt: 200,
      session: 'intraday',
      actionability: 'LAYOUT',
    }),
    now: 300,
  })

  assert.equal(opportunity.sourceSession, 'intraday')
  assert.equal(opportunity.generatedAt, 200)
  assert.equal(opportunity.probeEligible, true)
})

test('较新的盘中候选池已移除个股时不回退到旧正式版', () => {
  const opportunity = buildSectorOpportunity({
    code: '002594',
    latest: snapshot({ generatedAt: 100 }),
    intraday: snapshot({
      generatedAt: 200,
      session: 'intraday',
      stockCode: '000001',
    }),
    now: 300,
  })

  assert.equal(opportunity.matched, false)
  assert.equal(opportunity.probeEligible, false)
})

test('等回踩、非前排或未进入板块候选时不开放试仓', () => {
  assert.equal(buildSectorOpportunity({
    code: '002594',
    latest: snapshot({ actionability: 'WAIT_PULLBACK' }),
    now: 200,
  }).probeEligible, false)

  assert.equal(buildSectorOpportunity({
    code: '002594',
    latest: snapshot({ role: 'follower' }),
    now: 200,
  }).probeEligible, false)

  assert.deepEqual(buildSectorOpportunity({
    code: '600519',
    latest: snapshot(),
    now: 200,
  }), {
    schemaVersion: 'sector-opportunity.v1',
    matched: false,
    probeEligible: false,
    entryMode: 'NONE',
  })
})

test('超过三天的板块结论不能继续开放短线试仓', () => {
  const opportunity = buildSectorOpportunity({
    code: '002594',
    latest: snapshot({ generatedAt: 100 }),
    now: 100 + 72 * 60 * 60 * 1000 + 1,
  })

  assert.equal(opportunity.matched, false)
  assert.equal(opportunity.probeEligible, false)
})
