import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceEntryMatchesMode,
  buildAdviceDecisionContext,
  inferAdviceEntryMode,
} from '../shared/adviceModeContext.js'

test('买入前的观望建议不能在建仓后冒充持仓建议', () => {
  const entry = {
    at: 100,
    advice: {
      action: '观望',
      tier: 'wait',
      buyPrice: null,
      planQty: 0,
    },
  }

  assert.equal(inferAdviceEntryMode(entry), 'buy_advice')
  assert.equal(adviceEntryMatchesMode(entry, 'hold_advice'), false)
  assert.equal(adviceEntryMatchesMode(entry, 'buy_advice'), true)
})

test('持仓建议缓存明确记录模式后只能用于持仓场景', () => {
  const entry = {
    mode: 'hold_advice',
    advice: {
      action: '持有',
      pnlNote: '现价高于成本',
    },
  }

  assert.equal(inferAdviceEntryMode(entry), 'hold_advice')
  assert.equal(adviceEntryMatchesMode(entry, 'hold_advice'), true)
  assert.equal(adviceEntryMatchesMode(entry, 'buy_advice'), false)
})

test('持仓建议生成结果固化本次使用的持仓和资金快照', () => {
  const context = buildAdviceDecisionContext('hold_advice', {
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

  assert.deepEqual(context, {
    mode: 'hold_advice',
    holdCost: 10.25,
    holdQty: 3,
    sellableTodayQty: 2,
    cash: 18600,
    totalAssets: 52000,
    position: 64.2,
    stockWeight: 18.5,
  })
})
