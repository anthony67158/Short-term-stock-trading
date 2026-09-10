import { isExecutableOpportunityScore } from './opportunityScoreContract.js'

export const HOLDING_ACTION_VALUE_VERSION = 'holding-action-value.v2'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value))
}

function rounded(value, digits = 3) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function lots(value) {
  const match = String(value ?? '').match(/\d+(?:\.\d+)?/)
  const number = match ? Number(match[0]) : finite(value)
  return number > 0 ? Math.trunc(number) : 0
}

function normalizedProbability(value) {
  const number = finite(value)
  if (number == null) return null
  const normalized = number > 1 ? number / 100 : number
  return normalized >= 0 && normalized <= 1 ? normalized : null
}

function actionValue(action, valueR, reasons, components = {}) {
  return {
    action,
    value: rounded(valueR, 3),
    valueR: rounded(valueR, 3),
    reasons: reasons.filter(Boolean).slice(0, 4),
    components: Object.fromEntries(
      Object.entries(components)
        .map(([key, value]) => [key, rounded(value, 4)])
        .filter(([, value]) => value != null),
    ),
  }
}

function firstProbability(tactical = {}) {
  const candidates = [
    tactical.quant?.currentTradingDay?.upProb,
    tactical.quant?.nextTradeDay?.upProb,
    tactical.quant?.upProb,
  ]
  for (const candidate of candidates) {
    const probability = normalizedProbability(candidate)
    if (probability != null) return probability
  }
  return null
}

function priceEconomics({
  price,
  stop,
  target,
  continuationScore,
  tactical,
}) {
  const risk = price > 0 && stop > 0 && stop < price
    ? price - stop
    : null
  const reward = price > 0 && target > price
    ? target - price
    : null
  const rewardR = risk > 0 && reward > 0 ? reward / risk : null
  const modelProbability = firstProbability(tactical)
  const fallbackProbability = clamp(
    continuationScore / 100,
    0.18,
    0.82,
  )
  const pWin = modelProbability ?? fallbackProbability
  const expectedNetR = rewardR == null
    ? (pWin - 0.5) * 2
    : pWin * rewardR - (1 - pWin) - 0.06
  return {
    pWin,
    rewardR,
    expectedNetR,
    source: modelProbability == null
      ? 'TACTICAL_ESTIMATE'
      : 'QUANT_ESTIMATE',
  }
}

function flowState(tactical = {}) {
  const relation = String(tactical.flow?.relation || 'UNKNOWN')
  const mainNow = finite(tactical.flow?.mainNetYi)
  const retailNow = finite(tactical.flow?.retailNetYi)
  const main5d = finite(tactical.flow?.main5dYi)
  const mainStreak = finite(tactical.flow?.mainStreak)
  const distribution = relation === 'DISTRIBUTION'
    || (
      mainNow != null
      && retailNow != null
      && mainNow < 0
      && retailNow > 0
      && (main5d == null || main5d <= 0)
    )
  const accumulation = !distribution && (
    relation === 'ACCUMULATION'
    || (
      mainNow != null
      && mainNow > 0
      && main5d != null
      && main5d > 0
      && mainStreak != null
      && mainStreak > 0
    )
  )
  return {
    relation,
    distribution,
    accumulation,
    mainNow,
    retailNow,
    main5d,
    mainStreak,
  }
}

function marketFactor(payload = {}, tactical = {}) {
  const explicit = finite(
    payload.marketOpportunityContext?.opportunityFactor,
  )
  if (explicit != null) return clamp(explicit, 0.35, 1.25)
  if (tactical.market?.hardRiskOff === true) return 0.5
  if (tactical.market?.riskTone === 'RISK_OFF') return 0.72
  if (tactical.market?.riskTone === 'RISK_ON') return 1.12
  return 1
}

function opportunityCostR(tactical = {}) {
  const direct = finite(
    tactical.opportunityCost?.expectedNetR
    ?? tactical.opportunityCost?.netIncrementR,
  )
  if (direct != null) return Math.max(0, direct)
  const edgeScore = finite(tactical.opportunityCost?.edgeScore)
  return edgeScore == null ? 0 : clamp(edgeScore / 100, 0, 0.6)
}

export function evaluateHoldingActions({
  payload = {},
  advice = {},
} = {}) {
  if (payload.decisionEngine === 'V3') {
    const score = payload.opportunityScore
    const total = Math.max(0, Math.trunc(Number(payload.holdQty) || 0))
    const sellable = Math.max(0, Math.min(total, Math.trunc(Number(payload.sellableTodayQty) || 0)))
    const ready = isExecutableOpportunityScore(score) && score.serverVerified === true
      && finite(score.expectedNetR) != null
    const price = finite(payload.todayQuote?.price)
    const stop = finite(payload.holdingStopPrice)
    const hardStop = price > 0 && stop > 0 && price <= stop
      && payload.todayQuote?.live === true
    const reduceRisk = hardStop || (ready && score.expectedNetR <= 0)
    const selected = reduceRisk
      ? { action: sellable ? sellable === total ? 'EXIT' : 'REDUCE' : 'HOLD_LOCKED', quantity: sellable }
      : { action: 'HOLD', quantity: 0 }
    return {
      schemaVersion: HOLDING_ACTION_VALUE_VERSION,
      selected,
      alternatives: [],
      economics: {
        source: ready ? 'V3_PATH_MODEL' : 'UNAVAILABLE',
        expectedNetR: ready ? score.expectedNetR : null,
        pWin: ready ? score.pWinGivenFill : null,
      },
      state: { hardStop, total, sellable, modelReady: ready },
    }
  }
  const tactical = payload.shortHorizonTactical || {}
  const price = finite(
    payload.todayQuote?.price
    ?? payload.intraday?.now
    ?? payload.currentPrice,
  )
  const cost = finite(payload.holdCost)
  const stop = finite(
    payload.holdingStopPrice
    ?? advice.stopPrice
    ?? payload.previousAdvice?.stopPrice,
  )
  const target = finite(
    advice.targetPrice
    ?? payload.previousAdvice?.targetPrice,
  )
  const peak = finite(
    payload.holdingPeakPrice
    ?? payload.todayQuote?.high
    ?? payload.intraday?.dayHigh,
  )
  const total = Math.max(0, Math.trunc(finite(payload.holdQty) || 0))
  const sellable = Math.max(
    0,
    Math.min(
      total,
      Math.trunc(finite(payload.sellableTodayQty) ?? total),
    ),
  )
  const profitPct = price > 0 && cost > 0
    ? (price / cost - 1) * 100
    : 0
  const targetReached = price > 0 && target > 0 && price >= target
  const peakDrawdownPct = peak > 0 && price > 0 && peak > price
    ? (peak - price) / peak * 100
    : 0
  const relativeStrength = finite(tactical.stock?.relativeStrength) ?? 50
  const alignment = finite(tactical.alignmentScore) ?? 50
  const sectorState = String(tactical.sector?.state || 'UNKNOWN')
  const technicalBias = String(tactical.technical?.bias || 'UNKNOWN')
  const flows = flowState(tactical)
  const alternativeR = opportunityCostR(tactical)
  const opportunityEdgeScore = finite(
    tactical.opportunityCost?.edgeScore,
  )
  const environmentFactor = marketFactor(payload, tactical)
  const hardStop = price > 0 && stop > 0 && price <= stop
  const sectorWeak = sectorState === 'WEAKENING'
    || tactical.sector?.stockRole === 'LAGGARD'
  const strengthening = (
    relativeStrength >= 65
    && ['LEADING', 'CONFIRMING'].includes(sectorState)
    && (flows.accumulation || flows.relation === 'BALANCED')
    && technicalBias !== 'BEARISH'
  )
  const weakening = (
    relativeStrength < 45
    || sectorWeak
    || flows.distribution
    || technicalBias === 'BEARISH'
  )
  const continuation = clamp(
    alignment * 0.32
    + relativeStrength * 0.28
    + (sectorWeak ? 15 : sectorState === 'LEADING' ? 90 : 55) * 0.16
    + (
      flows.distribution
        ? 10
        : flows.accumulation ? 90 : 50
    ) * 0.24,
  )
  const economics = priceEconomics({
    price,
    stop,
    target,
    continuationScore: continuation,
    tactical,
  })
  const drawdownPenaltyR = clamp(peakDrawdownPct / 12, 0, 0.75)
  const structuralPenaltyR = (
    (sectorWeak ? 0.22 : 0)
    + (flows.distribution ? 0.38 : 0)
    + (technicalBias === 'BEARISH' ? 0.2 : 0)
  )
  const tailPenaltyR = drawdownPenaltyR + structuralPenaltyR
  const holdValueR = economics.expectedNetR * environmentFactor
    - tailPenaltyR
    - alternativeR
  const addEligible = tactical.holding?.addEligible !== false
  const addValueR = strengthening && addEligible
    ? holdValueR
      + 0.18
      + Math.min(0.18, Math.max(0, profitPct) / 100)
    : -1
  const reduceValueR = (
    -holdValueR * 0.45
    + tailPenaltyR * 0.7
    + alternativeR * 0.55
    + (targetReached ? 0.45 : 0)
    - 0.04
  )
  const exitValueR = (
    -holdValueR
    + tailPenaltyR
    + alternativeR
    + (sectorWeak && flows.distribution ? 0.4 : 0)
    - 0.07
  )
  const commonComponents = {
    expectedNetR: economics.expectedNetR,
    marketFactor: environmentFactor,
    tailPenaltyR,
    opportunityCostR: alternativeR,
  }
  const hold = actionValue(
    'HOLD',
    holdValueR,
    [
      `继续持有费后价值${rounded(holdValueR, 2)}R`,
      strengthening ? '板块、相对强度与资金仍在强化' : '',
      weakening ? '结构出现弱化，继续持有价值下降' : '',
    ],
    commonComponents,
  )
  const add = actionValue(
    'ADD',
    addValueR,
    [
      strengthening && addEligible
        ? '原逻辑强化且加仓风险边界未下移'
        : '未形成可加仓的强化结构',
      profitPct >= 0 ? '现有仓位未处于被动摊平状态' : '',
    ],
    {
      ...commonComponents,
      strengtheningPremiumR:
        strengthening && addEligible ? addValueR - holdValueR : 0,
    },
  )
  const reduce = actionValue(
    'REDUCE',
    reduceValueR,
    [
      targetReached ? `现价${price}已达到计划目标${target}` : '',
      flows.distribution ? '主力流出、小单承接且价格结构转弱' : '',
      peakDrawdownPct > 0
        ? `从持仓高点回撤${rounded(peakDrawdownPct, 2)}%`
        : '',
      alternativeR > 0
        ? opportunityEdgeScore != null
          ? `替代机会优势高${rounded(opportunityEdgeScore, 1)}分（约${rounded(alternativeR, 2)}R机会成本）`
          : `替代机会带来${rounded(alternativeR, 2)}R机会成本`
        : '',
    ],
    commonComponents,
  )
  const exit = actionValue(
    'EXIT',
    hardStop ? 10 : exitValueR,
    [
      hardStop ? `现价${price}已触及止损${stop}` : '',
      sectorWeak && flows.distribution
        ? '板块退潮且资金派发同时成立'
        : '',
      alternativeR > 0
        ? `退出后可释放风险给更高价值机会`
        : '',
    ],
    commonComponents,
  )
  const values = [hold, add, reduce, exit]
  let selected = values.slice().sort((left, right) =>
    right.value - left.value
  )[0]
  if (hardStop || (sectorWeak && flows.distribution)) selected = exit
  else if (selected.action === 'EXIT') selected = reduce
  if (selected.action === 'EXIT' && sellable < total) {
    selected = {
      ...selected,
      action: sellable > 0 ? 'REDUCE' : 'HOLD_LOCKED',
      reasons: [
        ...selected.reasons,
        sellable > 0
          ? `今日仅可卖${sellable}手，先释放可卖风险`
          : '今日买入仓位受T+1锁定',
      ].slice(0, 4),
    }
  }
  if (selected.action === 'ADD' && profitPct < 0) {
    const plannedTranche = payload.plannedTranche?.active === true
      && payload.plannedTranche?.stopUnchanged === true
      && payload.plannedTranche?.totalRiskIncrease === false
    if (!plannedTranche) selected = hold
  }
  const quantity = selected.action === 'EXIT'
    ? sellable
    : selected.action === 'REDUCE'
      ? Math.max(1, Math.min(sellable, Math.ceil(total / 2)))
      : selected.action === 'ADD'
        ? Math.max(1, lots(advice.opQty) || 1)
        : 0
  return {
    schemaVersion: HOLDING_ACTION_VALUE_VERSION,
    selected: {
      ...selected,
      quantity,
    },
    alternatives: values
      .filter((item) => item.action !== selected.action)
      .sort((left, right) => right.value - left.value),
    economics: {
      source: economics.source,
      pWin: rounded(economics.pWin, 4),
      rewardR: rounded(economics.rewardR, 3),
      expectedNetR: rounded(economics.expectedNetR, 3),
      marketFactor: rounded(environmentFactor, 3),
      tailPenaltyR: rounded(tailPenaltyR, 3),
      opportunityCostR: rounded(alternativeR, 3),
    },
    state: {
      strengthening,
      weakening,
      hardStop,
      flowState: flows.distribution
        ? 'DISTRIBUTION'
        : flows.accumulation ? 'ACCUMULATION' : flows.relation,
      profitPct: rounded(profitPct, 2),
      peakDrawdownPct: rounded(peakDrawdownPct, 2),
      continuationScore: rounded(continuation, 1),
      opportunityCostR: rounded(alternativeR, 3),
      total,
      sellable,
    },
  }
}
