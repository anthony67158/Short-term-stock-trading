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
