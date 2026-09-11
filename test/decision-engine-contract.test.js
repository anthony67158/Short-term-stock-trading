import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildActionEligibility,
} from '../shared/actionEligibility.js'
import {
  actionValueFromOpportunityScore,
  buildActionValueVector,
  isActionValueVector,
} from '../shared/actionValueContract.js'
import {
  buildDecisionState,
  isDecisionState,
} from '../shared/decisionStateContract.js'

function path(route = 'IMMEDIATE') {
  return {
    route,
    entryPlan: { price: 10 },
    exitPlan: {
      hardStopPrice: 9.5,
      takeProfitPrice: 11,
    },
    riskReward: 2,
  }
}

function score(expectedNetR = 0.2) {
  return {
    state: 'READY',
    usagePolicy: 'DIRECT',
    serverVerified: true,
    pFill: 0.8,
    pWinGivenFill: 0.6,
    expectedNetR,
    netRLowerBound: 0.04,
    expectedShortfall10: -0.5,
    modelVersion: 'decision-model.test',
  }
}

test('未持仓决策状态只开放等待与买入', () => {
  const state = buildDecisionState({
    code: '600001',
    asOf: 1,
    quote: { price: 10, live: true },
    position: { totalLots: 0 },
    account: { complete: true, riskIncreaseAllowed: true },
    evidence: { complete: true },
    model: { ready: true },
    paths: [path()],
  })

  assert.equal(isDecisionState(state), true)
  assert.deepEqual(state.eligibility.actions, ['WAIT', 'BUY'])
  assert.equal(state.paths.length, 1)
})

test('持仓硬止损绕过模型并只开放确定性退出', () => {
  const sellable = buildActionEligibility({
    quote: { price: 9.4, live: true },
    position: {
      totalLots: 3,
      sellableLots: 2,
      hardStopPrice: 9.5,
    },
    model: { ready: false },
  })
  const locked = buildActionEligibility({
    quote: { price: 9.4, live: true },
    position: {
      totalLots: 3,
      sellableLots: 0,
      hardStopPrice: 9.5,
    },
    model: { ready: false },
  })

  assert.deepEqual(sellable.actions, ['EXIT'])
  assert.deepEqual(locked.actions, ['HOLD_LOCKED'])
})

test('模型或证据缺失时禁止新增风险但保留持仓退出', () => {
  const eligibility = buildActionEligibility({
    quote: { price: 10, live: true },
    position: { totalLots: 2, sellableLots: 2 },
    evidence: { complete: false },
    model: { ready: false },
  })

  assert.equal(eligibility.actions.includes('ADD'), false)
  assert.deepEqual(
    eligibility.actions,
    ['HOLD', 'REDUCE', 'EXIT'],
  )
})

test('旧机会评分可无损映射为模块化动作价值', () => {
  const state = buildDecisionState({
    code: '600001',
    asOf: 1,
    quote: { price: 10, live: true },
    position: { totalLots: 0 },
    account: { complete: true },
    evidence: { complete: true },
    model: { ready: true },
    paths: [path()],
  })
  const action = actionValueFromOpportunityScore({
    action: 'BUY',
    route: 'IMMEDIATE',
    score: score(),
    eligibility: state.eligibility,
  })
  const vector = buildActionValueVector({
    state,
    values: [action],
  })

  assert.equal(isActionValueVector(vector), true)
  assert.equal(vector.actions[0].expectedNetR, 0.2)
  assert.equal(vector.actions[0].feasible, true)
  assert.equal(vector.actions[0].ready, true)
})

test('动作价值合同拒绝路由到非法动作', () => {
  const state = buildDecisionState({
    code: '600001',
    asOf: 1,
    quote: { price: 10, live: true },
    position: { totalLots: 0 },
    account: { complete: true },
    evidence: { complete: true },
    model: { ready: true },
    paths: [path()],
  })
  const action = actionValueFromOpportunityScore({
    action: 'EXIT',
    route: 'IMMEDIATE',
    score: score(-0.2),
    eligibility: state.eligibility,
  })

  assert.equal(action.feasible, false)
})
