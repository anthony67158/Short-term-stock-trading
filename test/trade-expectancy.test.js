import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TRADE_EXPECTANCY_SCHEMA_VERSION,
  buildTradeExpectancy,
} from '../shared/tradeExpectancy.js'

test('价格合同按双边滑点和真实费用计算费后盈亏平衡胜率', () => {
  const result = buildTradeExpectancy({
    action: 'BUY',
    referencePrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    quantityLots: 10,
    slippageBps: 5,
  })

  assert.equal(
    result.schemaVersion,
    TRADE_EXPECTANCY_SCHEMA_VERSION,
  )
  assert.equal(result.state, 'PLAN_ONLY')
  assert.equal(result.source, 'PRICE_CONTRACT')
  assert.ok(result.plan.lossAmount > 1000)
  assert.ok(result.plan.profitAmount < 2000)
  assert.ok(result.plan.netRiskReward < 2)
  assert.ok(result.plan.breakEvenWinProbability > 1 / 3)
  assert.equal(result.probability.pWinGivenFill, null)
  assert.equal(result.gate.state, 'UNCALIBRATED')
  assert.equal(result.gate.allowsRiskIncrease, true)
})

test('机会模型下界为负时明确阻止新增风险', () => {
  const result = buildTradeExpectancy({
    action: 'BUY',
    referencePrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    quantityLots: 2,
    opportunityScore: {
      state: 'READY',
      serverVerified: true,
      modelVersion: 'opportunity-score.20260907',
      priceContract: {
        entryPrice: 10,
        stopPrice: 9,
        targetPrice: 12,
      },
      pFill: 0.72,
      pWinGivenFill: 0.58,
      expectedNetR: 0.12,
      netRLowerBound: -0.04,
      expectedShortfall10: -1.15,
      calibration: {
        method: 'isotonic',
        sampleCount: 420,
      },
    },
  })

  assert.equal(result.state, 'CALIBRATED')
  assert.equal(result.probability.pFill, 0.72)
  assert.equal(result.probability.pWinGivenFill, 0.58)
  assert.equal(result.expectancy.expectedNetRGivenFill, 0.12)
  assert.equal(result.expectancy.expectedNetRPerCandidate, 0.0864)
  assert.equal(result.gate.state, 'NEGATIVE')
  assert.equal(result.gate.allowsRiskIncrease, false)
  assert.match(result.gate.reason, /下界-0.04R/)
})

test('机会模型正下界形成可执行的统计优势', () => {
  const result = buildTradeExpectancy({
    action: 'ADD',
    referencePrice: 10,
    stopPrice: 9.2,
    targetPrice: 11.8,
    quantityLots: 1,
    opportunityScore: {
      state: 'READY',
      serverVerified: true,
      modelVersion: 'opportunity-score.20260907',
      priceContract: {
        entryPrice: 10,
        stopPrice: 9.2,
        targetPrice: 11.8,
      },
      pFill: 0.8,
      pWinGivenFill: 0.62,
      expectedNetR: 0.24,
      netRLowerBound: 0.06,
      expectedShortfall10: -1.08,
      calibration: {
        method: 'isotonic',
        sampleCount: 520,
      },
    },
  })

  assert.equal(result.gate.state, 'POSITIVE')
  assert.equal(result.gate.allowsRiskIncrease, true)
  assert.equal(result.expectancy.lowerBoundPerCandidate, 0.048)
})

test('量化高把握信号映射到当前价格合同时计算计划期望', () => {
  const result = buildTradeExpectancy({
    action: 'BUY',
    referencePrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    quantityLots: 1,
    quant: {
      selectedModelVersion: 'v2',
      highConfSignal: {
        fired: true,
        credibility: 70,
        buyPrice: 10,
        stopLoss: 9,
        takeProfit: 12,
      },
    },
  })

  assert.equal(result.state, 'MODEL_ESTIMATE')
  assert.equal(result.probability.pWinGivenFill, 0.7)
  assert.ok(result.expectancy.expectedNetRGivenFill > 0)
  assert.equal(result.gate.state, 'POSITIVE_ESTIMATE')
})

test('客户端伪造或价格合同不一致的机会分不得进入硬闸门', () => {
  const result = buildTradeExpectancy({
    action: 'BUY',
    referencePrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    opportunityScore: {
      state: 'READY',
      serverVerified: false,
      pFill: 0.99,
      pWinGivenFill: 0.99,
      expectedNetR: 9,
      netRLowerBound: 8,
      priceContract: {
        entryPrice: 8,
        stopPrice: 7,
        targetPrice: 20,
      },
    },
  })

  assert.equal(result.state, 'PLAN_ONLY')
  assert.equal(result.source, 'PRICE_CONTRACT')
})

test('跌停压力价展示止损无法成交时的扩大损失', () => {
  const result = buildTradeExpectancy({
    action: 'BUY',
    referencePrice: 10,
    stopPrice: 9.5,
    targetPrice: 11,
    quantityLots: 5,
    stressExitPrice: 9,
  })

  assert.equal(result.stress.exitPrice, 9)
  assert.ok(result.stress.lossAmount > result.plan.lossAmount)
  assert.ok(result.stress.lossMultiple > 1)
})

test('减仓不增加风险且不要求买入期望合同', () => {
  const result = buildTradeExpectancy({
    action: 'REDUCE',
    referencePrice: 10,
  })

  assert.equal(result.state, 'NOT_APPLICABLE')
  assert.equal(result.gate.allowsRiskIncrease, true)
})
