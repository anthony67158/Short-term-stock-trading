import { evaluateHoldingActions } from './holdingActionValue.js'
import { isExecutableOpportunityScore } from './opportunityScoreContract.js'

export const ADAPTIVE_ADVICE_POLICY_VERSION =
  'adaptive-advice-policy.v1'

export function v3DecisionReadiness(score) {
  return isExecutableOpportunityScore(score)
    && score.serverVerified === true
    && Number(score.pFill) >= 0 && Number(score.pFill) <= 1
    && Number(score.pWinGivenFill) >= 0 && Number(score.pWinGivenFill) <= 1
    && [score.pFill, score.pWinGivenFill, score.expectedNetR,
      score.netRLowerBound, score.expectedShortfall10]
      .every((value) => value != null && Number.isFinite(Number(value)))
}

export function buildV3Action({ payload, plans = [], now = Date.now() }) {
  const held = Number(payload.holdQty) > 0
  const price = finite(payload.todayQuote?.price)
  const stop = finite(payload.holdingStopPrice)
  const sellable = Math.max(0, Math.min(
    Number(payload.holdQty) || 0, Number(payload.sellableTodayQty) || 0,
  ))
  const hardStop = held && price > 0 && stop > 0 && price <= stop
    && payload.todayQuote?.live === true
  const modelVersions = new Set(plans.filter((plan) => v3DecisionReadiness(plan.opportunityScore))
    .map((plan) => plan.opportunityScore.modelVersion))
  const scored = plans.filter((plan) =>
    v3DecisionReadiness(plan.opportunityScore)
    && modelVersions.size === 1
    && (!held || plan.route === 'IMMEDIATE')
    && !payload.evidenceIncomplete)
    .sort((a, b) =>
      b.opportunityScore.pFill * b.opportunityScore.expectedNetR
        - a.opportunityScore.pFill * a.opportunityScore.expectedNetR)
  const selected = scored[0] || null
  const state = payload.evidenceIncomplete ? 'EVIDENCE_INCOMPLETE'
    : selected ? 'READY' : 'MODEL_ERROR'
  const holdingAction = held ? evaluateHoldingActions({
    payload: { ...payload, decisionEngine: 'V3', opportunityScore: selected?.opportunityScore },
  }) : null
  const expectedPositive = selected?.opportunityScore.expectedNetR > 0
    && selected?.opportunityScore.pFill > 0
    && (selected.opportunityScore.meanConfidenceLowerBound == null
      || selected.opportunityScore.meanConfidenceLowerBound > 0)
  const immediate = !held && expectedPositive
    && selected.route === 'IMMEDIATE'
    && payload.todayQuote?.live === true
  const action = held
    ? { EXIT: '清仓', REDUCE: '减仓', HOLD: '持有', HOLD_LOCKED: '持有' }[holdingAction.selected.action]
    : immediate ? '立即买入' : '观望'
  const selling = ['清仓', '减仓'].includes(action)
  const instruction = hardStop
    ? sellable > 0
      ? `已触及账本止损${priceText(stop)}元，人工卖出可卖${sellable}手并记录成交`
      : `已触及账本止损${priceText(stop)}元，今日仓位受T+1锁定，下一可卖时段优先处理`
    : !selected ? held ? '暂不加仓；V3模型调用失败，已有止损继续有效'
      : '本次不买入；V3模型调用失败'
      : held ? selling ? `V3剩余路径费后价值不为正，${action}${sellable}手`
        : holdingAction.selected.action === 'HOLD_LOCKED' ? 'V3提示退出，但今日仓位受T+1锁定，下一可卖时段优先处理'
          : `继续持有${Math.trunc(payload.holdQty)}手；V3剩余路径费后价值为正，暂不加仓`
        : !expectedPositive ? 'V3预测费后净期望不为正，放弃本次买入'
          : immediate ? `V3选定现价路径，参考${priceText(selected.entryPlan.price)}元，手数由账户风控核定`
            : `V3选定${selected.route === 'PULLBACK' ? '回踩' : selected.route === 'BREAKOUT' ? '突破' : '下一交易时段'}路径，待条件成立后重新评估`
  const score = selected?.opportunityScore
  return {
    action,
    title: instruction,
    actionPlan: instruction,
    nextAction: instruction,
    opQty: selling ? `${action}${sellable}手` : '不加仓、不减仓',
    planQty: 0,
    buyPrice: immediate ? selected.entryPlan.price : null,
    reducePrice: selling ? price : null,
    stopPrice: held ? stop : selected?.exitPlan.hardStopPrice ?? null,
    targetPrice: selected?.exitPlan.takeProfitPrice ?? null,
    pullbackWatchPrice: !held && expectedPositive && selected.route === 'PULLBACK'
      ? selected.entryPlan.price : null,
    breakoutWatchPrice: !held && expectedPositive && selected.route === 'BREAKOUT'
      ? selected.entryPlan.price : null,
    invalidation: stop > 0 && held ? `账本止损${priceText(stop)}元保持有效`
      : '报价、账户或模型版本变化后重新评估；不使用过期决策',
    nextOpenPlan: '下一交易时段读取新报价与模型状态，未获得有效授权不新增风险',
    futurePlan: '持续按账本止损和当前模型状态管理，不按固定天数机械退出',
    quantNote: score
      ? `V3成交概率${(score.pFill * 100).toFixed(1)}%，成交后费后盈利率${(score.pWinGivenFill * 100).toFixed(1)}%，费后期望${score.expectedNetR}R`
      : 'V3模型未返回有效预测；未使用旧模型或手写概率替代',
    techNote: price > 0 ? `行情参考价${priceText(price)}元` : '行情暂不可用',
    decisionSource: {
      schemaVersion: 'v3-decision-source.v1',
      engine: 'V3',
      state,
      modelVersion: score?.modelVersion || null,
      explanationRequired: false,
      evaluatedAt: now,
      hardProtection: hardStop,
      coverage: held ? 'REMAINING_PRICE_PATH' : 'ENTRY_PATH',
      missingEvidence: payload.missingEvidence || [],
      usagePolicy: score?.usagePolicy || null,
      outOfDistribution: score?.outOfDistribution === true,
    },
    adaptiveAction: holdingAction,
    v3Plans: plans,
    selectedV3Plan: selected,
  }
}

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
