import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPPORTUNITY_RADAR_BASELINE_SCHEMA_VERSION,
  buildOpportunityRadarBaseline,
} from '../shared/opportunityRadarBaseline.js'

function outcome({
  id,
  formulaId = 'FORMULA_A',
  result,
  fillStatus,
  netR = null,
  netPnl = null,
  netReturnPct = null,
  mfePct = null,
  maePct = null,
  context = {},
}) {
  return {
    decisionId: id,
    formulaId,
    maturity: 'MATURED',
    outcome: result,
    fillStatus,
    metrics: netR == null
      ? null
      : {
          netR,
          netPnl,
          netReturnPct,
          mfePct,
          maePct,
        },
    context: {
      marketState: 'RISK_ALLOWED',
      sectorPhase: 'ACCUMULATION',
      timeBucket: 'INTRADAY_OPEN',
      liquidityBucket: 'HIGH',
      displayed: true,
      ...context,
    },
  }
}

test('基线严格区分触发、成交和成交后盈亏', () => {
  const result = buildOpportunityRadarBaseline([
    outcome({
      id: '1',
      result: 'NOT_TRIGGERED',
      fillStatus: 'NOT_TRIGGERED',
    }),
    outcome({
      id: '2',
      result: 'LIMIT_UP_UNFILLED',
      fillStatus: 'TRIGGERED_UNFILLED',
    }),
    outcome({
      id: '3',
      result: 'TAKE_PROFIT',
      fillStatus: 'FILLED',
      netR: 1.5,
      netPnl: 150,
      netReturnPct: 1.5,
      mfePct: 2,
      maePct: -0.5,
    }),
    outcome({
      id: '4',
      result: 'STOP_LOSS',
      fillStatus: 'FILLED',
      netR: -1.2,
      netPnl: -120,
      netReturnPct: -1.2,
      mfePct: 0.4,
      maePct: -2,
      context: {
        marketState: 'RISK_BLOCKED',
        sectorPhase: 'DISTRIBUTION',
        timeBucket: 'INTRADAY_AFTERNOON',
        liquidityBucket: 'LIMITED',
        displayed: false,
      },
    }),
    outcome({
      id: '5',
      formulaId: 'FORMULA_B',
      result: 'TIME_EXIT',
      fillStatus: 'FILLED',
      netR: 0.2,
      netPnl: 20,
      netReturnPct: 0.2,
      mfePct: 1,
      maePct: -0.8,
      context: {
        marketState: 'RISK_BLOCKED',
        sectorPhase: 'UNKNOWN',
        timeBucket: 'CLOSE_NEXT_SESSION',
        liquidityBucket: 'GOOD',
        displayed: false,
      },
    }),
  ], {
    generatedAt: 1_788_406_400_000,
    from: '2026-09-01',
    to: '2026-09-30',
  })

  assert.equal(
    result.schemaVersion,
    OPPORTUNITY_RADAR_BASELINE_SCHEMA_VERSION,
  )
  assert.equal(result.overall.samples, 5)
  assert.equal(result.overall.triggered, 4)
  assert.equal(result.overall.filled, 3)
  assert.equal(result.overall.completedTrades, 3)
  assert.equal(result.overall.triggerRatePct, 80)
  assert.equal(result.overall.fillRateGivenTriggerPct, 75)
  assert.equal(result.overall.winRatePct, 66.67)
  assert.equal(result.overall.expectedNetRGivenFill, 0.167)
  assert.equal(result.overall.expectedNetRPerCandidate, 0.1)
  assert.equal(result.overall.profitFactorR, 1.42)
  assert.equal(result.overall.expectedShortfall10R, -1.2)
  assert.equal(result.overall.avgMfePct, 1.133)
  assert.equal(result.overall.avgMaePct, -1.1)
  assert.equal(result.overall.outcomes.NOT_TRIGGERED, 1)
  assert.equal(result.overall.outcomes.LIMIT_UP_UNFILLED, 1)
})

test('基线按公式、市场、板块、时段、流动性和展示状态分桶', () => {
  const values = [
    outcome({
      id: '1',
      result: 'TAKE_PROFIT',
      fillStatus: 'FILLED',
      netR: 1,
      netPnl: 100,
      netReturnPct: 1,
      mfePct: 1.5,
      maePct: -0.4,
    }),
    outcome({
      id: '2',
      formulaId: 'FORMULA_B',
      result: 'STOP_LOSS',
      fillStatus: 'FILLED',
      netR: -1,
      netPnl: -100,
      netReturnPct: -1,
      mfePct: 0.2,
      maePct: -1.5,
      context: {
        marketState: 'RISK_BLOCKED',
        sectorPhase: 'DISTRIBUTION',
        timeBucket: 'CLOSE_NEXT_SESSION',
        liquidityBucket: 'LIMITED',
        displayed: false,
      },
    }),
  ]
  const result = buildOpportunityRadarBaseline(values)

  assert.deepEqual(
    Object.keys(result.groups),
    [
      'formula',
      'marketState',
      'sectorPhase',
      'timeBucket',
      'liquidity',
      'displayed',
    ],
  )
  assert.deepEqual(
    result.groups.formula.map((group) => group.key),
    ['FORMULA_A', 'FORMULA_B'],
  )
  assert.deepEqual(
    result.groups.marketState.map((group) => group.key),
    ['RISK_ALLOWED', 'RISK_BLOCKED'],
  )
  assert.deepEqual(
    result.groups.displayed.map((group) => group.key),
    ['DISPLAYED', 'NOT_DISPLAYED'],
  )
})

test('没有完整成交时不输出虚假胜率和净期望', () => {
  const result = buildOpportunityRadarBaseline([
    outcome({
      id: '1',
      result: 'NOT_TRIGGERED',
      fillStatus: 'NOT_TRIGGERED',
    }),
  ])

  assert.equal(result.overall.completedTrades, 0)
  assert.equal(result.overall.winRatePct, null)
  assert.equal(result.overall.expectedNetRGivenFill, null)
  assert.equal(result.overall.profitFactorR, null)
  assert.equal(result.overall.sampleSufficient, false)
})
