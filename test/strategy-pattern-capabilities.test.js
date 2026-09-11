import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveStrategyPatternCapabilities,
  strategyPatternAnalysisEnabled,
  strategyPatternCapabilitiesOf,
} from '../shared/strategyPatternCapabilities.js'

test('五策略能力默认全部关闭', () => {
  const capabilities = resolveStrategyPatternCapabilities({})

  assert.equal(strategyPatternAnalysisEnabled(capabilities), false)
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(capabilities)
        .filter(([key]) => key !== 'schemaVersion'),
    ),
    {
      recall: false,
      priceAnchors: false,
      confirmation: false,
      display: false,
      playbookBlend: false,
      modelFeatures: false,
    },
  )
})

test('产品能力可独立启用而不开放打法加权和模型特征', () => {
  const capabilities = resolveStrategyPatternCapabilities({
    STRATEGY_PATTERN_RECALL: 'ACTIVE',
    STRATEGY_PATTERN_PRICE_ANCHORS: 'ACTIVE',
    STRATEGY_PATTERN_CONFIRMATION: 'ACTIVE',
    STRATEGY_PATTERN_DISPLAY: 'ACTIVE',
    STRATEGY_PATTERN_PLAYBOOK_BLEND: 'RESEARCH',
    STRATEGY_PATTERN_MODEL_FEATURES: 'RESEARCH',
  })

  assert.equal(capabilities.recall, true)
  assert.equal(capabilities.priceAnchors, true)
  assert.equal(capabilities.confirmation, true)
  assert.equal(capabilities.display, true)
  assert.equal(capabilities.playbookBlend, false)
  assert.equal(capabilities.modelFeatures, false)
})

test('旧总开关只用于兼容已有调用方', () => {
  const resolved = resolveStrategyPatternCapabilities({
    STRATEGY_PATTERN_POLICY: 'ACTIVE',
  })
  const candidate = strategyPatternCapabilitiesOf({
    strategyPatternPolicy: 'ACTIVE',
  })

  assert.equal(resolved.recall, true)
  assert.equal(resolved.playbookBlend, true)
  assert.equal(candidate.priceAnchors, true)
  assert.equal(candidate.confirmation, true)
})
