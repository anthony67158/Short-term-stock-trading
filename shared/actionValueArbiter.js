import {
  actionValueFromOpportunityScore,
  buildActionValueVector,
} from './actionValueContract.js'
import {
  isExecutableOpportunityScore,
} from './opportunityScoreContract.js'
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

function positive(plan) {
  const score = plan?.opportunityScore
  return (
    scoreReady(score)
    && Number(score.expectedNetR) > 0
    && Number(score.pFill) > 0
    && (
      score.meanConfidenceLowerBound == null
      || Number(score.meanConfidenceLowerBound) > 0
    )
  )
}

function utility(plan) {
  return (
    Number(plan?.opportunityScore?.pFill)
    * Number(plan?.opportunityScore?.expectedNetR)
  )
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
    .sort((left, right) => utility(right) - utility(left))
  const immediate = scored.find((plan) => plan.route === 'IMMEDIATE')
    || null
  const values = scored.map((plan) => actionValueFromOpportunityScore({
    action: state.eligibility.held ? 'HOLD' : 'BUY',
    route: plan.route,
    score: plan.opportunityScore,
    eligibility: state.eligibility,
  }))
  const vector = buildActionValueVector({ state, values })
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
    const selectedPlan = scored[0] || null
    const executable = (
      positive(selectedPlan)
      && selectedPlan.route === 'IMMEDIATE'
      && state.quote.live === true
      && state.eligibility.actions.includes('BUY')
    )
    return {
      action: executable ? 'BUY' : 'WAIT',
      selectedPlan,
      conditionalAddPlan: null,
      vector,
      reason: selectedPlan ? 'ENTRY_VALUE' : 'MODEL_UNAVAILABLE',
    }
  }
  const currentPositive = positive(immediate)
  if (!currentPositive) {
    const action = state.eligibility.sellableLots <= 0
      ? 'HOLD_LOCKED'
      : state.eligibility.sellableLots >= state.eligibility.totalLots
        ? 'EXIT'
        : 'REDUCE'
    return {
      action,
      selectedPlan: immediate,
      conditionalAddPlan: null,
      vector,
      reason: immediate ? 'NEGATIVE_HOLD_VALUE' : 'MODEL_UNAVAILABLE',
    }
  }
  if (
    addReview(state.review)
    && state.quote.live === true
    && state.eligibility.actions.includes('ADD')
  ) {
    return {
      action: 'ADD',
      selectedPlan: immediate,
      conditionalAddPlan: null,
      vector,
      reason: 'ADD_REVIEW_CONFIRMED',
    }
  }
  const conditionalAddPlan = !state.review
    && state.eligibility.actions.includes('ADD')
    ? scored.find((plan) => (
        plan.route !== 'IMMEDIATE'
        && positive(plan)
      )) || null
    : null
  return {
    action: 'HOLD',
    selectedPlan: conditionalAddPlan || immediate,
    conditionalAddPlan,
    vector,
    reason: conditionalAddPlan
      ? 'HOLD_WITH_ADD_TRIGGER'
      : 'POSITIVE_HOLD_VALUE',
  }
}
