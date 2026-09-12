import {
  actionValueFromOpportunityScore,
  buildActionValueVector,
} from './actionValueContract.js'
import {
  isExecutableOpportunityScore,
} from './opportunityScoreContract.js'
import {
  optimizePositionActions,
} from './positionActionOptimizer.js'
import { isTriggeredReviewEvent } from './triggeredReviewDecision.js'

export const ACTION_VALUE_ARBITER_VERSION =
  'action-value-arbiter.v1'

function scoreReady(score) {
  return (
    isExecutableOpportunityScore(score)
    && score?.serverVerified === true
    && Number.isFinite(Number(score.pFill))
    && Number.isFinite(Number(score.pWinGivenFill))
    && Number.isFinite(Number(score.expectedNetR))
    && Number.isFinite(Number(score.netRLowerBound))
    && Number.isFinite(Number(score.expectedShortfall10))
  )
}

function metric(score, path, fallback) {
  const value = path.reduce(
    (current, key) => current?.[key],
    score?.taskValues,
  )
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function actionUtility(plan, action) {
  const score = plan?.opportunityScore
  if (!scoreReady(score)) return Number.NEGATIVE_INFINITY
  const expected = Number(score.expectedNetR)
  const fill = Number(score.pFill)
  const fallback = Number.isFinite(expected) ? expected : 0
  if (action === 'BUY') {
    return metric(score, ['entry', 'expectedNetR'], fill * fallback)
  }
  if (action === 'ADD') {
    return metric(
      score,
      ['portfolio', 'addExecutionAdjustedR'],
      fill * fallback,
    )
  }
  if (action === 'HOLD') {
    return metric(score, ['portfolio', 'holdR'], fallback)
  }
  if (action === 'REDUCE') {
    return metric(
      score,
      ['portfolio', 'reduceRelativeToHoldR'],
      -fallback * 0.5,
    )
  }
  if (action === 'EXIT') {
    return metric(
      score,
      ['portfolio', 'exitRelativeToHoldR'],
      -fallback,
    )
  }
  return Number.NEGATIVE_INFINITY
}

function actionValue(plan, action, eligibility) {
  const score = plan.opportunityScore
  const expectedNetR = actionUtility(plan, action)
  return actionValueFromOpportunityScore({
    action,
    route: plan.route,
    score,
    eligibility,
    metrics: {
      expectedNetR,
      q10R: metric(
        score,
        ['risk', 'q10R'],
        Number(score.netRLowerBound),
      ),
      cvarR: metric(
        score,
        ['risk', 'cvarR'],
        Number(score.expectedShortfall10),
      ),
      pFill: ['HOLD', 'REDUCE', 'EXIT'].includes(action)
        ? 1
        : metric(score, ['execution', 'pFill'], Number(score.pFill)),
    },
  })
}

function optimizedPositionValue(
  plan,
  candidate,
  eligibility,
) {
  const value = actionValueFromOpportunityScore({
    action: candidate.action,
    route: plan.route,
    score: plan.opportunityScore,
    eligibility,
    metrics: {
      expectedNetR: candidate.remainingExpectedR,
      q10R: -candidate.remainingTailPenaltyR,
      cvarR: plan.opportunityScore.expectedShortfall10,
      pFill: 1,
      executionCostR: candidate.sellCostR,
      uncertaintyPenaltyR:
        candidate.remainingTailPenaltyR
        + candidate.switchPenaltyR,
    },
  })
  return {
    ...value,
    positionCandidate: candidate,
  }
}

function positionOptimizationFor(plan, state) {
  if (!plan) return null
  const score = plan.opportunityScore
  return optimizePositionActions({
    expectedHoldR: metric(
      score,
      ['portfolio', 'holdR'],
      Number(score.expectedNetR),
    ),
    lowerBoundR: metric(
      score,
      ['risk', 'q10R'],
      Number(score.netRLowerBound),
    ),
    price: state.quote.price,
    hardStopPrice:
      state.position.hardStopPrice
      ?? plan.exitPlan?.hardStopPrice,
    totalLots: state.eligibility.totalLots,
    sellableLots: state.eligibility.sellableLots,
    stockWeightPct: state.position.stockWeightPct,
    maxStockWeightPct: state.account.maxStockWeightPct,
  })
}

function bestCandidate(candidates) {
  const objective = (candidate) => {
    if (['BUY', 'ADD'].includes(candidate.action) && candidate.plan.targetPosition) {
      return candidate.plan.targetPosition.state === 'READY'
        ? candidate.plan.targetPosition.selected.opportunityNetAmount
        : Number.NEGATIVE_INFINITY
    }
    return Number(candidate.value.actionUtilityR)
  }
  return [...candidates].sort(
    (left, right) => objective(right) - objective(left),
  )[0] || null
}

function addReview(event) {
  if (!isTriggeredReviewEvent(event)) return false
  const action = String(event?.plannedAction || '').toUpperCase()
  return (
    ['ADD', 'PROBE_ADD'].includes(action)
    || /加仓/.test(`${event?.actionLabel || ''} ${event?.reason || ''}`)
  )
}

export function arbitrateActionValues({
  state,
  plans = [],
} = {}) {
  const modelVersions = new Set(
    plans
      .filter((plan) => scoreReady(plan?.opportunityScore))
      .map((plan) => plan.opportunityScore.modelVersion),
  )
  const scored = plans
    .filter((plan) => (
      scoreReady(plan?.opportunityScore)
      && modelVersions.size === 1
      && state.evidence.complete === true
    ))
    .sort(
      (left, right) =>
        actionUtility(right, state.eligibility.held ? 'HOLD' : 'BUY')
        - actionUtility(left, state.eligibility.held ? 'HOLD' : 'BUY'),
    )
  const immediate = scored.find((plan) => plan.route === 'IMMEDIATE')
    || null
  const positionOptimization = state.eligibility.held
    ? positionOptimizationFor(immediate, state)
    : null
  const optimizedPositionCandidates = (
    positionOptimization?.state === 'READY'
  ) ? ['HOLD', 'REDUCE', 'EXIT']
      .map((action) => positionOptimization.actions[action])
      .filter(Boolean)
      .map((candidate) => ({
        action: candidate.action,
        plan: immediate,
        value: optimizedPositionValue(
          immediate,
          candidate,
          state.eligibility,
        ),
      }))
    : null
  const candidates = state.eligibility.held
    ? [
        ...(optimizedPositionCandidates || (
          immediate ? ['HOLD', 'REDUCE', 'EXIT'].map((action) => ({
            action,
            plan: immediate,
            value: actionValue(immediate, action, state.eligibility),
          })) : []
        )),
        ...scored.map((plan) => ({
          action: 'ADD',
          plan,
          value: actionValue(plan, 'ADD', state.eligibility),
        })),
      ]
    : scored.map((plan) => ({
        action: 'BUY',
        plan,
        value: actionValue(plan, 'BUY', state.eligibility),
      }))
  const engine = scored[0]?.opportunityScore?.engine || {}
  const vector = buildActionValueVector({
    state,
    values: candidates.map((candidate) => candidate.value),
    encoderVersion: engine.stateEncoder || 'feature-adapter.v1',
    routerVersion: engine.router || 'deterministic-action-router.v1',
    positionOptimization,
  })
  if (state.eligibility.hardStop) {
    return {
      action: state.eligibility.sellableLots <= 0
        ? 'HOLD_LOCKED'
        : state.eligibility.sellableLots >= state.eligibility.totalLots
          ? 'EXIT'
          : 'REDUCE',
      selectedPlan: immediate,
      conditionalAddPlan: null,
      vector,
      reason: 'HARD_STOP',
    }
  }
  if (!state.eligibility.held) {
    const selected = bestCandidate(candidates)
    const selectedPlan = selected?.plan || null
    const executable = (
      selected?.value?.feasible === true
      && Number(selected?.value?.actionUtilityR) > 0
      && selectedPlan.route === 'IMMEDIATE'
      && state.quote.live === true
      && state.eligibility.actions.includes('BUY')
      && (!selectedPlan.targetPosition || selectedPlan.targetPosition.state === 'READY')
    )
    return {
      action: executable ? 'BUY' : 'WAIT',
      selectedPlan,
      conditionalAddPlan: null,
      vector,
      reason: !selectedPlan
        ? 'MODEL_UNAVAILABLE'
        : selected?.value?.feasible === true
          ? 'ENTRY_VALUE'
          : 'ENTRY_INELIGIBLE',
    }
  }
  if (!immediate) {
    return {
      action: state.eligibility.sellableLots <= 0
        ? 'HOLD_LOCKED'
        : 'HOLD',
      selectedPlan: null,
      conditionalAddPlan: null,
      vector,
      reason: 'MODEL_UNAVAILABLE',
    }
  }
  const positionCandidates = candidates.filter((candidate) => (
    ['HOLD', 'REDUCE', 'EXIT'].includes(candidate.action)
    && candidate.value.feasible
  ))
  const current = positionOptimization?.state === 'READY'
    ? positionCandidates.find(
        (candidate) =>
          candidate.action
          === positionOptimization.selectedAction,
      ) || null
    : bestCandidate(positionCandidates)
  const currentAction = current?.action || 'HOLD'
  const currentPositive = (
    positionOptimization?.state === 'READY'
      ? positionOptimization.actions.HOLD.actionUtilityR
      : actionUtility(immediate, 'HOLD')
  ) > 0
  if (
    addReview(state.review)
    && state.quote.live === true
    && state.eligibility.actions.includes('ADD')
    && currentPositive
    && actionUtility(immediate, 'ADD') > 0
    && (!immediate.targetPosition || immediate.targetPosition.state === 'READY')
  ) {
    return {
      action: 'ADD',
      selectedPlan: immediate,
      conditionalAddPlan: null,
      vector,
      reason: 'ADD_REVIEW_CONFIRMED',
    }
  }
  const conditionalAdd = bestCandidate(
    candidates.filter((candidate) => (
      candidate.action === 'ADD'
      && candidate.plan.route !== 'IMMEDIATE'
      && candidate.value.feasible
      && Number(candidate.value.actionUtilityR) > 0
      && (!candidate.plan.targetPosition || candidate.plan.targetPosition.state === 'READY')
    )),
  )
  const conditionalAddPlan = currentAction === 'HOLD'
    && !state.review
    && state.eligibility.actions.includes('ADD')
    ? conditionalAdd?.plan || null
    : null
  return {
    action: currentAction,
    selectedPlan: conditionalAddPlan || current?.plan || immediate,
    conditionalAddPlan,
    vector,
    reason: conditionalAddPlan
      ? 'HOLD_WITH_ADD_TRIGGER'
      : currentAction === 'HOLD'
        ? 'POSITIVE_HOLD_VALUE'
        : 'PORTFOLIO_ACTION_VALUE',
  }
}
