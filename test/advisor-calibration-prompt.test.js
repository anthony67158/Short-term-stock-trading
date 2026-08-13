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
    previousAdvice: {
      planId: 'plan-600000',
      revision: 2,
      thesisVersion: 1,
      action: '持有',
      actionPlan: '守住9.80元继续持有',
      stopPrice: 9.8,
      targetPrice: 10.8,
      invalidation: '收盘跌破9.80元',
    },
  }, '')

  assert.match(prompt, /低命中不等于一律更保守/)
  assert.match(prompt, /减仓\/清仓 0%\(8次/)
  assert.match(prompt, /偏防守/)
  assert.match(prompt, /量化模型·价格参考因子/)
  assert.match(prompt, /综合分72/)
  assert.match(prompt, /上一版权威主计划/)
  assert.match(prompt, /无客观失效证据不得反转/)
  assert.match(prompt, /plan-600000/)
  assert.match(prompt, /知行合一·字段职责/)
  assert.match(prompt, /系统会在返回后统一生成知行合一交易契约/)
  assert.match(prompt, /输出格式·简洁去重/)
  assert.match(prompt, /同一事实只写一次/)
  assert.match(prompt, /actionPlan.*80字/)
  assert.doesNotMatch(prompt, /最终JSON必须额外给出 knowledgeActionPlan/)
  assert.doesNotMatch(prompt, /说明你过去偏乐观\/追高/)
})

test('持仓建议明确列出本次决策使用的持仓和可用资金快照', () => {
  const prompt = buildUserPrompt('hold_advice', {
    code: '600000',
    holdCost: 10.25,
    holdQty: 3,
    sellableTodayQty: 2,
    account: {
      cash: 18600,
      totalAssets: 52000,
      position: 64.2,
      stockWeight: 18.5,
    },
  })

  assert.match(prompt, /本次决策账户快照/)
  assert.match(prompt, /持仓3手/)
  assert.match(prompt, /成本10\.25元/)
  assert.match(prompt, /可用资金18600元/)
  assert.match(prompt, /单票占比18\.5%/)
  assert.match(prompt, /positionNote.*可用资金/)
})
