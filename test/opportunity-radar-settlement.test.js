import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPPORTUNITY_RADAR_SETTLEMENT_SCHEMA_VERSION,
  settleOpportunityRadarOutcomes,
} from '../api/_opportunity_radar_settlement.js'

function event({
  tradeDate,
  code = '600001',
  priceType,
  primaryPrice,
  stopPrice,
  targetPrice,
}) {
  return {
    decisionId:
      `formula:${tradeDate}:close:1505:${code}`,
    asOf: Date.parse(`${tradeDate}T07:05:00.000Z`),
    code,
    name: '测试股份',
    mode: 'CLOSE',
    tradeDate,
    ruleVersion: 'CN_A_SHARE_2026_07_06',
    quote: {
      price: 10,
      preClose: 9.8,
    },
    decision: {
      formulaId: 'CLOSE_TREND_PULLBACK',
      primaryPrice,
      priceType,
      stopPrice,
      targetPrice,
      priceContractValid: true,
      timeStopTradingDays: 5,
    },
  }
}

function batch(tradeDate, candidate) {
  return {
    schemaVersion: 'opportunity-radar-ledger.v1',
    runId: `${tradeDate}:close:1505`,
    generatedAt: candidate.asOf,
    tradeDate,
    mode: 'CLOSE',
    slot: '1505',
    events: [candidate],
  }
}

function bars() {
  return [
    {
      tradeTime: '2026-09-01 15:00:00',
      open: 10,
      high: 10.2,
      low: 9.8,
      close: 10,
      volume: 100_000,
    },
    {
      tradeTime: '2026-09-02 09:35:00',
      open: 10.05,
      high: 10.2,
      low: 9.95,
      close: 10.1,
      volume: 100_000,
    },
    {
      tradeTime: '2026-09-02 15:00:00',
      open: 10.1,
      high: 10.4,
      low: 10,
      close: 10.2,
      volume: 100_000,
    },
    {
      tradeTime: '2026-09-03 09:35:00',
      open: 10.1,
      high: 10.2,
      low: 9.9,
      close: 10.05,
      volume: 100_000,
    },
    {
      tradeTime: '2026-09-03 09:40:00',
      open: 10.05,
      high: 10.2,
      low: 9.9,
      close: 10.1,
      volume: 100_000,
    },
    {
      tradeTime: '2026-09-03 15:00:00',
      open: 10.1,
      high: 10.4,
      low: 9.8,
      close: 10.2,
      volume: 100_000,
    },
  ]
}

function outcomeStore() {
  const values = []
  return {
    values,
    async listOutcomes(input) {
      return values.filter((item) => (
        item.tradeDate === input.tradeDate
        && item.mode === input.mode
        && item.slot === input.slot
      ))
    },
    async saveOutcome(value) {
      values.push(value)
      return value
    },
  }
}

test('离线结算只写成熟结果并保留未成熟路径供后续重算', async () => {
  const first = event({
    tradeDate: '2026-09-01',
    priceType: 'BREAKOUT_WATCH',
    primaryPrice: 10.8,
    stopPrice: 10.3,
    targetPrice: 11.8,
  })
  const second = event({
    tradeDate: '2026-09-02',
    priceType: 'PULLBACK_WATCH',
    primaryPrice: 10,
    stopPrice: 9.5,
    targetPrice: 10.8,
  })
  const store = outcomeStore()
  let fetchCount = 0
  const result = await settleOpportunityRadarOutcomes({
    ledgerStore: {
      async listBatches() {
        return [
          batch('2026-09-01', first),
          batch('2026-09-02', second),
        ]
      },
    },
    outcomeStore: store,
    fetchBars: async (_code, options) => {
      fetchCount += 1
      assert.equal(options.adjustment, 'raw')
      assert.equal(options.completedWindowOnly, false)
      return bars()
    },
    now: Date.parse('2026-09-03T09:10:00.000Z'),
  })

  assert.equal(
    result.schemaVersion,
    OPPORTUNITY_RADAR_SETTLEMENT_SCHEMA_VERSION,
  )
  assert.equal(fetchCount, 1)
  assert.equal(result.candidates, 2)
  assert.equal(result.matured, 1)
  assert.equal(result.pending, 1)
  assert.deepEqual(result.outcomes, {
    NOT_TRIGGERED: 1,
    OPEN_T1_LOCKED: 1,
  })
  assert.equal(store.values.length, 1)
  assert.equal(store.values[0].outcome, 'NOT_TRIGGERED')
  assert.equal(store.values[0].ruleVersion, 'CN_A_SHARE_2026_07_06')
})

test('重复运行跳过已经不可变落盘的成熟结果', async () => {
  const candidate = event({
    tradeDate: '2026-09-01',
    priceType: 'BREAKOUT_WATCH',
    primaryPrice: 10.8,
    stopPrice: 10.3,
    targetPrice: 11.8,
  })
  const store = outcomeStore()
  const options = {
    ledgerStore: {
      async listBatches() {
        return [batch('2026-09-01', candidate)]
      },
    },
    outcomeStore: store,
    fetchBars: async () => bars(),
    now: Date.parse('2026-09-03T09:10:00.000Z'),
  }

  await settleOpportunityRadarOutcomes(options)
  const replayed = await settleOpportunityRadarOutcomes(options)

  assert.equal(store.values.length, 1)
  assert.equal(replayed.existing, 1)
  assert.equal(replayed.evaluated, 0)
  assert.equal(replayed.matured, 0)
})
