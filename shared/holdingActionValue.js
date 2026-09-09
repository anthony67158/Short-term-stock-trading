export const HOLDING_ACTION_VALUE_VERSION = 'holding-action-value.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value))
}

function rounded(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function lots(value) {
  const match = String(value ?? '').match(/\d+(?:\.\d+)?/)
  const number = match ? Number(match[0]) : finite(value)
  return number > 0 ? Math.trunc(number) : 0
}

function actionValue(action, value, reasons) {
  return {
    action,
    value: rounded(value, 2),
    reasons: reasons.filter(Boolean).slice(0, 4),
  }
}

export function evaluateHoldingActions({
  payload = {},
  advice = {},
} = {}) {
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
  const flowRelation = String(tactical.flow?.relation || 'UNKNOWN')
  const technicalBias = String(tactical.technical?.bias || 'UNKNOWN')
  const opportunityEdge = finite(tactical.opportunityCost?.edgeScore) ?? 0
  const hardStop = price > 0 && stop > 0 && price <= stop
  const distribution = flowRelation === 'DISTRIBUTION'
  const sectorWeak = sectorState === 'WEAKENING'
    || tactical.sector?.stockRole === 'LAGGARD'
  const strengthening = (
    relativeStrength >= 65
    && ['LEADING', 'CONFIRMING'].includes(sectorState)
    && ['ACCUMULATION', 'BALANCED'].includes(flowRelation)
    && technicalBias !== 'BEARISH'
  )
  const weakening = (
    relativeStrength < 45
    || sectorWeak
    || distribution
    || technicalBias === 'BEARISH'
  )
  const continuation = clamp(
    alignment * 0.35
    + relativeStrength * 0.3
    + (sectorWeak ? 15 : sectorState === 'LEADING' ? 90 : 55) * 0.15
    + (distribution ? 12 : flowRelation === 'ACCUMULATION' ? 88 : 50) * 0.2,
  )
  const riskPressure = clamp(
    peakDrawdownPct * 11
    + Math.max(0, -profitPct) * 8
    + (weakening ? 24 : 0)
    + Math.max(0, opportunityEdge) * 2,
  )
  const hold = actionValue(
    'HOLD',
    continuation - riskPressure * 0.35,
    [
      `延续价值${rounded(continuation, 1)}分`,
      strengthening ? '板块、相对强度与资金仍在强化' : '',
      weakening ? '结构出现弱化，继续持有价值下降' : '',
    ],
  )
  const add = actionValue(
    'ADD',
    strengthening
      ? continuation + Math.max(0, profitPct) * 2 - peakDrawdownPct * 5
      : 0,
    [
      strengthening ? '原逻辑强化且风险边界未下移' : '未形成可加仓的强化结构',
      profitPct >= 0 ? '现有仓位未处于被动摊平状态' : '',
    ],
  )
  const reduce = actionValue(
    'REDUCE',
    riskPressure
      + (profitPct >= 2 ? peakDrawdownPct * 8 : 0)
      + (targetReached ? 55 : 0)
      + (opportunityEdge >= 5 ? opportunityEdge * 3 : 0),
    [
      targetReached ? `现价${price}已达到计划目标${target}` : '',
      distribution ? '主力流出与小单承接形成派发风险' : '',
      peakDrawdownPct > 0 ? `从持仓高点回撤${rounded(peakDrawdownPct)}%` : '',
      opportunityEdge >= 5
        ? `替代机会优势高${rounded(opportunityEdge, 1)}分`
        : '',
    ],
  )
  const exit = actionValue(
    'EXIT',
    hardStop
      ? 200
      : riskPressure + (sectorWeak && distribution ? 45 : 0),
    [
      hardStop ? `现价${price}已触及止损${stop}` : '',
      sectorWeak && distribution ? '板块退潮且资金派发同时成立' : '',
    ],
  )
  const values = [hold, add, reduce, exit]
  let selected = values.slice().sort((left, right) =>
    right.value - left.value
  )[0]
  if (hardStop) selected = exit
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
    state: {
      strengthening,
      weakening,
      hardStop,
      profitPct: rounded(profitPct),
      peakDrawdownPct: rounded(peakDrawdownPct),
      continuationScore: rounded(continuation, 1),
      riskPressure: rounded(riskPressure, 1),
      opportunityEdge: rounded(opportunityEdge, 1),
      total,
      sellable,
    },
  }
}
