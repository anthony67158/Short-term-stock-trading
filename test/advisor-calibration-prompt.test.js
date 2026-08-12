import test from 'node:test'
import assert from 'node:assert/strict'

import { buildUserPrompt } from '../api/_ai_prompts.js'

test('军师低命中校准按动作方向纠偏而不是一律变得更保守', () => {
  const prompt = buildUserPrompt('hold_advice', {
    code: '600000',
    name: '测试股份',
    advisorTrack: {
      overallWinRate: 27,
      overallTotal: 11,
      overallAvgPct: 3.05,
      modeWinRate: 0,
      modeTotal: 8,
      actionScores: [
        { kind: 'bear', label: '减仓/清仓', winRate: 0, total: 8, avgPct: 1.34 },
      ],
    },
    quant: {
      score: 72,
      bias: '偏多',
      forecast: {
        direction: '看涨',
        upProb: 64,
        expRet: 2.1,
        targetLow: 10.2,
        targetHigh: 10.8,
      },
    },
  }, '')

  assert.match(prompt, /低命中不等于一律更保守/)
  assert.match(prompt, /减仓\/清仓 0%\(8次/)
  assert.match(prompt, /偏防守/)
  assert.match(prompt, /量化模型·价格参考因子/)
  assert.match(prompt, /综合分72/)
  assert.doesNotMatch(prompt, /说明你过去偏乐观\/追高/)
})
