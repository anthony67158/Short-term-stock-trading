import {
  ACTION_ELIGIBILITY_SCHEMA_VERSION,
  actionIsEligible,
} from './actionEligibility.js'
import {
  isExecutableOpportunityScore,
} from './opportunityScoreContract.js'

export const ACTION_VALUE_VECTOR_SCHEMA_VERSION =
  'action-value-vector.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function probability(value) {
  const number = finite(value)
  return number != null && number >= 0 && number <= 1
    ? number
    : null
}

function text(value, maximum = 120) {
  return String(value || '').trim().slice(0, maximum)
}

export function actionValueFromOpportunityScore({
  action,
  route,
  score,
  eligibility,
  horizonDays = 5,
  metrics = {},
} = {}) {
  const normalizedAction = text(action, 24).toUpperCase()
  const expectedNetR = finite(
    metrics.expectedNetR ?? score?.expectedNetR,
  )
  const q10R = finite(
    metrics.q10R
    ?? score?.netRLowerBound
    ?? score?.meanConfidenceLowerBound,
  )
  const expectedShortfall = finite(
    metrics.cvarR ?? score?.expectedShortfall10,
  )
  const executionCostR =
    finite(metrics.executionCostR ?? score?.executionCostR) ?? 0
  const avoidedTailLossR =
    finite(metrics.avoidedTailLossR) ?? 0
  const uncertaintyPenaltyR =
    finite(metrics.uncertaintyPenaltyR) ?? 0
  const opportunityCostR =
    finite(metrics.opportunityCostR) ?? 0
  return {
    action: normalizedAction,
    route: text(route || 'IMMEDIATE', 24).toUpperCase(),
    feasible: actionIsEligible(eligibility, normalizedAction),
    pFill: normalizedAction === 'HOLD'
      ? 1
      : probability(metrics.pFill ?? score?.pFill),
    pSuccessGivenFill: probability(
      metrics.pSuccessGivenFill ?? score?.pWinGivenFill,
    ),
    gainR: finite(score?.winPayoffR),
    lossR: finite(score?.lossPayoffR),
    expectedNetR,
    q10R,
    cvarR: expectedShortfall,
    avoidedTailLossR,
    executionCostR,
    uncertaintyR: (
      q10R != null && expectedNetR != null
        ? Math.max(0, expectedNetR - q10R)
        : null
    ),
    uncertaintyPenaltyR,
    opportunityCostR,
    actionUtilityR: expectedNetR == null
      ? null
      : +(
          expectedNetR
          + avoidedTailLossR
          - executionCostR
          - uncertaintyPenaltyR
          - opportunityCostR
        ).toFixed(6),
    horizonDays: Math.max(0, Math.trunc(finite(horizonDays) || 0)),
    modelVersion: text(score?.modelVersion, 120) || null,
    usagePolicy: text(score?.usagePolicy, 24) || null,
    ready: (
      isExecutableOpportunityScore(score)
      && score?.serverVerified === true
      && expectedNetR != null
      && q10R != null
    ),
  }
}

export function buildActionValueVector({
  state,
  values = [],
  encoderVersion = 'legacy-feature-adapter.v1',
  routerVersion = 'deterministic-action-router.v1',
  positionOptimization = null,
} = {}) {
  if (
    state?.eligibility?.schemaVersion
    !== ACTION_ELIGIBILITY_SCHEMA_VERSION
  ) {
    throw new Error('动作价值缺少合法动作合同')
  }
  const actions = (Array.isArray(values) ? values : [])
    .filter((value) => value && typeof value === 'object')
    .map((value) => ({
      ...value,
      action: text(value.action, 24).toUpperCase(),
      route: text(value.route, 24).toUpperCase(),
      feasible: (
        value.feasible === true
        && actionIsEligible(state.eligibility, value.action)
      ),
    }))
  return {
    schemaVersion: ACTION_VALUE_VECTOR_SCHEMA_VERSION,
    asOf: state.asOf,
    code: state.code,
    stateFingerprint: state.stateFingerprint || null,
    encoderVersion: text(encoderVersion, 120),
    routerVersion: text(routerVersion, 120),
    actions,
    positionOptimization:
      positionOptimization?.schemaVersion
        === 'position-optimization.v2'
        ? positionOptimization
        : null,
    evidenceCoverage: {
      complete: state.evidence?.complete === true,
      missingCount: state.evidence?.missing?.length || 0,
    },
  }
}

export function isActionValueVector(value) {
  return (
    value?.schemaVersion === ACTION_VALUE_VECTOR_SCHEMA_VERSION
    && /^\d{6}$/.test(String(value.code || ''))
    && finite(value.asOf) > 0
    && Array.isArray(value.actions)
    && value.actions.every((action) => (
      typeof action.action === 'string'
      && typeof action.feasible === 'boolean'
      && (
        action.expectedNetR == null
        || finite(action.expectedNetR) != null
      )
    ))
  )
}
