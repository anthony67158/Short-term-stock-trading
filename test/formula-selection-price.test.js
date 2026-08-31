import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFormulaPriceDecision,
} from '../shared/formulaPriceEngine.js'

function matchedFormula(overrides = {}) {
  return {
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    name: '盘中回踩承接',
    matched: true,
    score: 88,
    validationState: 'OBSERVE_ONLY',
    priceType: 'PULLBACK_WATCH',
    anchors: {
      primary: 10,
      support: 10,
      resistance: 11,
      atr: 0.5,
      vwap: 10.05,
    },
    evidence: ['价格回踩承接'],
    blockers: [],
    ...overrides,
  }
}

test('未持仓股票只输出一条合法观察价和完整风险边界', () => {
  const result = buildFormulaPriceDecision({
    code: '600001',
    quote: { price: 10.2, limitDownPrice: 9, limitUpPrice: 11.2 },
    formulaMatches: [matchedFormula()],
    positionMode: 'UNOWNED',
    marketAllowsRisk: true,
    dataComplete: true,
    dataFresh: true,
    now: 1_000,
  })

  assert.equal(result.positionMode, 'UNOWNED')
  assert.equal(result.action, 'WATCH_BUY')
  assert.equal(result.primaryPrice, 10)
  assert.equal(result.priceType, 'PULLBACK_WATCH')
  assert.ok(result.stopPrice < result.primaryPrice)
  assert.ok(result.targetPrice > result.primaryPrice)
  assert.ok(result.riskReward >= 1.8)
  assert.equal(result.priceContractValid, true)
})

test('未持仓没有公式或赔率不足时不编造买入价格', () => {
  const noFormula = buildFormulaPriceDecision({
    code: '600001',
    quote: { price: 10.2 },
    formulaMatches: [],
    positionMode: 'UNOWNED',
    marketAllowsRisk: true,
    dataComplete: true,
    dataFresh: true,
  })
  assert.equal(noFormula.action, 'AVOID')
  assert.equal(noFormula.primaryPrice, null)

  const poorReward = buildFormulaPriceDecision({
    code: '600001',
    quote: { price: 10.2 },
    formulaMatches: [matchedFormula({
      anchors: {
        primary: 10,
        support: 10,
        resistance: 10.5,
        atr: 0.5,
        vwap: 10.05,
      },
    })],
    positionMode: 'UNOWNED',
    marketAllowsRisk: true,
    dataComplete: true,
    dataFresh: true,
  })
  assert.equal(poorReward.action, 'AVOID')
  assert.equal(poorReward.primaryPrice, null)
  assert.match(poorReward.blockers.join('；'), /盈亏比/)
})

test('突破观察使用ATR生成入场上方目标而不是沿用原压力', () => {
  const result = buildFormulaPriceDecision({
    code: '600001',
    quote: { price: 10, limitDownPrice: 9, limitUpPrice: 12 },
    formulaMatches: [matchedFormula({
      formulaId: 'CLOSE_SQUEEZE',
      name: '收盘蓄势突破',
      priceType: 'BREAKOUT_WATCH',
      anchors: {
        primary: 10.2,
        support: 9.8,
        resistance: 10.19,
        atr: 0.3,
      },
    })],
    positionMode: 'UNOWNED',
    marketAllowsRisk: true,
    dataComplete: true,
    dataFresh: true,
  })

  assert.equal(result.action, 'WATCH_BUY')
  assert.equal(result.primaryPrice, 10.2)
  assert.ok(result.stopPrice < result.primaryPrice)
  assert.ok(result.targetPrice > result.primaryPrice)
  assert.ok(result.riskReward >= 1.8)
})

test('持仓跌破硬止损时直接输出退出且T+1只延迟执行', () => {
  const result = buildFormulaPriceDecision({
    code: '600001',
    quote: { price: 9.4, limitDownPrice: 9, limitUpPrice: 11 },
    positionMode: 'HELD',
    holding: { qty: 2, cost: 10 },
    t1Status: { sellableQty: 0, lockedQty: 2 },
    technicals: {
      stopLoss: 9.5,
      support: 9.6,
      ma10: 9.8,
      resistance: 10.8,
      atr: 0.4,
      highestClose: 10.3,
    },
    dataComplete: true,
    dataFresh: true,
  })

  assert.equal(result.action, 'EXIT')
  assert.equal(result.primaryPrice, 9.5)
  assert.equal(result.priceType, 'HARD_STOP')
  assert.equal(result.hardStopTriggered, true)
  assert.equal(result.executionState, 'T1_LOCKED')
  assert.equal(result.sellableQty, 0)
})

test('持仓未触发退出时只返回一个持有风险边界', () => {
  const result = buildFormulaPriceDecision({
    code: '600001',
    quote: { price: 10.5 },
    positionMode: 'HELD',
    holding: { qty: 3, cost: 9.8 },
    t1Status: { sellableQty: 2, lockedQty: 1 },
    technicals: {
      stopLoss: 9.4,
      support: 9.8,
      ma10: 10,
      resistance: 11.2,
      atr: 0.4,
      highestClose: 10.7,
    },
    fund: {
      mainNetYi: 0.1,
      retailNetYi: -0.05,
    },
    dataComplete: true,
    dataFresh: true,
  })

  assert.equal(result.action, 'HOLD')
  assert.equal(result.priceType, 'RISK_BOUNDARY')
  assert.equal(result.primaryPrice, 10)
  assert.equal(result.sellableQty, 2)
  assert.equal(result.riskReward, 0.64)
})
