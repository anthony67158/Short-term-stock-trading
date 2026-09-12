import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNextSessionPlan,
} from '../shared/nextSessionPlan.js'

const now = Date.parse('2026-09-11T07:50:00Z')

function holdingAdvice(overrides = {}) {
  return {
    decisionSource: {
      engine: 'MULTI_TASK',
      state: 'READY',
    },
    actionValues: {
      actions: [{
        action: 'HOLD',
        feasible: true,
        actionUtilityR: 0.18,
      }],
    },
    decisionPlan: {
      decisionId: 'close-hold-1',
      mode: 'hold_advice',
      action: 'HOLD',
      actionability: 'WATCH',
      prices: {
        current: 51.13,
        stop: 48.85,
        target: 56.06,
      },
      quantity: {
        lots: 0,
        holdingLots: 4,
        sellableLots: 4,
      },
      risk: {
        modelPriceRiskPerShare: 2.28,
      },
      invalidation: '跌破关键支撑或账户持仓变化后重新评估',
      validUntil: '2026-09-14T07:00:00.000Z',
    },
    ...overrides,
  }
}

test('完整收盘持仓决策生成隔夜结论、三情景与金额风险', () => {
  const result = buildNextSessionPlan({
    advice: holdingAdvice(),
    closePrice: 51.13,
    holdingLots: 4,
    sellableLots: 4,
    now,
  })

  assert.equal(result.schemaVersion, 'next-session-plan.v1')
  assert.equal(result.state, 'READY')
  assert.equal(result.conclusion.action, 'HOLD')
  assert.equal(result.conclusion.lots, 0)
  assert.match(result.conclusion.headline, /继续持有4手/)
  assert.equal(result.scenarios.length, 3)
  assert.match(result.scenarios[0].condition, /48\.85/)
  assert.match(result.scenarios[1].condition, /48\.85.*56\.06/)
  assert.match(result.scenarios[2].condition, /56\.06/)
  assert.equal(result.risk.lossToStopAmount, 912)
  assert.equal(result.risk.actionValueAmount, 164)
  assert.match(result.risk.note, /跳空/)
})

test('收盘退出决策明确次日目标手数但不冒充收盘价委托', () => {
  const advice = holdingAdvice()
  advice.decisionPlan = {
    ...advice.decisionPlan,
    action: 'EXIT',
    actionability: 'CONDITIONAL',
    quantity: {
      lots: 0,
      requestedLots: 4,
      holdingLots: 4,
      sellableLots: 4,
    },
  }
  advice.actionValues.actions = [{
    action: 'EXIT',
    feasible: true,
    actionUtilityR: 0.32,
  }]

  const result = buildNextSessionPlan({
    advice,
    closePrice: 51.13,
    holdingLots: 4,
    sellableLots: 4,
    now,
  })

  assert.equal(result.state, 'READY')
  assert.equal(result.conclusion.action, 'EXIT')
  assert.equal(result.conclusion.lots, 4)
  assert.match(result.conclusion.headline, /优先复核清仓4手/)
  assert.match(result.scenarios[1].instruction, /复核仍支持清仓时/)
  assert.match(result.scenarios[1].instruction, /4手/)
  assert.doesNotMatch(result.scenarios[1].instruction, /按收盘价/)
})

test('关键结果不完整时收盘卡片判为无效且不展示半成品情景', () => {
  const advice = holdingAdvice()
  advice.decisionPlan = {
    ...advice.decisionPlan,
    prices: {
      current: 51.13,
      stop: 48.85,
      target: null,
    },
  }

  const result = buildNextSessionPlan({
    advice,
    closePrice: 51.13,
    holdingLots: 4,
    sellableLots: 4,
    now,
  })

  assert.equal(result.state, 'INVALID')
  assert.equal(result.conclusion.headline, '本轮收盘决策无效')
  assert.deepEqual(result.scenarios, [])
  assert.match(result.summary, /目标价/)
})
