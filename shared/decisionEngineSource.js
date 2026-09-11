export const DECISION_ENGINE_ID = 'MULTI_TASK'
export const LEGACY_DECISION_ENGINE_ID = 'V3'

export function isDecisionEngineSource(source) {
  return [
    DECISION_ENGINE_ID,
    LEGACY_DECISION_ENGINE_ID,
  ].includes(String(source?.engine || ''))
}

export function isDecisionEngineAdvice(advice) {
  return isDecisionEngineSource(advice?.decisionSource)
}

export function decisionEngineId(advice) {
  return isDecisionEngineAdvice(advice)
    ? DECISION_ENGINE_ID
    : null
}
