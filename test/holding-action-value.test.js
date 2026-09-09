import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateHoldingActions,
} from '../shared/holdingActionValue.js'

function payload(overrides = {}) {
  return {
    todayQuote: { price: 10.8, high: 11 },
    holdCost: 10,
    holdingPeakPrice: 11,
    holdingStopPrice: 9.7,
    holdQty: 6,
    sellableTodayQty: 6,
    shortHorizonTactical: {
      alignmentScore: 74,
      stock: { relativeStrength: 72 },
      sector: { state: 'LEADING', stockRole: 'LEADER' },
      flow: { relation: 'ACCUMULATION' },
      technical: { bias: 'BULLISH' },
      opportunityCost: { edgeScore: 0 },
    },
    ...overrides,
  }
}

test('strengthening winner competes for add instead of fixed time exit', () => {
  const result = evaluateHoldingActions({
    payload: payload(),
    advice: { opQty: '加仓2手', targetPrice: 12 },
  })

  assert.equal(result.selected.action, 'ADD')
  assert.equal(result.selected.quantity, 2)
  assert.equal(result.state.strengthening, true)
  assert.equal(result.schemaVersion, 'holding-action-value.v2')
  assert.ok(result.economics.expectedNetR > 0)
  assert.ok(result.selected.valueR > result.alternatives[0].valueR)
})

test('distribution and sector retreat release risk before waiting', () => {
  const result = evaluateHoldingActions({
    payload: payload({
      todayQuote: { price: 9.9, high: 10.6 },
      shortHorizonTactical: {
        alignmentScore: 28,
        stock: { relativeStrength: 34 },
        sector: { state: 'WEAKENING', stockRole: 'LAGGARD' },
        flow: { relation: 'DISTRIBUTION' },
        technical: { bias: 'BEARISH' },
        opportunityCost: { edgeScore: 8 },
      },
    }),
    advice: { targetPrice: 11 },
  })

  assert.ok(['REDUCE', 'EXIT'].includes(result.selected.action))
  assert.ok(result.selected.quantity > 0)
  assert.equal(result.state.flowState, 'DISTRIBUTION')
  assert.ok(result.economics.tailPenaltyR > 0)
})

test('hard stop respects T+1 and reports locked hold state', () => {
  const result = evaluateHoldingActions({
    payload: payload({
      todayQuote: { price: 9.5, high: 10.1 },
      sellableTodayQty: 0,
    }),
    advice: {},
  })

  assert.equal(result.selected.action, 'HOLD_LOCKED')
  assert.equal(result.selected.quantity, 0)
  assert.equal(result.state.hardStop, true)
})

test('losing position can add only through a predeclared unchanged-risk tranche', () => {
  const strengtheningLoss = payload({
    todayQuote: { price: 9.9, high: 10.1 },
    holdingPeakPrice: 10.1,
    holdCost: 10,
  })
  const blocked = evaluateHoldingActions({
    payload: strengtheningLoss,
    advice: { opQty: '加仓1手' },
  })
  const planned = evaluateHoldingActions({
    payload: {
      ...strengtheningLoss,
      plannedTranche: {
        active: true,
        stopUnchanged: true,
        totalRiskIncrease: false,
      },
    },
    advice: { opQty: '加仓1手' },
  })

  assert.notEqual(blocked.selected.action, 'ADD')
  assert.equal(planned.selected.action, 'ADD')
})

test('五日主力流出与小单承接进入派发判断', () => {
  const result = evaluateHoldingActions({
    payload: payload({
      shortHorizonTactical: {
        alignmentScore: 52,
        stock: { relativeStrength: 48 },
        sector: { state: 'CONFIRMING', stockRole: 'FOLLOWER' },
        flow: {
          relation: 'BALANCED',
          mainNetYi: -0.7,
          retailNetYi: 0.5,
          main5dYi: -2.8,
          mainStreak: -3,
        },
        technical: { bias: 'MIXED' },
        opportunityCost: { edgeScore: 0 },
      },
    }),
    advice: { targetPrice: 12 },
  })

  assert.equal(result.state.flowState, 'DISTRIBUTION')
  assert.ok(['REDUCE', 'EXIT'].includes(result.selected.action))
})

test('更强候选以机会成本降低继续持有价值', () => {
  const base = evaluateHoldingActions({
    payload: payload(),
    advice: { targetPrice: 12 },
  })
  const withAlternative = evaluateHoldingActions({
    payload: payload({
      shortHorizonTactical: {
        ...payload().shortHorizonTactical,
        opportunityCost: {
          targetCode: '000001',
          targetName: '平安银行',
          edgeScore: 35,
        },
      },
    }),
    advice: { targetPrice: 12 },
  })

  const baseHold = [base.selected, ...base.alternatives]
    .find((item) => item.action === 'HOLD')
  const alternativeHold = [
    withAlternative.selected,
    ...withAlternative.alternatives,
  ].find((item) => item.action === 'HOLD')
  assert.ok(alternativeHold.valueR < baseHold.valueR)
  assert.equal(withAlternative.economics.opportunityCostR, 0.35)
})
