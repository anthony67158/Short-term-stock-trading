import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPPORTUNITY_RADAR_LEDGER_SCHEMA_VERSION,
  buildOpportunityRadarLedgerBatch,
} from '../shared/opportunityRadarLedger.js'

function event(overrides = {}) {
  return {
    code: '600001',
    name: '测试股份',
    stageReached: 'EVIDENCE',
    quote: {
      price: 10.2,
      preClose: 10,
      open: 10.05,
      high: 10.3,
      low: 9.98,
      pct: 1.5,
      amount: 120_000_000,
      turnover: 3.2,
      volumeRatio: 1.4,
      tradeDate: '2026-09-02',
    },
    formulaEvaluations: [{
      formulaId: 'INTRADAY_VWAP_PULLBACK',
      matched: true,
      score: 88,
      blockers: [],
    }],
    decision: {
      action: 'WATCH_BUY',
      formulaId: 'INTRADAY_VWAP_PULLBACK',
      primaryPrice: 10,
      stopPrice: 9.6,
      targetPrice: 10.9,
      riskReward: 2.25,
      validUntil: 1_788_323_600_000,
      timeStopTradingDays: 5,
      priceContractValid: true,
    },
    sector: {
      code: 'BK001',
      name: '测试方向',
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
    },
    rejectionReasons: [],
    ...overrides,
  }
}

test('机会雷达账本为每只候选生成稳定决策ID和规则版本', () => {
  const batch = buildOpportunityRadarLedgerBatch({
    mode: 'intraday',
    tradeDate: '2026-09-02',
    slot: '0600',
    generatedAt: 1_788_320_000_000,
    universe: {
      total: 5500,
      inspectedCount: 5500,
      prefilterCount: 120,
      technicalCandidateCount: 18,
      formulaMatchCount: 6,
    },
    marketGate: {
      allowed: true,
      blockers: [],
    },
    events: [event()],
  })

  assert.equal(
    batch.schemaVersion,
    OPPORTUNITY_RADAR_LEDGER_SCHEMA_VERSION,
  )
  assert.equal(batch.runId, '2026-09-02:intraday:0600')
  assert.equal(
    batch.events[0].decisionId,
    'formula:2026-09-02:intraday:0600:600001',
  )
  assert.equal(
    batch.events[0].ruleVersion,
    'CN_A_SHARE_2026_07_06',
  )
  assert.equal(batch.events[0].quote.preClose, 10)
  assert.equal(
    batch.events[0].decision.validUntil,
    1_788_323_600_000,
  )
  assert.equal(batch.events[0].decision.timeStopTradingDays, 5)
  assert.deepEqual(batch.summary, {
    total: 1,
    prefilter: 0,
    technical: 0,
    evidence: 1,
    displayed: 0,
    priceContracts: 1,
  })
})

test('账本保留未展示和被淘汰候选而不携带大型原始数据', () => {
  const batch = buildOpportunityRadarLedgerBatch({
    mode: 'close',
    tradeDate: '2026-09-02',
    slot: '1505',
    generatedAt: 1_788_320_000_000,
    events: [
      event({
        stageReached: 'TECHNICAL',
        rejectionReasons: ['收盘未站上MA20'],
        candles: Array.from({ length: 60 }, () => ({ close: 10 })),
      }),
      event({
        code: '600002',
        name: '展示股份',
        stageReached: 'DISPLAYED',
        displayedRank: 1,
      }),
    ],
  })

  assert.equal(batch.events.length, 2)
  assert.deepEqual(
    batch.events[0].rejectionReasons,
    ['收盘未站上MA20'],
  )
  assert.equal('candles' in batch.events[0], false)
  assert.equal(batch.events[1].displayedRank, 1)
  assert.equal(batch.summary.technical, 1)
  assert.equal(batch.summary.displayed, 1)
})

test('账本拒绝无效日期模式和重复股票事件', () => {
  assert.throws(() => buildOpportunityRadarLedgerBatch({
    mode: 'tail',
    tradeDate: '2026-09-02',
    slot: '1505',
  }), /模式无效/)
  assert.throws(() => buildOpportunityRadarLedgerBatch({
    mode: 'intraday',
    tradeDate: 'bad',
    slot: '0600',
  }), /日期无效/)
  assert.throws(() => buildOpportunityRadarLedgerBatch({
    mode: 'intraday',
    tradeDate: '2026-09-02',
    slot: '0600',
    events: [event(), event()],
  }), /重复股票/)
})
