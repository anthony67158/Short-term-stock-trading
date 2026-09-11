import {
  evaluateSelectionActionValue,
} from '../shared/selectionActionValue.js'
import {
  buildAdaptivePricePlans,
} from '../shared/adaptivePricePlans.js'
import {
  buildMarketOpportunityContext,
} from '../shared/marketOpportunityContext.js'
import {
  buildOpportunityScoreInput,
  unavailableOpportunityScore,
} from '../shared/opportunityScoreContract.js'
import {
  scoreOpportunityPlaybooks,
} from '../shared/opportunityPlaybooks.js'
import {
  beijingMinutes,
} from '../shared/tradingCalendar.js'
import { fetchOpportunityScores } from './_opportunity_score.js'

const ROUTES = new Set(['IMMEDIATE', 'PULLBACK', 'BREAKOUT'])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function directScore(value) {
  return value?.state === 'READY' && value?.usagePolicy === 'DIRECT'
}

function routeOf(value = {}) {
  const route = String(value.route || value.entryPlan?.type || '').toUpperCase()
  return ROUTES.has(route) ? route : null
}

function planFromDecision(value = {}) {
  if (value?.entryPlan && value?.exitPlan) {
    const route = routeOf(value)
    const entryPrice = finite(value.entryPlan.price)
    const stopPrice = finite(value.exitPlan.hardStopPrice)
    const targetPrice = finite(value.exitPlan.takeProfitPrice)
    if (
      !route
      || !(entryPrice > 0)
      || !(stopPrice > 0)
      || !(targetPrice > entryPrice)
      || !(stopPrice < entryPrice)
    ) return null
    return {
      route,
      entryPlan: value.entryPlan,
      exitPlan: value.exitPlan,
      riskReward: finite(value.riskReward),
    }
  }
  const route = routeOf(value)
  const entryPrice = finite(value.primaryPrice)
  const stopPrice = finite(value.stopPrice)
  const targetPrice = finite(value.targetPrice)
  if (
    !route
    || !(entryPrice > 0)
    || !(stopPrice > 0)
    || !(targetPrice > entryPrice)
    || !(stopPrice < entryPrice)
  ) return null
  return {
    route,
    entryPlan: {
      type: route,
      price: entryPrice,
      validUntil: finite(value.validUntil),
    },
    exitPlan: {
      hardStopPrice: stopPrice,
      takeProfitPrice: targetPrice,
      timeStopTradingDays: finite(value.timeStopTradingDays),
    },
    riskReward: finite(value.riskReward),
  }
}

function candidatePlans(candidate, marketContext, now) {
  const explicit = (
    Array.isArray(candidate.pricePlans)
      ? candidate.pricePlans
      : []
  ).map(planFromDecision).filter(Boolean)
  if (explicit.length) return explicit

  if (
    Array.isArray(candidate.candles)
    && candidate.candles.length
  ) {
    const generated = buildAdaptivePricePlans({
      candidate,
      candles: candidate.candles,
      trends: candidate.trends,
      marketContext,
      now,
    })
    if (generated.length) return generated
  }

  const stored = [
    planFromDecision(candidate),
    ...(Array.isArray(candidate.actionAlternatives)
      ? candidate.actionAlternatives.map(planFromDecision)
      : []),
  ].filter(Boolean)
  if (stored.length) {
    return [...new Map(
      stored.map((plan) => [routeOf(plan), plan]),
    ).values()]
  }

  return buildAdaptivePricePlans({
    candidate,
    candles: candidate.candles,
    trends: candidate.trends,
    marketContext,
    now,
  })
}

function scoreInput(candidate, plan, {
  mode,
  slot,
  marketGate,
  marketContext,
  now,
}) {
  const playbook = scoreOpportunityPlaybooks(
    {
      ...candidate,
      entryPlan: plan.entryPlan,
      exitPlan: plan.exitPlan,
      riskReward: plan.riskReward,
    },
    marketContext,
  ).selected
  const formulaId = String(
    candidate.formulaId
    || candidate.decision?.formulaId
    || candidate.formula?.matches?.[0]?.formulaId
    || (candidate.origin === 'PRE_CATALYST' ? 'UNKNOWN' : 'TAIL_REVERSAL'),
  )
  return buildOpportunityScoreInput({
    batch: {
      mode,
      slot,
      marketGate,
    },
    event: {
      code: candidate.code,
      name: candidate.name,
      asOf: now,
      mode,
      stageReached: 'DISPLAYED',
      quote: candidate.quote,
      cheapScore: finite(candidate.activationScore ?? candidate.score),
      recall: candidate.recall,
      formulaEvaluations:
        candidate.formulaEvaluations
        || candidate.formula?.evaluations
        || [],
      shadowFeatures: candidate.shadowFeatures,
      decision: {
        formulaId,
        playbookId: playbook?.key,
        playbookScore: playbook?.score,
        marketOpportunityFactor: marketContext.opportunityFactor,
        route: routeOf(plan),
        primaryPrice: plan.entryPlan.price,
        priceType: routeOf(plan) === 'BREAKOUT'
          ? 'BREAKOUT_WATCH'
          : 'PULLBACK_WATCH',
        stopPrice: plan.exitPlan.hardStopPrice,
        targetPrice: plan.exitPlan.takeProfitPrice,
        riskReward: plan.riskReward,
        priceContractValid: true,
      },
      sector: candidate.sectorOpportunity?.sector || candidate.sector,
    },
  })
}

function scoredPlan(candidate, plan, score, marketContext) {
  const opportunityScore = {
    ...(score || unavailableOpportunityScore(
      { code: candidate.code, formulaId: candidate.formulaId },
      'MISSING_RESPONSE',
    )),
    serverVerified: true,
    priceContract: {
      entryPrice: finite(plan.entryPlan?.price),
      stopPrice: finite(plan.exitPlan?.hardStopPrice),
      targetPrice: finite(plan.exitPlan?.takeProfitPrice),
    },
  }
  const adaptive = evaluateSelectionActionValue({
    ...candidate,
    entryPlan: plan.entryPlan,
    exitPlan: plan.exitPlan,
    riskReward: plan.riskReward,
    opportunityScore,
  }, marketContext)
  return {
    ...plan,
    opportunityScore,
    adaptive,
  }
}

function planPriority(value) {
  if (!directScore(value.opportunityScore)) return -Infinity
  return Number(value.adaptive?.utility ?? -Infinity)
}

export async function scoreCandidatesWithDecisionModel(
  candidates = [],
  {
    mode = 'INTRADAY',
    slot = beijingMinutes(),
    market = {},
    marketGate = null,
    marketContext = null,
    now = Date.now(),
    scoreOpportunities = fetchOpportunityScores,
  } = {},
) {
  const context = marketContext || buildMarketOpportunityContext({
    market,
    marketGate,
  })
  const records = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => /^\d{6}$/.test(String(candidate?.code || '')))
    .map((candidate) => ({
      candidate,
      plans: candidatePlans(candidate, context, now),
    }))
  const routeGroups = new Map()
  for (const record of records) {
    for (const plan of record.plans) {
      const route = routeOf(plan)
      if (!route) continue
      let input
      try {
        input = scoreInput(record.candidate, plan, {
          mode,
          slot,
          marketGate,
          marketContext: context,
          now,
        })
      } catch {
        continue
      }
      const group = routeGroups.get(route) || []
      group.push({ record, plan, input })
      routeGroups.set(route, group)
    }
  }
  const scoreByPlan = new Map()
  await Promise.all([...routeGroups.values()].map(async (group) => {
    const scores = await scoreOpportunities(group.map((item) => item.input))
      .catch(() => new Map())
    for (const item of group) {
      scoreByPlan.set(item.plan, scores.get(item.input.code)
        || unavailableOpportunityScore(item.input, 'MISSING_RESPONSE'))
    }
  }))

  return records.map(({ candidate, plans }) => {
    const publicCandidate = { ...candidate }
    delete publicCandidate.candles
    delete publicCandidate.trends
    delete publicCandidate.pricePlans
    const evaluated = plans.map((plan) => scoredPlan(
      candidate,
      plan,
      scoreByPlan.get(plan),
      context,
    )).sort((left, right) =>
      planPriority(right) - planPriority(left)
      || String(left.route).localeCompare(String(right.route))
    )
    const selected = evaluated[0]
    if (!selected) {
      const adaptive = evaluateSelectionActionValue(candidate, context)
      return {
        ...publicCandidate,
        state: 'AVOID',
        stateLabel: '决策评分不可用',
        blockers: adaptive.hardBlockers,
        cautions: adaptive.cautions,
        adaptive,
        opportunityScore: null,
        decisionScoring: {
          usagePolicy: 'DIRECT',
          scoredRoutes: 0,
          directRoutes: 0,
        },
      }
    }
    const directRoutes = evaluated.filter((plan) =>
      directScore(plan.opportunityScore)
    ).length
    return {
      ...publicCandidate,
      route: selected.route,
      entryPlan: selected.entryPlan,
      exitPlan: selected.exitPlan,
      riskReward: selected.riskReward,
      opportunityScore: selected.opportunityScore,
      adaptive: selected.adaptive,
      state: selected.adaptive.tier === 'ATTACK'
        ? 'READY'
        : selected.adaptive.tier === 'AVOID'
          ? 'AVOID'
          : 'WAIT_TRIGGER',
      stateLabel: selected.adaptive.actionLabel,
      blockers: selected.adaptive.hardBlockers,
      cautions: selected.adaptive.cautions,
      actionAlternatives: evaluated.slice(1),
      decisionScoring: {
        usagePolicy: 'DIRECT',
        scoredRoutes: evaluated.length,
        directRoutes,
      },
    }
  })
}
