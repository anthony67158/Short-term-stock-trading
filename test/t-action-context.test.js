import test from 'node:test'
import assert from 'node:assert/strict'

import { buildUserPrompt } from '../api/_ai_prompts.js'
import {
  buildTActionContext,
} from '../shared/portfolioAccounting.js'
import {
  applyTActionAdvicePolicy,
} from '../shared/tAdvicePolicy.js'

// 固定在北京时间交易日盘中，避免测试运行于午夜前后时跨日。
const DAY = Date.parse('2026-08-19T02:00:00.000Z')
const holding = (qty, flows) => [{
  id: 'holding-1',
  code: '600000',
  name: '浦发银行',
  qty,
  buyPrice: 10,
  buyFee: 5,
  buyAt: DAY - 86400000,
  tFlows: flows,
}]

test('做T只买未卖时状态要求给出第二腿卖出价', () => {
  const context = buildTActionContext(
    holding(2, [{
      id: 'buy-leg',
      side: 'buy',
      price: 9.8,
      qty: 1,
      fee: 5,
      at: DAY,
    }]),
    [],
    '600000',
    DAY,
  )

  assert.equal(context.stage, 'buy_wait_sell')
  assert.equal(context.pendingQty, 1)
  assert.equal(context.firstLegPrice, 9.8)
  assert.equal(context.sellableTodayQty, 2)

  const advice = applyTActionAdvicePolicy({
    mode: 't_advice',
    payload: { tContext: context, nextTradeDay: '2026-08-20(周四)' },
    result: {
      dir: 'reverse',
      leg2Price: 10.25,
      resistance: 10.3,
      suggestQty: 2,
    },
  })
  assert.equal(advice.dir, 'positive')
  assert.equal(advice.leg1Price, 9.8)
  assert.equal(advice.leg2Price, 10.25)
  assert.equal(advice.suggestQty, 1)
  assert.equal(advice.nextSide, 'sell')
  assert.equal(advice.nextPrice, 10.25)
  assert.match(advice.actionPlan, /卖出1手/)
  assert.match(advice.actionPlan, /10\.25元/)
})

test('做T只卖未买时状态要求给出接回价', () => {
  const context = buildTActionContext(
    holding(2, [{
      id: 'sell-leg',
      side: 'sell',
      price: 10.8,
      qty: 1,
      fee: 6,
      at: DAY,
    }]),
    [],
    '600000',
    DAY,
  )

  assert.equal(context.stage, 'sell_wait_buy')
  assert.equal(context.pendingQty, 1)
  assert.equal(context.firstLegPrice, 10.8)

  const advice = applyTActionAdvicePolicy({
    mode: 't_advice',
    payload: { tContext: context },
    result: {
      dir: 'positive',
      leg2Price: 10.15,
      support: 10.1,
      suggestQty: 2,
    },
  })
  assert.equal(advice.dir, 'reverse')
  assert.equal(advice.leg1Price, 10.8)
  assert.equal(advice.leg2Price, 10.15)
  assert.equal(advice.suggestQty, 1)
  assert.equal(advice.nextSide, 'buy')
  assert.equal(advice.nextPrice, 10.15)
  assert.match(advice.actionPlan, /接回1手/)
  assert.match(advice.actionPlan, /10\.15元/)
})

test('做T完成且当前仓位全被T+1锁定时禁止当天继续卖', () => {
  const context = buildTActionContext(
    holding(1, [{
      id: 'buy-leg',
      side: 'buy',
      price: 9.8,
      qty: 1,
      fee: 5,
      at: DAY,
    }, {
      id: 'sell-leg',
      side: 'sell',
      price: 10.4,
      qty: 1,
      fee: 6,
      at: DAY + 60000,
    }]),
    [],
    '600000',
    DAY + 120000,
  )

  assert.equal(context.stage, 'completed_locked')
  assert.equal(context.completedTodayCount, 1)
  assert.equal(context.lockedTodayQty, 1)
  assert.equal(context.sellableTodayQty, 0)

  const advice = applyTActionAdvicePolicy({
    mode: 'hold_advice',
    payload: {
      tContext: context,
      nextTradeDay: '2026-08-20(周四)',
    },
    result: {
      action: '减仓',
      opQty: '减仓1手',
      actionPlan: '现在卖出1手',
    },
  })
  assert.equal(advice.action, '持有')
  assert.equal(advice.opQty, '今日不可卖')
  assert.match(advice.actionPlan, /本轮做T已完成/)
  assert.match(advice.actionPlan, /2026-08-20/)
})

test('做T完成后如仍有老仓可卖会精确区分锁定与可卖手数', () => {
  const context = buildTActionContext(
    holding(2, [{
      id: 'buy-leg',
      side: 'buy',
      price: 9.8,
      qty: 1,
      fee: 5,
      at: DAY,
    }, {
      id: 'sell-leg',
      side: 'sell',
      price: 10.4,
      qty: 1,
      fee: 6,
      at: DAY + 60000,
    }]),
    [],
    '600000',
    DAY + 120000,
  )

  assert.equal(context.stage, 'completed')
  assert.equal(context.lockedTodayQty, 1)
  assert.equal(context.sellableTodayQty, 1)
})

test('三类军师提示词都明确消费做T阶段而不是重新猜测动作', () => {
  const buyPending = {
    stage: 'buy_wait_sell',
    pendingQty: 1,
    firstLegPrice: 9.8,
    sellableTodayQty: 2,
  }
  const sellPending = {
    stage: 'sell_wait_buy',
    pendingQty: 1,
    firstLegPrice: 10.8,
    sellableTodayQty: 1,
  }
  const completed = {
    stage: 'completed_locked',
    completedTodayCount: 1,
    lockedTodayQty: 1,
    sellableTodayQty: 0,
  }

  assert.match(
    buildUserPrompt('t_advice', { code: '600000', tContext: buyPending }),
    /第一腿已买.*第二腿卖出价/,
  )
  assert.match(
    buildUserPrompt('hold_advice', { code: '600000', tContext: sellPending }),
    /第一腿已卖.*接回价/,
  )
  assert.match(
    buildUserPrompt('review', {
      code: '600000',
      hold: true,
      tContext: completed,
      nextTradeDay: '2026-08-20(周四)',
    }),
    /本轮做T已完成.*今日可卖0手/,
  )
})
