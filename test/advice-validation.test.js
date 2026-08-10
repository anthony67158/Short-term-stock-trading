import test from 'node:test'
import assert from 'node:assert/strict'

import { reconcileAdviceNumbers } from '../shared/adviceValidation.js'

test('买入建议按现金上限裁剪手数并重算金额与风险收益', () => {
  const { result, issues } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: { account: { cash: 2500 }, todayQuote: { price: 10 } },
    result: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQty: 5,
      planAmount: 500,
      riskAmount: '瞎算',
      expReturn: '瞎算',
    },
  })

  assert.equal(result.planQty, 2)
  assert.equal(result.planQtyNum, 2)
  assert.equal(result.planAmount, 2000)
  assert.match(result.riskAmount, /200/)
  assert.match(result.expReturn, /400/)
  assert.equal(issues.includes('买入手数超过可用资金'), true)
})

test('买入价格关系非法时降级观望而不是编造修正价', () => {
  const { result, valid } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: { account: { cash: 100000 } },
    result: {
      action: '立即买入',
      tier: 'now',
      buyPrice: 10,
      stopPrice: 10.5,
      targetPrice: 9.5,
      planQty: 3,
      planAmount: 3000,
    },
  })

  assert.equal(valid, false)
  assert.equal(result.action, '观望')
  assert.equal(result.tier, 'wait')
  assert.equal(result.planQty, 0)
  assert.equal(result.planAmount, 0)
  assert.equal(result.buyPrice, null)
})

test('减仓建议不超过可卖手数并正确表达止损锁盈', () => {
  const { result } = reconcileAdviceNumbers({
    mode: 'hold_advice',
    payload: {
      holdCost: 10,
      holdQty: 3,
      sellableTodayQty: 2,
      account: { cash: 5000 },
    },
    result: {
      action: '减仓',
      opQty: '减仓5手',
      reducePrice: 12,
      stopPrice: 11,
      targetPrice: 13,
      opAmount: '100元',
      riskAmount: '-300元',
      newCost: 8,
      actionPlan: '反弹到12元减仓5手，回笼6000元',
    },
  })

  assert.equal(result.opQty, '减仓2手')
  assert.equal(result.opAmount, 2400)
  assert.equal(result.newCost, 10)
  assert.match(result.riskAmount, /仍盈利300元/)
  assert.match(result.actionPlan, /减仓2手/)
  assert.match(result.actionPlan, /回笼2400元/)
})

test('现金不足一手时买入建议降级为观望', () => {
  const { result } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: { account: { cash: 500 } },
    result: {
      action: '立即买入',
      tier: 'now',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQty: 1,
    },
  })

  assert.equal(result.action, '观望')
  assert.equal(result.planQty, 0)
  assert.equal(result.planAmount, 0)
})

test('今日无可卖手数时减仓建议降级为持有', () => {
  const { result } = reconcileAdviceNumbers({
    mode: 'hold_advice',
    payload: { holdCost: 10, holdQty: 3, sellableTodayQty: 0 },
    result: {
      action: '减仓',
      opQty: '减仓2手',
      reducePrice: 12,
      stopPrice: 9,
      targetPrice: 13,
      actionPlan: '减仓2手，回笼2400元',
    },
  })

  assert.equal(result.action, '持有')
  assert.equal(result.opQty, '无需操作')
  assert.equal(result.opAmount, 0)
  assert.match(result.actionPlan, /今日无可卖仓位/)
})
