import {
  A_SHARE_STANDARD_FEE_POLICY,
  executionPrice,
  tradeFees,
} from './ashareStrategyExecution.js'
import { isExecutableOpportunityScore } from './opportunityScoreContract.js'

export const TARGET_POSITION_MODEL_VERSION = 'target-position.discrete-impact-v1'
const MAX_LOTS = 10000

const finite = (value) => value == null || value === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null
const money = (value) => Math.round(value * 100) / 100

export function allocationMarketFrom(candles = [], quote = {}) {
  const closes = candles.slice(-61).map((bar) => finite(bar.close))
  const returns = closes.slice(1).map((close, index) =>
    close > 0 && closes[index] > 0 ? Math.log(close / closes[index]) : null)
    .filter((value) => value != null)
  const amounts = candles.slice(-20).map((bar) => finite(bar.amount))
    .filter((value) => value > 0)
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
    : null
  return {
    dailyVolatility: variance == null ? null : Math.sqrt(variance),
    volatilityObservations: returns.length,
    dailyAmount: amounts.length >= 5
      ? amounts.reduce((a, b) => a + b, 0) / amounts.length
      : finite(quote.amount),
    amountSource: amounts.length >= 5 ? 'DAILY_MEAN' : 'QUOTE_SESSION',
  }
}

// This is a constrained optimization model, not another learned return head.
// All integer choices, including cash, compete under the same net-R forecast.
export function optimizeTargetPosition({
  entryPrice, stopPrice, targetPrice, score, maxLots,
  existingLots = 0, reservedBuyLots = 0, market = {},
  slippageBps = 5, modelPriceRiskPerShare,
  maxStopLossAmount = Infinity, maxStressLossAmount = Infinity,
  stressLossPerLot = 0, maxCashAmount = Infinity,
} = {}) {
  const price = finite(entryPrice)
  const stop = finite(stopPrice)
  const target = finite(targetPrice)
  const riskPerShare = finite(modelPriceRiskPerShare) ?? (price - stop)
  const cap = finite(maxLots)
  const sigma = finite(market.dailyVolatility)
  const amount = finite(market.dailyAmount)
  const expectedNetR = finite(score?.expectedNetR)
  const pFill = finite(score?.pFill)
  const held = Math.max(0, Math.trunc(finite(existingLots) || 0))
  const reserved = Math.max(0, finite(reservedBuyLots) || 0)
  const base = {
    schemaVersion: 'target-position.v1',
    modelVersion: TARGET_POSITION_MODEL_VERSION,
    source: 'CONSTRAINED_OPTIMIZATION',
    forecastModelVersion: score?.modelVersion || null,
    existingLots: held,
    reservedBuyLots: reserved,
    capacityLots: cap,
    recommendedLots: 0,
    targetLots: held + reserved,
    cashAlternativeAmount: 0,
    maxBuyPrice: price,
    assumptions: {
      impactModel: 'SQUARE_ROOT_PARTICIPATION',
      impactCoefficient: 1,
      impactCoefficientCalibrated: false,
      maxDailyParticipationPct: 1,
      dailyVolatility: sigma,
      dailyAmount: amount,
      forecastQuantityResponse: 'PROPORTIONAL_NET_R',
      feeSavingsCredited: false,
    },
  }
  if (!(price > stop && stop > 0 && target > price && riskPerShare > 0)
    || !Number.isInteger(cap) || cap < 0 || cap > MAX_LOTS
    || score?.serverVerified !== true || !isExecutableOpportunityScore(score)
    || expectedNetR == null || pFill == null || !(pFill >= 0 && pFill <= 1)
    || !(finite(slippageBps) >= 0)) {
    return { ...base, state: 'UNAVAILABLE', reason: '价格、模型或数量输入不完整' }
  }
  if (cap === 0 || expectedNetR <= 0 || pFill === 0) {
    return { ...base, state: 'NO_TRADE', reason: cap === 0
      ? '账户约束不允许新增一手' : '新增交易的费后平均价值不为正', evaluatedChoices: 1 }
  }
  if (!(sigma >= 0 && amount > 0) || !(market.volatilityObservations >= 20)) {
    return { ...base, state: 'UNAVAILABLE', reason: '缺少完整波动与成交额数据，无法核定目标仓位' }
  }
  const outcomes = []
  for (let lots = 1; lots <= cap; lots++) {
    const shares = lots * 100
    const notional = price * shares
    const participation = notional / amount
    // Existing net-R includes the fixed slippage assumption. Charge only
    // additional round-trip impact, and do not invent minimum-fee savings.
    const totalImpact = 2 * sigma * notional * Math.sqrt(participation)
    const additionalImpact = Math.max(0, totalImpact - 2 * notional * slippageBps / 10000)
    const initialPriceRisk = riskPerShare * shares
    const meanNetAmount = expectedNetR * initialPriceRisk - additionalImpact
    const entryGross = executionPrice(price, 'BUY', slippageBps) * shares
    const entryCash = entryGross + tradeFees('BUY', entryGross, A_SHARE_STANDARD_FEE_POLICY).total
    const requiredCash = entryCash + additionalImpact / 2
    const proceeds = (exit) => {
      const gross = executionPrice(exit, 'SELL', slippageBps) * shares
      return gross - tradeFees('SELL', gross, A_SHARE_STANDARD_FEE_POLICY).total
    }
    const stopLossAmount = entryCash - proceeds(stop) + additionalImpact
    const stressLossAmount = stressLossPerLot * lots + additionalImpact
    outcomes.push({
      lots,
      expectedNetAmount: money(meanNetAmount),
      opportunityNetAmount: money(pFill * meanNetAmount),
      initialPriceRisk: money(initialPriceRisk),
      additionalImpactAmount: money(additionalImpact),
      requiredCash: money(requiredCash),
      targetNetProfit: money(proceeds(target) - entryCash - additionalImpact),
      stopLossAmount: money(stopLossAmount),
      stressLossAmount: money(stressLossAmount),
      participationPct: participation * 100,
      feasible: money(stopLossAmount) <= maxStopLossAmount
        && money(stressLossAmount) <= maxStressLossAmount
        && money(requiredCash) <= maxCashAmount
        && participation <= 0.01,
      objective: pFill * meanNetAmount,
    })
  }
  // Compare unrounded values; tie goes to cash or the smaller position.
  let best = null
  for (const outcome of outcomes) {
    if (outcome.feasible && outcome.objective > (best?.objective ?? 0)) best = outcome
  }
  const { objective, ...selected } = best || {}
  return {
    ...base,
    state: best ? 'READY' : 'NO_TRADE',
    reason: best ? '在账户上限内比较现金与各档手数，选择估计新增净收益最高的方案'
      : '计入数量相关冲击后，新增交易不优于保留现金',
    recommendedLots: best?.lots || 0,
    targetLots: held + reserved + (best?.lots || 0),
    selected: best ? selected : null,
    evaluatedChoices: cap + 1,
    comparison: [...new Set([1, best?.lots, (best?.lots || 0) + 1, cap])]
      .filter((lots) => lots > 0 && lots <= cap)
      .map((lots) => {
        const { objective: _, ...option } = outcomes[lots - 1]
        return option
      }),
    boundary: '按现役路径预测与流动性冲击假设优化；不是独立训练的数量收益预测，也不保证成交或盈利。',
  }
}
