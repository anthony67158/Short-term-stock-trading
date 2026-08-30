import { buildKnowledgeActionPlan } from './knowledgeAction.js'
import { buildQuantAdviceContext } from './quantAdviceContext.js'
import { sanitizedAdvicePriceContract } from './advicePriceContract.js'
import { compactStockFundSnapshot } from './retailFundFlow.js'
import { sanitizeAdviceReviewMemory } from './adviceReviewMemory.js'

const text = (value, max = 800) => String(value || '').trim().slice(0, max)
const finite = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function buildJudgeAdviceContext(advice = {}) {
  const continuity = advice.continuity && typeof advice.continuity === 'object'
    ? advice.continuity
    : {}
  const zones = continuity.zones && typeof continuity.zones === 'object'
    ? continuity.zones
    : {}
  const zone = (value) => {
    if (!value || typeof value !== 'object') return null
    const low = finite(value.low)
    const high = finite(value.high)
    const anchor = finite(value.anchor)
    return low != null && high != null
      ? { low, high, anchor }
      : null
  }
  const planId = text(continuity.planId, 120)
  const planContext = planId ? {
    planId,
    planRevision: Number(continuity.revision) || 0,
    thesisVersion: Number(continuity.thesisVersion) || 0,
    changeType: text(continuity.changeType, 30),
    changeReason: text(continuity.changeReason, 500),
    ...(zone(zones.add) ? { addZone: zone(zones.add) } : {}),
    ...(zone(zones.reduce) ? { reduceZone: zone(zones.reduce) } : {}),
    ...(zone(zones.stop) ? { stopZone: zone(zones.stop) } : {}),
    ...(zone(zones.target) ? { targetZone: zone(zones.target) } : {}),
  } : {}
  const knowledgeActionContext = advice.knowledgeActionPlan
    && typeof advice.knowledgeActionPlan === 'object'
    ? {
        knowledgeActionPlan: buildKnowledgeActionPlan(advice),
        knowledgeActionScore: advice.knowledgeActionScore
          && typeof advice.knowledgeActionScore === 'object'
          ? advice.knowledgeActionScore
          : undefined,
      }
    : {}
  const quantContext = buildQuantAdviceContext(
    advice.quantContext,
    advice.quantContext?.selectedModelVersion,
  )
  const decisionPlan = advice.decisionPlan?.schemaVersion === 'decision-plan.v2'
    ? {
        schemaVersion: 'decision-plan.v2',
        decisionId: text(advice.decisionPlan.decisionId, 100),
        action: text(advice.decisionPlan.action, 30),
        actionability: text(advice.decisionPlan.actionability, 30),
        validUntil: text(advice.decisionPlan.validUntil, 40),
        blockedReasons: (Array.isArray(advice.decisionPlan.blockedReasons)
          ? advice.decisionPlan.blockedReasons
          : [])
          .map((item) => text(item, 160))
          .filter(Boolean)
          .slice(0, 8),
      }
    : null
  const priceContract = sanitizedAdvicePriceContract(advice)
  const fundContext = compactStockFundSnapshot(advice.fundContext)
  const reviewMemory = sanitizeAdviceReviewMemory(advice.reviewMemory)
  const nextOpenPlan = text(advice.nextOpenPlan, 800)
  const futurePlan = text(advice.futurePlan, 800)
  return {
    ...planContext,
    ...knowledgeActionContext,
    ...(quantContext ? { quantContext } : {}),
    ...(decisionPlan ? { decisionPlan } : {}),
    ...(priceContract ? { priceContract } : {}),
    ...(fundContext ? { fundContext } : {}),
    ...(reviewMemory ? { reviewMemory } : {}),
    ...(nextOpenPlan ? { nextOpenPlan } : {}),
    ...(futurePlan ? { futurePlan } : {}),
    action: text(advice.action || advice.stance, 40),
    tier: text(advice.tier, 30),
    title: text(advice.title || advice.headline, 200),
    actionPlan: text(advice.actionPlan || advice.nextAction, 1200),
    exitTiming: text(advice.exitTiming || advice.timing, 1200),
    opQty: text(advice.opQty || advice.planQty, 40),
    addPrice: finite(advice.addPrice ?? advice.buyPrice),
    reducePrice: finite(advice.reducePrice),
    stopPrice: finite(advice.stopPrice),
    targetPrice: finite(advice.targetPrice),
    riskReward: text(advice.riskReward, 80),
    positionNote: text(advice.positionNote || advice.posAfter || advice.planWeight, 400),
    reason: text(advice.reason || advice.reasoning, 1200),
    techNote: text(advice.techNote, 800),
    fundNote: text(advice.fundNote, 800),
    newsNote: text(advice.newsNote, 800),
    quantNote: text(advice.quantNote, 800),
    bearCase: text(advice.bearCase, 800),
    invalidation: text(advice.invalidation, 800),
    confidence: text(advice.confidence, 30),
  }
}

export function actionIntentOf(alert = {}) {
  if (alert.actKind === 'add') return 'add'
  if (alert.actKind === 'reduce') return 'reduce'
  const note = String(alert.note || '')
  if (/止损/.test(note)) return 'stop'
  if (/止盈|减仓/.test(note)) return 'sell'
  return 'buy'
}

export function actionLabelOf(alert = {}) {
  return {
    add: '加仓',
    reduce: '减仓',
    stop: '止损离场',
    sell: '卖出',
    buy: '买入',
  }[actionIntentOf(alert)] || '操作'
}

export function adviceSupportsIntent(intent, context = {}) {
  if (intent !== 'add') return true
  const guidance = [
    context.action,
    context.title,
    context.actionPlan,
    context.reason,
    context.riskReward,
    context.positionNote,
  ].filter(Boolean).join(' ')
  if (!guidance) return true
  if (/不(?:建议|宜|要|应)?(?:再)?加仓|暂不加仓|无需加仓|不新增仓位|禁止加仓|赔率.{0,16}(不足|不达标)/.test(guidance)) {
    return false
  }
  if (/加仓|补仓|接回|买回/.test(guidance)) return true
  if (/减仓|清仓|卖出|不建议|观望/.test(guidance)) return false
  return context.addPrice > 0
}
