import { tradeFees } from './ashareStrategyExecution.js'

export const POSITION_OPTIMIZATION_VERSION =
  'position-optimization.v2'

export const POSITION_SELL_FRACTIONS = Object.freeze([
  0,
  0.25,
  0.5,
  0.75,
  1,
])

export const MIN_POSITION_ACTION_IMPROVEMENT_R = 0.05

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value))
}

function rounded(value, digits = 6) {
  return +Number(value).toFixed(digits)
}

function integer(value) {
  return Math.max(0, Math.trunc(finite(value) || 0))
}

function notReady(fields) {
  return {
    schemaVersion: POSITION_OPTIMIZATION_VERSION,
    state: 'NOT_READY',
    reason: `缺少有效输入: ${fields.join(', ')}`,
    selectedAction: 'HOLD',
    selectedSellLots: 0,
    selectedRetainedLots: 0,
    candidates: [],
    actions: {
      HOLD: null,
      REDUCE: null,
      EXIT: null,
    },
  }
}

function candidateLots(totalLots, sellableLots) {
  return [...new Set(
    POSITION_SELL_FRACTIONS.map((fraction) => Math.min(
      sellableLots,
      Math.round(totalLots * fraction),
    )),
  )].sort((left, right) => left - right)
}

function actionOf(sellLots, totalLots) {
  if (sellLots <= 0) return 'HOLD'
  if (sellLots >= totalLots) return 'EXIT'
  return 'REDUCE'
}

function bestOf(candidates) {
  return [...candidates].sort((left, right) => (
    right.actionUtilityR - left.actionUtilityR
    || left.sellLots - right.sellLots
  ))[0] || null
}

function bestAction(candidates, action) {
  return bestOf(candidates.filter(
    (candidate) => candidate.action === action,
  ))
}

export function optimizePositionActions({
  expectedHoldR,
  lowerBoundR,
  price,
  hardStopPrice,
  totalLots,
  sellableLots,
  stockWeightPct,
  maxStockWeightPct,
  slippageBps = 5,
} = {}) {
  const expected = finite(expectedHoldR)
  const lower = finite(lowerBoundR)
  const currentPrice = finite(price)
  const stopPrice = finite(hardStopPrice)
  const total = integer(totalLots)
  const sellable = Math.min(total, integer(sellableLots))
  const weight = finite(stockWeightPct)
  const maxWeight = finite(maxStockWeightPct)
  const slippage = finite(slippageBps)
  const invalid = [
    expected == null ? 'expectedHoldR' : '',
    lower == null ? 'lowerBoundR' : '',
    !(currentPrice > 0) ? 'price' : '',
    !(stopPrice > 0 && stopPrice < currentPrice)
      ? 'hardStopPrice'
      : '',
    !(total > 0) ? 'totalLots' : '',
    weight == null || weight < 0 ? 'stockWeightPct' : '',
    !(maxWeight > 0) ? 'maxStockWeightPct' : '',
    !(slippage >= 0) ? 'slippageBps' : '',
  ].filter(Boolean)
  if (invalid.length) return notReady(invalid)

  const riskAmount =
    (currentPrice - stopPrice) * total * 100
  const downsideR = Math.max(0, -lower)
  const concentration = clamp(weight / maxWeight, 0, 1)
  const riskAversion = 0.35 + 0.4 * concentration
  const uncertaintyR = Math.max(0, expected - lower)
  const switchPenaltyRateR = clamp(
    0.05 * uncertaintyR,
    0.02,
    0.1,
  )
  const candidates = candidateLots(total, sellable).map(
    (soldLots) => {
      const retainedLots = total - soldLots
      const soldFraction = soldLots / total
      const retainedFraction = retainedLots / total
      const grossAmount = currentPrice * soldLots * 100
      const feeAmount = soldLots > 0
        ? tradeFees('SELL', grossAmount).total
        : 0
      const slippageAmount =
        grossAmount * slippage / 10000
      const sellCostR =
        (feeAmount + slippageAmount) / riskAmount
      const remainingExpectedR =
        retainedFraction * expected
      const remainingTailPenaltyR =
        riskAversion
        * retainedFraction
        * retainedFraction
        * downsideR
      const switchPenaltyR =
        soldFraction * switchPenaltyRateR
      return {
        action: actionOf(soldLots, total),
        sellLots: soldLots,
        retainedLots,
        soldFraction: rounded(soldFraction),
        retainedFraction: rounded(retainedFraction),
        remainingExpectedR: rounded(remainingExpectedR),
        remainingTailPenaltyR:
          rounded(remainingTailPenaltyR),
        feeAmount: rounded(feeAmount, 2),
        slippageAmount: rounded(slippageAmount, 2),
        sellCostR: rounded(sellCostR),
        switchPenaltyR: rounded(switchPenaltyR),
        actionUtilityR: rounded(
          remainingExpectedR
          - remainingTailPenaltyR
          - sellCostR
          - switchPenaltyR,
        ),
        feasible: soldLots <= sellable,
      }
    },
  )
  const hold = bestAction(candidates, 'HOLD')
  const rawBest = bestOf(candidates)
  const selected = (
    rawBest.action !== 'HOLD'
    && rawBest.actionUtilityR
      < hold.actionUtilityR
        + MIN_POSITION_ACTION_IMPROVEMENT_R
  ) ? hold : rawBest
  return {
    schemaVersion: POSITION_OPTIMIZATION_VERSION,
    state: 'READY',
    source: 'DISCRETE_POSITION_OPTIMIZER',
    expectedHoldR: rounded(expected),
    lowerBoundR: rounded(lower),
    downsideR: rounded(downsideR),
    concentration: rounded(concentration),
    riskAversion: rounded(riskAversion),
    riskAmount: rounded(riskAmount, 2),
    switchPenaltyRateR: rounded(switchPenaltyRateR),
    minimumImprovementR:
      MIN_POSITION_ACTION_IMPROVEMENT_R,
    selectedAction: selected.action,
    selectedSellLots: selected.sellLots,
    selectedRetainedLots: selected.retainedLots,
    selectedUtilityR: selected.actionUtilityR,
    holdUtilityR: hold.actionUtilityR,
    improvementOverHoldR: rounded(
      selected.actionUtilityR - hold.actionUtilityR,
    ),
    candidates,
    actions: {
      HOLD: hold,
      REDUCE: bestAction(candidates, 'REDUCE'),
      EXIT: bestAction(candidates, 'EXIT'),
    },
  }
}
