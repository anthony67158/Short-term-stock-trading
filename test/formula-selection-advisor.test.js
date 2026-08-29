import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  buildUserPrompt,
  deepAdvisorFacts,
  fastAdvisorFacts,
} from '../api/_ai_prompts.js'

const aiSource = fs.readFileSync(
  new URL('../api/ai.js', import.meta.url),
  'utf8',
)

const formulaReference = {
  schemaVersion: 'formula-evidence.v1',
  formulaId: 'INTRADAY_VWAP_PULLBACK',
  positionMode: 'UNOWNED',
  action: 'WATCH_BUY',
  primaryPrice: 10,
  stopPrice: 9.5,
  targetPrice: 10.9,
  riskReward: 1.8,
  validationState: 'OBSERVE_ONLY',
  effectiveWeight: 0.05,
  role: 'SECONDARY_PRICE_REFERENCE',
  canUpgradeAction: false,
  canForceRiskReduction: false,
  conflicts: [],
}

test('军师事实合同只投影公式价位允许字段', () => {
  const deep = deepAdvisorFacts({
    code: '600001',
    name: '测试',
    formulaPriceReference: {
      ...formulaReference,
      internalDebug: '不可进入模型',
    },
  })
  const fast = fastAdvisorFacts({
    code: '600001',
    name: '测试',
    formulaPriceReference: formulaReference,
  })

  assert.equal(deep.formulaPriceReference.effectiveWeight, 0.05)
  assert.equal(fast.formulaPriceReference.canUpgradeAction, false)
  assert.equal(deep.formulaPriceReference.internalDebug, undefined)
})

test('军师提示词明确公式只能作为次级价位参考', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600001',
    name: '测试',
    formulaPriceReference: formulaReference,
  })

  assert.match(prompt, /公式价位/)
  assert.match(prompt, /不能单独升级/)
  assert.match(prompt, /5%/)
})

test('AI入口删除客户端公式证据并由服务端重新计算', () => {
  assert.match(aiSource, /delete payload\.formulaPriceReference/)
  assert.match(aiSource, /buildFormulaEvidenceReference/)
  assert.match(aiSource, /payload\.formulaPriceReference =/)
})
