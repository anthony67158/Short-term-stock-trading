export const DECISION_ENGINE_ID = 'MULTI_TASK'

export function isDecisionEngineSource(source) {
  return String(source?.engine || '') === DECISION_ENGINE_ID
}

export function isDecisionEngineAdvice(advice) {
  return isDecisionEngineSource(advice?.decisionSource)
}

export function decisionEngineId(advice) {
  return isDecisionEngineAdvice(advice)
    ? DECISION_ENGINE_ID
    : null
}
