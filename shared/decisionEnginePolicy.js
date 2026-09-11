import { arbitrateActionValues } from './actionValueArbiter.js'
import { buildDecisionState } from './decisionStateContract.js'
import {
  isExecutableOpportunityScore,
} from './opportunityScoreContract.js'
import { isTriggeredReviewEvent } from './triggeredReviewDecision.js'

export const DECISION_ENGINE_POLICY_VERSION =
  'decision-engine-policy.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function priceText(value) {
  const number = finite(value)
  return number > 0 ? number.toFixed(2) : '--'
}

function modelReady(score) {
  return (
    isExecutableOpportunityScore(score)
    && score?.serverVerified === true
  )
}

function holdingAddPlanOf(plan, payload = {}) {
  if (!plan || !['PULLBACK', 'BREAKOUT'].includes(plan.route)) return null
  const full = Number(plan.opportunityScore?.meanConfidenceLowerBound) > 0
  const accountLimit = Number(payload.account?.maxStockWeight)
  const maxPositionPct = full
    ? Math.min(
        20,
        Number.isFinite(accountLimit) && accountLimit > 0
          ? accountLimit
          : 20,
      )
    : 5
  return {
    schemaVersion: 'holding-add-plan.v1',
    route: plan.route,
    price: plan.entryPlan.price,
    direction: plan.route === 'PULLBACK' ? 'LTE' : 'GTE',
    plannedAction: full ? 'ADD' : 'PROBE_ADD',
    actionLabel: full ? '条件加仓' : '条件小仓加仓',
    maxPositionPct,
    manualConfirmationOnly: !full,
    strategyPatternConfirmation:
      plan.entryPlan?.strategyPatternConfirmation || null,
  }
}

function decisionStateOf(payload, plans, now) {
  const readyScores = plans
    .map((plan) => plan?.opportunityScore)
    .filter(modelReady)
  return buildDecisionState({
    code: payload.code,
    name: payload.name,
    asOf: now,
    quote: payload.todayQuote,
    position: {
      totalLots: payload.holdQty,
      sellableLots: payload.sellableTodayQty,
      costPrice: payload.holdCost,
      hardStopPrice: payload.holdingStopPrice,
      stockWeightPct: payload.account?.stockWeight,
    },
    account: {
      ...payload.account,
      maxStockWeightPct: payload.account?.maxStockWeight,
      complete: payload.account?.complete !== false,
      circuitOpen: payload.accountCircuitBreaker?.state === 'OPEN',
      riskIncreaseAllowed:
        payload.accountCircuitBreaker?.allowRiskIncrease !== false,
    },
    market: payload.market || {},
    sector: payload.sectorOpportunity || {},
    fund: payload.stockFund || {},
    evidence: {
      complete: payload.evidenceIncomplete !== true,
      missing: payload.missingEvidence || [],
    },
    paths: plans,
    review: payload.reviewEvent || null,
    model: {
      ready: readyScores.length > 0,
      version: readyScores[0]?.modelVersion,
    },
  })
}

export function buildDecisionAction({
  payload,
  plans = [],
  now = Date.now(),
}) {
  const state = decisionStateOf(payload, plans, now)
  const decision = arbitrateActionValues({ state, plans })
  const selected = decision.selectedPlan
  const holdingAddPlan = holdingAddPlanOf(
    decision.conditionalAddPlan,
    payload,
  )
  const actionLabel = {
    BUY: '立即买入',
    ADD: '加仓',
    HOLD: '持有',
    HOLD_LOCKED: '持有',
    REDUCE: '减仓',
    EXIT: '清仓',
    WAIT: '观望',
  }[decision.action] || '观望'
  const selling = ['REDUCE', 'EXIT'].includes(decision.action)
  const reviewedExit = selling
    && isTriggeredReviewEvent(payload.reviewEvent)
  const price = finite(payload.todayQuote?.price)
  const stop = finite(payload.holdingStopPrice)
  const sellable = state.eligibility.sellableLots
  const hardStop = state.eligibility.hardStop
  const instruction = hardStop
    ? sellable > 0
      ? `已触及账本止损${priceText(stop)}元，人工卖出可卖${sellable}手并记录成交`
      : `已触及账本止损${priceText(stop)}元，今日仓位受T+1锁定，下一可卖时段优先处理`
    : !selected
      ? state.eligibility.held
        ? '暂不加仓；决策模型不可用，已有止损继续有效'
        : '本次不买入；决策模型不可用'
      : decision.action === 'ADD'
        ? `加仓观察条件已确认，参考${priceText(selected.entryPlan.price)}元，手数由账户风控核定`
        : selling
          ? reviewedExit
            ? `退出前复核后持仓价值仍不为正，${actionLabel}${sellable}手`
            : `持仓价值不为正，先观察约60秒并重新评估；复核仍不为正再${actionLabel}${sellable}手`
          : decision.action === 'HOLD_LOCKED'
            ? '模型提示退出，但今日仓位受T+1锁定，下一可卖时段优先处理'
            : holdingAddPlan
              ? `继续持有${state.eligibility.totalLots}手；${holdingAddPlan.actionLabel}价${priceText(holdingAddPlan.price)}元到达后重新评估`
              : decision.action === 'HOLD'
                ? `继续持有${state.eligibility.totalLots}手；当前持仓价值为正，暂不加仓`
                : decision.action === 'BUY'
                  ? `模型选定现价路径，参考${priceText(selected.entryPlan.price)}元，手数由账户风控核定`
                  : Number(selected.opportunityScore?.expectedNetR) <= 0
                    ? '预测费后净期望不为正，放弃本次买入'
                    : `模型选定${selected.route === 'PULLBACK' ? '回踩' : selected.route === 'BREAKOUT' ? '突破' : '下一交易时段'}路径，待条件成立后重新评估`
  const score = selected?.opportunityScore
  return {
    action: actionLabel,
    title: instruction,
    actionPlan: instruction,
    nextAction: instruction,
    opQty: selling
      ? `${actionLabel}${sellable}手`
      : decision.action === 'ADD' ? '加仓0手' : '不加仓、不减仓',
    planQty: 0,
    buyPrice: decision.action === 'BUY'
      ? selected?.entryPlan?.price ?? null
      : null,
    addPrice: decision.action === 'ADD'
      ? selected?.entryPlan?.price ?? null
      : null,
    reducePrice: selling ? price : null,
    stopPrice: (
      state.eligibility.held && !holdingAddPlan && decision.action !== 'ADD'
    ) ? stop : selected?.exitPlan?.hardStopPrice ?? stop ?? null,
    targetPrice: selected?.exitPlan?.takeProfitPrice ?? null,
    pullbackWatchPrice: (
      decision.action === 'WAIT' && selected?.route === 'PULLBACK'
    ) || holdingAddPlan?.route === 'PULLBACK'
      ? selected?.entryPlan?.price ?? null
      : null,
    breakoutWatchPrice: (
      decision.action === 'WAIT' && selected?.route === 'BREAKOUT'
    ) || holdingAddPlan?.route === 'BREAKOUT'
      ? selected?.entryPlan?.price ?? null
      : null,
    invalidation: stop > 0 && state.eligibility.held
      ? `账本止损${priceText(stop)}元保持有效`
      : '报价、账户或模型版本变化后重新评估；不使用过期决策',
    nextOpenPlan:
      '下一交易时段读取新报价与模型状态，未获得有效授权不新增风险',
    futurePlan:
      '持续按账本止损和当前模型状态管理，不按固定天数机械退出',
    quantNote: score
      ? `成交概率${(score.pFill * 100).toFixed(1)}%，成交后费后盈利率${(score.pWinGivenFill * 100).toFixed(1)}%，费后期望${score.expectedNetR}R`
      : '模型未返回有效预测；未使用旧模型或手写概率替代',
    techNote: price > 0 ? `行情参考价${priceText(price)}元` : '行情暂不可用',
    decisionSource: {
      schemaVersion: 'decision-source.v1',
      engine: 'MULTI_TASK',
      state: state.evidence.complete
        ? selected ? 'READY' : 'MODEL_ERROR'
        : 'EVIDENCE_INCOMPLETE',
      modelVersion: score?.modelVersion || null,
      encoderVersion: decision.vector.encoderVersion,
      routerVersion: decision.vector.routerVersion,
      explanationRequired: false,
      evaluatedAt: now,
      hardProtection: hardStop,
      exitReviewRequired: selling && !hardStop && !reviewedExit,
      coverage: state.eligibility.held
        ? 'PORTFOLIO_ACTIONS'
        : 'ENTRY_ACTIONS',
      missingEvidence: payload.missingEvidence || [],
      usagePolicy: score?.usagePolicy || null,
      outOfDistribution: score?.outOfDistribution === true,
    },
    decisionState: state,
    actionValues: decision.vector,
    holdingAddPlan,
    decisionPaths: plans,
    selectedDecisionPlan: selected,
  }
}
