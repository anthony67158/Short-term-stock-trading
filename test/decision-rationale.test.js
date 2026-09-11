import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDecisionRationale,
} from '../shared/decisionRationale.js'

function scoredPlan(route, entry, expectedNetR) {
  return {
    route,
    entryPlan: {
      price: entry,
      trigger: route === 'PULLBACK'
        ? '回踩MA20附近支撑后重新站稳'
        : route === 'BREAKOUT'
          ? '放量突破近期高点并保持承接'
          : '现价保持在分时均价上方',
    },
    exitPlan: {
      hardStopPrice: +(entry - 2.6).toFixed(2),
      takeProfitPrice: +(entry + 4.8).toFixed(2),
    },
    riskReward: 1.85,
    opportunityScore: {
      pFill: route === 'PULLBACK' ? 0.42 : 0.2,
      pWinGivenFill: route === 'PULLBACK' ? 0.58 : 0.35,
      expectedNetR,
      expectedShortfall10: -1.2,
    },
  }
}

test('买入依据明确价格来源、路径比较和手数上限', () => {
  const plans = [
    scoredPlan('IMMEDIATE', 55.39, -0.21),
    scoredPlan('PULLBACK', 53.8, 0.18),
    scoredPlan('BREAKOUT', 56.1, 0.07),
  ]
  const result = buildDecisionRationale({
    advice: {
      selectedDecisionPlan: plans[1],
      decisionPaths: plans,
      actionValues: {
        actions: [{
          action: 'BUY',
          route: 'PULLBACK',
          feasible: true,
          actionUtilityR: 0.076,
        }],
      },
    },
    decisionPlan: {
      mode: 'buy_advice',
      action: 'BUY',
      actionability: 'READY',
      prices: {
        current: 55.39,
        reference: 55.39,
        stop: 51.2,
        target: 58.6,
      },
      quantity: {
        lots: 2,
        requestedLots: 0,
        riskLimitedLots: 3,
        affordableLots: 5,
      },
      risk: {
        maxLossAmount: 1200,
        estimatedLossPerLot: 380,
      },
      costs: {
        estimatedNetAmount: 10780,
      },
    },
  })

  assert.equal(result.schemaVersion, 'decision-rationale.v1')
  assert.equal(result.context, 'ENTRY')
  assert.equal(result.price.selectedRoute, 'PULLBACK')
  assert.equal(result.price.routeLabel, '回踩确认')
  assert.equal(result.price.referencePrice, 53.8)
  assert.equal(result.price.currentPrice, 55.39)
  assert.match(result.price.explanation, /MA20/)
  assert.match(result.price.modelBoundary, /模型只评估.*不直接生成价格/)
  assert.equal(result.pathComparison.length, 3)
  assert.equal(
    result.pathComparison.filter((item) => item.selected).length,
    1,
  )
  assert.equal(result.quantity.lots, 2)
  assert.match(result.quantity.explanation, /风险预算最多3手/)
  assert.match(result.quantity.explanation, /现金与仓位最多5手/)
  assert.match(result.quantity.explanation, /单手止损约380元/)
  assert.match(result.quantity.explanation, /本笔风险上限1200元/)
})

test('持仓依据使用持有减仓退出价值且不输出买入成交概率', () => {
  const selected = scoredPlan('IMMEDIATE', 55.39, -0.475505)
  const result = buildDecisionRationale({
    advice: {
      selectedDecisionPlan: selected,
      decisionPaths: [selected],
      actionValues: {
        actions: [
          {
            action: 'HOLD',
            route: 'IMMEDIATE',
            feasible: true,
            actionUtilityR: -0.475505,
          },
          {
            action: 'REDUCE',
            route: 'IMMEDIATE',
            feasible: true,
            actionUtilityR: 0.31,
          },
          {
            action: 'EXIT',
            route: 'IMMEDIATE',
            feasible: true,
            actionUtilityR: 0.82,
          },
        ],
      },
    },
    decisionPlan: {
      mode: 'hold_advice',
      action: 'EXIT',
      actionability: 'CONDITIONAL',
      prices: {
        current: 55.39,
        reference: 55.39,
        stop: 52,
        target: 58.6,
      },
      quantity: {
        lots: 2,
        holdingLots: 2,
        remainingLots: 0,
        sellableLots: 2,
      },
      risk: {},
      costs: {},
    },
  })

  assert.equal(result.context, 'POSITION')
  assert.equal(result.pathComparison.length, 0)
  assert.deepEqual(
    result.actionComparison.map((item) => item.label),
    ['继续持有', '减仓', '退出'],
  )
  assert.match(result.actionComparison[0].explanation, /预计价值.*-0\.48/)
  assert.match(result.actionComparison[2].explanation, /相对继续持有改善.*0\.82/)
  assert.match(result.quantity.explanation, /持有2手/)
  assert.match(result.quantity.explanation, /今日可卖2手/)
  assert.match(result.quantity.explanation, /退出2手/)
  assert.match(result.modelBoundary, /不是独立训练的卖出概率/)
  assert.doesNotMatch(JSON.stringify(result), /成交概率|pFill/)
})

test('未持仓观望仍展示候选价格路径而不是持仓动作', () => {
  const selected = scoredPlan('BREAKOUT', 56.1, -0.08)
  const result = buildDecisionRationale({
    advice: {
      selectedDecisionPlan: selected,
      decisionPaths: [selected],
      actionValues: {
        actions: [{
          action: 'BUY',
          route: 'BREAKOUT',
          feasible: true,
          actionUtilityR: -0.016,
        }],
      },
    },
    decisionPlan: {
      mode: 'buy_advice',
      action: 'WATCH',
      actionability: 'WATCH',
      prices: {
        current: 55.39,
        reference: 56.1,
        stop: 53.5,
        target: 60.9,
      },
      quantity: { lots: 0 },
      entryBudget: { lots: 0 },
      risk: {},
      costs: {},
    },
  })

  assert.equal(result.context, 'ENTRY')
  assert.equal(result.pathComparison.length, 1)
  assert.equal(result.actionComparison.length, 0)
  assert.match(result.summary, /突破确认候选价56\.10元/)
  assert.match(result.quantity.explanation, /当前为0手/)
  assert.match(
    result.quantity.explanation,
    /该价格路径扣除费用后的平均结果不为正/,
  )
})
