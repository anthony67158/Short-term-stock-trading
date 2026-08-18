import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adaptV21Prediction,
  adaptV2Prediction,
  isQuantResultForVersion,
  normalizeQuantModelVersion,
  QUANT_MODEL_V21,
  quantModelLabel,
} from '../shared/modelVersion.js'

test('模型版本明确区分默认、V2.0与V2.1', () => {
  assert.equal(normalizeQuantModelVersion(), 'default')
  assert.equal(normalizeQuantModelVersion('unknown'), 'default')
  assert.equal(normalizeQuantModelVersion('v2'), 'v2')
  assert.equal(normalizeQuantModelVersion('v2.1'), QUANT_MODEL_V21)
  assert.equal(normalizeQuantModelVersion('V21'), QUANT_MODEL_V21)
  assert.equal(quantModelLabel('default'), '当前生产模型')
  assert.equal(quantModelLabel('v2'), '分钟 Transformer V2.0')
  assert.equal(quantModelLabel('v2.1'), '分钟 Transformer V2.1（盘中实验）')
})

test('量化评分结果必须与本次选股锁定的模型版本一致', () => {
  assert.equal(isQuantResultForVersion({
    ok: true,
    quantModelVersion: 'default',
    quant: { score: 61 },
  }, 'default'), true)
  assert.equal(isQuantResultForVersion({
    ok: true,
    quantModelVersion: 'v2',
    quant: { score: 72, modelVersion: 'v2' },
  }, 'v2'), true)
  assert.equal(isQuantResultForVersion({
    ok: true,
    quantModelVersion: 'v2.1',
    quant: {
      score: 68,
      modelVersion: 'v2',
      selectedModelVersion: 'v2.1',
    },
  }, 'v2.1'), true)
  assert.equal(isQuantResultForVersion({
    ok: true,
    quantModelVersion: 'default',
    quant: { score: 61 },
  }, 'v2'), false)
  assert.equal(isQuantResultForVersion({
    ok: false,
    quantModelVersion: 'v2',
    quant: null,
  }, 'v2'), false)
})

test('V2三分类概率适配为军师可消费的统一量化结构', () => {
  const result = adaptV2Prediction({
    ok: true,
    shadowOnly: true,
    asOf: '2026-08-10 15:00:00',
    predictedClass: 'TAKE_PROFIT',
    probabilities: {
      stopLoss: 0.2,
      timeout: 0.1,
      takeProfit: 0.7,
    },
    outlook: {
      direction: 'bullish',
      confidencePct: 70,
      probabilityMarginPct: 50,
      normalizedEntropy: 0.73,
      expectedBarrierReturnPct: 0.58,
      directionScore: 75,
      riskLevel: 'medium',
      signalStrength: 'strong',
      probabilityEdgePct: 50,
      favorableToAdverseOdds: 3.5,
      uncertaintyLevel: 'medium',
      convictionScore: 62,
    },
    marketContext: {
      barsCount: 61,
      sessionBars: 48,
      sessionReturnPct: 1.25,
      momentum30mPct: 0.42,
      realizedVolPct: 1.18,
      averageRangePct: 0.73,
      volumeRatio20: 1.36,
      closeLocationPct: 82,
      drawdownFromHighPct: -0.18,
      reboundFromLowPct: 1.92,
      supportPrice: 9.82,
      resistancePrice: 10.21,
      trendAlignment: 'bullish',
    },
    priceReferences: {
      anchorType: 'signalClose',
      anchorPrice: 10,
      supportPrice: 9.82,
      resistancePrice: 10.21,
      indicativeTakeProfitPrice: 10.1,
      indicativeStopLossPrice: 9.94,
      referenceBuyZoneLow: 9.82,
      referenceBuyZoneHigh: 10,
      provisional: true,
    },
    targetDefinition: {
      entry: 'nextTradingDayFirst5mOpen',
      horizon: 'nextTradingDay',
      takeProfitPct: 1,
      stopLossPct: 0.6,
      sameBarPolicy: 'stopLossFirst',
    },
    model: {
      runId: 'run-20260811-minute5m-v2',
      architecture: 'transformer',
      sha256: 'a'.repeat(64),
    },
  }, { price: 10 })

  assert.equal(result.ok, true)
  assert.equal(result.modelVersion, 'v2')
  assert.equal(result.score, 75)
  assert.equal(result.bias, '偏多')
  assert.equal(result.forecast.upProb, 70)
  assert.equal(result.forecast.downProb, 20)
  assert.equal(result.forecast.timeoutProb, 10)
  assert.equal(result.forecast.expRet, 0.58)
  assert.equal(result.forecast.direction, '看涨')
  assert.equal(result.forecast.horizon, '下一交易日')
  assert.equal(result.v2.predictedClass, 'TAKE_PROFIT')
  assert.equal(result.v2.outlook.probabilityEdgePct, 50)
  assert.equal(result.v2.marketContext.momentum30mPct, 0.42)
  assert.equal(result.v2.marketContext.trendAlignment, 'bullish')
  assert.equal(result.v2.priceReferences.indicativeTakeProfitPrice, 10.1)
  assert.equal(result.forecast.targetLow, 9.82)
  assert.equal(result.forecast.targetMid, 10)
  assert.equal(result.forecast.targetHigh, 10.1)
  assert.equal(result.highConfSignal.buyPrice, 10)
  assert.equal(result.highConfSignal.takeProfit, 10.1)
  assert.equal(result.highConfSignal.stopLoss, 9.94)
  assert.equal(result.highConfSignal.fired, true)
  assert.equal(result.highConfSignal.gate, 65)
  assert.equal(result.reads.length >= 6, true)
})

test('V2适配拒绝缺失或不守恒的概率输出', () => {
  assert.throws(
    () => adaptV2Prediction({
      probabilities: { stopLoss: 0.7, timeout: 0.7, takeProfit: 0.1 },
    }),
    /概率/,
  )
})

test('V2.1双头适配声明独立选择版本、实验状态与离线准确率', () => {
  const result = adaptV21Prediction({
    modelVersion: 'v2.1-intraday',
    asOf: '2026-08-12 10:30:00',
    session: 'morning',
    heads: {
      next30m: {
        horizon: '未来30分钟',
        probabilities: {
          stopLoss: 0.2,
          timeout: 0.3,
          takeProfit: 0.5,
        },
        predictedClass: 'TAKE_PROFIT',
        outlook: {
          direction: 'bullish',
          expectedBarrierReturnPct: 0.105,
          confidencePct: 80,
        },
      },
      sessionClose: {
        horizon: '截至今日收盘',
        probabilities: {
          stopLoss: 0.3,
          timeout: 0.5,
          takeProfit: 0.2,
        },
        predictedClass: 'TIMEOUT',
        outlook: {
          direction: 'neutral',
          expectedBarrierReturnPct: 0.01,
          confidencePct: 50,
        },
      },
    },
    model: {
      runId: 'run-v21',
      architecture: 'transformer-dual-head',
      sha256: 'a'.repeat(64),
    },
  }, { price: 10 })

  assert.equal(result.modelVersion, 'v2.1')
  assert.equal(result.selectedModelVersion, 'v2.1')
  assert.equal(result.runtimeModelVersion, 'v2.1-intraday')
  assert.equal(result.modelLabel, '分钟 Transformer V2.1（盘中实验）')
  assert.equal(result.experimental, true)
  assert.equal(result.reliability.productionGatePassed, false)
  assert.equal(result.reliability.balancedAccuracyPct.next30m, 53.92)
  assert.equal(result.reliability.balancedAccuracyPct.sessionClose, 54.58)
  assert.equal(result.forecast.horizon, '未来30分钟')
  assert.equal(result.forecast.upProb, 50)
  assert.equal(result.highConfSignal.fired, false)
  assert.match(result.highConfSignal.label, /实验/)
  assert.equal(result.v21.heads.sessionClose.predictedClass, 'TIMEOUT')
  assert.equal(result.asOf, '2026-08-12 10:30:00')
})
