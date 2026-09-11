export const STRATEGY_PATTERN_CAPABILITIES_VERSION =
  'strategy-pattern-capabilities.v1'

const CAPABILITY_ENV = Object.freeze({
  recall: 'STRATEGY_PATTERN_RECALL',
  priceAnchors: 'STRATEGY_PATTERN_PRICE_ANCHORS',
  confirmation: 'STRATEGY_PATTERN_CONFIRMATION',
  display: 'STRATEGY_PATTERN_DISPLAY',
  playbookBlend: 'STRATEGY_PATTERN_PLAYBOOK_BLEND',
  modelFeatures: 'STRATEGY_PATTERN_MODEL_FEATURES',
})

function active(value, fallback = false) {
  const normalized = String(value || '').trim().toUpperCase()
  if (normalized === 'ACTIVE') return true
  if (['RESEARCH', 'DISABLED', 'OFF', 'FALSE', '0'].includes(normalized)) {
    return false
  }
  return fallback
}

export function resolveStrategyPatternCapabilities(env = {}) {
  const legacyActive = active(env.STRATEGY_PATTERN_POLICY)
  const capabilities = Object.fromEntries(
    Object.entries(CAPABILITY_ENV).map(([key, envName]) => [
      key,
      active(env[envName], legacyActive),
    ]),
  )
  return {
    schemaVersion: STRATEGY_PATTERN_CAPABILITIES_VERSION,
    ...capabilities,
  }
}

export function strategyPatternCapabilitiesOf(candidate = {}) {
  const value = candidate?.strategyPatternCapabilities
  if (
    value?.schemaVersion === STRATEGY_PATTERN_CAPABILITIES_VERSION
  ) {
    return {
      schemaVersion: STRATEGY_PATTERN_CAPABILITIES_VERSION,
      ...Object.fromEntries(
        Object.keys(CAPABILITY_ENV).map((key) => [
          key,
          value[key] === true,
        ]),
      ),
    }
  }
  const legacyActive = candidate?.strategyPatternPolicy === 'ACTIVE'
  return {
    schemaVersion: STRATEGY_PATTERN_CAPABILITIES_VERSION,
    ...Object.fromEntries(
      Object.keys(CAPABILITY_ENV).map((key) => [key, legacyActive]),
    ),
  }
}

export function strategyPatternAnalysisEnabled(capabilities = {}) {
  return [
    'recall',
    'priceAnchors',
    'confirmation',
    'display',
    'playbookBlend',
    'modelFeatures',
  ].some((key) => capabilities[key] === true)
}
