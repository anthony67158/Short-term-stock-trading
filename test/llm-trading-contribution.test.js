import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildLLMTradingContribution,
  LLM_TRADING_CONTRIBUTION_SCHEMA_VERSION,
} from '../shared/llmTradingContribution.js'

test('LLM贡献审计只记录实际产出的解释与证伪内容', () => {
  const audit = buildLLMTradingContribution({
    mode: 'buy_advice',
    role: 'advisor',
    model: 'advisor-model',
    result: {
      newsNote: '公告催化仍在有效期内',
      bearCase: '放量冲高回落说明承接不足',
      invalidation: '跌破10元后本次逻辑失效',
    },
    payload: {},
    searchReference: { provider: 'doubao-global' },
  })

  assert.equal(
    audit.schemaVersion,
    LLM_TRADING_CONTRIBUTION_SCHEMA_VERSION,
  )
  assert.deepEqual(
    audit.contributions.map((item) => item.key),
    [
      'CATALYST_INTERPRETATION',
      'COUNTER_CASE',
      'INVALIDATION',
    ],
  )
  assert.equal(audit.evidenceAugmentation.webSearchUsed, true)
  assert.equal(audit.authority.canIncreaseRisk, false)
  assert.equal(audit.authority.price, 'SERVER')
})

test('触价复核明确记录Judge贡献但不授予风险放大权限', () => {
  const audit = buildLLMTradingContribution({
    mode: 'review',
    role: 'review',
    result: {
      reviewDecision: {
        reason: '触价后量能没有延续，本次放弃',
      },
      invalidation: '本次价格触发已经完成',
      decisionPlan: {
        schemaVersion: 'decision-plan.v1',
        actionability: 'WATCH',
      },
      serverAdjust: '服务端已改为不操作',
    },
    payload: {
      reviewEvent: { kind: 'price-review' },
    },
  })

  assert.equal(audit.scope, 'TRIGGER_REVIEW')
  assert.ok(
    audit.contributions.some(
      (item) => item.key === 'TRIGGER_REVIEW',
    ),
  )
  assert.equal(audit.serverValidation.actionability, 'WATCH')
  assert.equal(audit.serverValidation.policyAdjusted, true)
  assert.equal(audit.authority.canIncreaseRisk, false)
})
