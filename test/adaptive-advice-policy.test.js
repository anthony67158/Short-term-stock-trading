import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyAdaptiveAdvicePolicy,
} from '../shared/adaptiveAdvicePolicy.js'

function decision(route = 'IMMEDIATE', tier = 'ATTACK') {
  return {
    selected: {
      route,
      riskReward: 1.42,
      entryPlan: {
        price: route === 'PULLBACK' ? 9.8 : 10,
        trigger: route === 'PULLBACK'
          ? '回踩9.80元后重新站稳'
          : '现价保持承接',
      },
      exitPlan: {
        hardStopPrice: 9.5,
        takeProfitPrice: 10.71,
      },
      adaptive: {
        tier,
        playbook: {
          label: route === 'PULLBACK' ? '核心回踩' : '主升突破',
          evidence: ['板块扩散', '资金承接'],
        },
        cautions: [],
      },
    },
  }
}

test('server action value overrides a vague model answer with executable buy', () => {
  const result = applyAdaptiveAdvicePolicy({
    mode: 'buy_advice',
    result: { action: '观望', planQty: 0 },
    payload: {
      todayQuote: { live: true },
      adaptiveAction: decision(),
    },
  })

  assert.equal(result.action, '立即买入')
  assert.equal(result.buyPrice, 10)
  assert.equal(result.planQty, 1)
  assert.match(result.actionPlan, /止损9.50元/)
})

test('pullback route remains a single conditional instruction', () => {
  const result = applyAdaptiveAdvicePolicy({
    mode: 'buy_advice',
    result: { action: '立即买入', planQty: 8 },
    payload: {
      todayQuote: { live: true },
      adaptiveAction: decision('PULLBACK'),
    },
  })

  assert.equal(result.action, '回调再买')
  assert.equal(result.planQty, 0)
  assert.equal(result.pullbackWatchPrice, 9.8)
  assert.equal(result.breakoutWatchPrice, null)
})

test('triggered review is not replaced with a newly generated route', () => {
  const result = applyAdaptiveAdvicePolicy({
    mode: 'buy_advice',
    result: { action: '观望', reviewDecision: { terminal: true } },
    payload: {
      reviewEvent: { kind: 'price-review' },
      adaptiveAction: decision(),
    },
  })

  assert.equal(result.action, '观望')
  assert.equal(result.reviewDecision.terminal, true)
})
