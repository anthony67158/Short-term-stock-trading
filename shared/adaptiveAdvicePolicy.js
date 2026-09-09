export const ADAPTIVE_ADVICE_POLICY_VERSION =
  'adaptive-advice-policy.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function lots(value) {
  const match = String(value ?? '').match(/\d+(?:\.\d+)?/)
  const number = match ? Number(match[0]) : finite(value)
  return number > 0 ? Math.trunc(number) : 0
}

function priceText(value) {
  const number = finite(value)
  return number > 0 ? number.toFixed(2) : '--'
}

function appendAdjustment(result, message) {
  result.serverAdjust = result.serverAdjust
    ? `${result.serverAdjust}；${message}`
    : message
}

export function applyAdaptiveAdvicePolicy({
  mode,
  result: input,
  payload = {},
} = {}) {
  const result = input && typeof input === 'object' ? { ...input } : {}
  const decision = payload.adaptiveAction
  result.adaptiveAction = decision || null
  result.marketOpportunityContext =
    payload.marketOpportunityContext || null
  if (
    mode !== 'buy_advice'
    || payload.reviewEvent
    || !decision?.selected
  ) return result

  const selected = decision.selected
  const adaptive = selected.adaptive || {}
  const entry = finite(selected.entryPlan?.price)
  const stop = finite(selected.exitPlan?.hardStopPrice)
  const target = finite(selected.exitPlan?.takeProfitPrice)
  const route = String(selected.route || '')
  const live = payload.todayQuote?.live === true
  const executable = (
    live
    && route === 'IMMEDIATE'
    && ['ATTACK', 'PROBE'].includes(adaptive.tier)
    && entry > 0
    && stop > 0
    && target > entry
  )

  result.buyPrice = executable ? entry : null
  result.stopPrice = stop
  result.targetPrice = target
  result.pullbackWatchPrice = route === 'PULLBACK' ? entry : null
  result.breakoutWatchPrice = route === 'BREAKOUT' ? entry : null
  result.riskReward = selected.riskReward == null
    ? null
    : `${Number(selected.riskReward).toFixed(2)}:1`
  result.edge = adaptive.playbook?.evidence?.join('；')
    || result.edge
  result.crowdingRisk = adaptive.cautions?.[0]
    || result.crowdingRisk
  result.invalidation = stop > 0
    ? `跌破${priceText(stop)}元或${adaptive.playbook?.label || '当前打法'}失效`
    : result.invalidation

  if (executable) {
    result.action = adaptive.tier === 'ATTACK'
      ? '立即买入'
      : '小仓试错'
    result.tier = adaptive.tier === 'ATTACK' ? 'now' : 'probe'
    result.planQty = Math.max(1, lots(result.planQty) || 1)
    result.planQtyNum = result.planQty
    result.actionPlan =
      `${result.action}${result.planQty}手，参考${priceText(entry)}元；`
      + `止损${priceText(stop)}元，目标${priceText(target)}元`
  } else {
    result.action = route === 'PULLBACK' ? '回调再买' : '观望'
    result.tier = 'wait'
    result.planQty = 0
    result.planQtyNum = 0
    result.actionPlan = entry > 0
      ? `${selected.entryPlan.trigger}；到价后只复核一次，未确认则放弃本次路径`
      : '当前没有费后正期望且价格合法的买入路径'
  }
  appendAdjustment(
    result,
    `服务端已按${adaptive.playbook?.label || '当前最优打法'}核定动作`,
  )
  return result
}
