import test from 'node:test'
import assert from 'node:assert/strict'
import { optimizeTargetPosition, allocationMarketFrom } from '../shared/targetPositionModel.js'

const input = {
  entryPrice: 10, stopPrice: 9.5, targetPrice: 11, maxLots: 40,
  score: {
    state: 'READY', usagePolicy: 'DIRECT', serverVerified: true,
    expectedNetR: 0.1, pFill: 0.8, pWinGivenFill: 0.6,
    netRLowerBound: -1, expectedShortfall10: -1.5, modelVersion: 'fixture',
  },
  market: { dailyVolatility: 0.03, volatilityObservations: 30, dailyAmount: 1000000 },
}

test('integer optimizer compares cash and all feasible sizes, not just capacity', () => {
  const result = optimizeTargetPosition(input)
  assert.equal(result.state, 'READY')
  assert.ok(result.recommendedLots > 0 && result.recommendedLots < input.maxLots)
  assert.equal(result.evaluatedChoices, input.maxLots + 1)
  const best = result.comparison.find((x) => x.lots === result.recommendedLots)
  for (const item of result.comparison.filter((x) => x.feasible)) {
    assert.ok(best.opportunityNetAmount >= item.opportunityNetAmount)
  }
})

test('negative forecasts and excessive impact leave cash untouched', () => {
  assert.equal(optimizeTargetPosition({
    ...input, score: { ...input.score, expectedNetR: -0.1 },
  }).recommendedLots, 0)
  const result = optimizeTargetPosition({
    ...input, market: { ...input.market, dailyAmount: 100000 },
  })
  assert.equal(result.state, 'NO_TRADE')
  assert.equal(result.recommendedLots, 0)
})

test('target distinguishes existing holdings, reserved buys and incremental amount', () => {
  const result = optimizeTargetPosition({ ...input, existingLots: 2, reservedBuyLots: 3 })
  assert.equal(result.targetLots, 5 + result.recommendedLots)
  assert.equal(result.selected.initialPriceRisk, 50 * result.recommendedLots)
  assert.equal(result.maxBuyPrice, 10)
})

test('loss and liquidity constraints are applied after impact', () => {
  const result = optimizeTargetPosition({ ...input, maxStopLossAmount: 120 })
  assert.ok(result.selected.stopLossAmount <= 120)
  assert.ok(result.recommendedLots <= 2)
  assert.equal(optimizeTargetPosition({ ...input, maxStressLossAmount: 1, stressLossPerLot: 30 }).state, 'NO_TRADE')
})

test('missing, unverified or malformed inputs never produce an executable size', () => {
  for (const override of [
    { market: {} }, { maxLots: 10001 }, { entryPrice: null },
    { score: { ...input.score, serverVerified: false } },
    { score: { ...input.score, expectedNetR: NaN } },
    { score: { ...input.score, pFill: null } },
  ]) {
    assert.equal(optimizeTargetPosition({ ...input, ...override }).state, 'UNAVAILABLE')
  }
})

test('price-risk denominator is independent of fees and risk budget', () => {
  const result = optimizeTargetPosition({ ...input, modelPriceRiskPerShare: 0.4999 })
  assert.equal(result.selected.initialPriceRisk,
    Math.round(0.4999 * 100 * result.recommendedLots * 100) / 100)
  assert.equal(result.assumptions.impactCoefficientCalibrated, false)
})

test('market estimation requires observations and leaves missing amounts missing', () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({ close: 10 + i / 100, amount: 10000000 }))
  const result = allocationMarketFrom(candles)
  assert.equal(result.volatilityObservations, 29)
  assert.equal(result.dailyAmount, 10000000)
  assert.ok(result.dailyVolatility > 0)
  assert.equal(allocationMarketFrom(candles.map(({ close }) => ({ close }))).dailyAmount, null)
})

test('cash is compared in cents and includes additional entry impact', () => {
  const result = optimizeTargetPosition({
    ...input, maxLots: 1, maxCashAmount: 1005.51,
    market: { ...input.market, dailyVolatility: 0 },
  })
  assert.equal(result.recommendedLots, 1)
  assert.equal(result.selected.requiredCash, 1005.51)
  assert.equal(optimizeTargetPosition({
    ...input, maxLots: 1, maxCashAmount: 1005.50,
    market: { ...input.market, dailyVolatility: 0 },
  }).recommendedLots, 0)
})
