import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQuantAdviceContext,
  quantJudgeDiscipline,
} from '../shared/quantAdviceContext.js'

test('V2.1量化上下文固化双头窗口与实验可靠性', () => {
  const context = buildQuantAdviceContext({
    selectedModelVersion: 'v2.1',
    modelVersion: 'v2.1',
    runtimeModelVersion: 'v2.1-intraday',
    modelLabel: '分钟 Transformer V2.1（盘中实验）',
    asOf: '2026-08-12 10:30:00',
    forecast: { horizon: '未来30分钟' },
    reliability: {
      productionGatePassed: false,
      thresholdPct: 58,
      balancedAccuracyPct: {
        next30m: 53.92,
        sessionClose: 54.58,
      },
    },
  }, 'v2.1')

  assert.deepEqual(context, {
    selectedModelVersion: 'v2.1',
    effectiveModelVersion: 'v2.1',
    runtimeModelVersion: 'v2.1-intraday',
    modelLabel: '分钟 Transformer V2.1（盘中实验）',
    horizon: '未来30分钟',
    asOf: '2026-08-12 10:30:00',
    experimental: true,
    fallback: null,
    reliability: {
      productionGatePassed: false,
      thresholdPct: 58,
      balancedAccuracyPct: {
        next30m: 53.92,
        sessionClose: 54.58,
      },
    },
  })
})

test('V2.1回退时同时保留用户选择和实际V2.0运行事实', () => {
  const context = buildQuantAdviceContext({
    selectedModelVersion: 'v2.1',
    modelVersion: 'v2',
    runtimeModelVersion: 'v2.0-daily',
    modelLabel: '分钟 Transformer V2.0',
    forecast: { horizon: '下一交易日' },
    fallback: {
      from: 'v2.1',
      to: 'v2',
      reason: '当前时段不支持V2.1',
    },
  }, 'v2.1')

  assert.equal(context.selectedModelVersion, 'v2.1')
  assert.equal(context.effectiveModelVersion, 'v2')
  assert.equal(context.experimental, true)
  assert.deepEqual(context.fallback, {
    from: 'v2.1',
    to: 'v2',
    reason: '当前时段不支持V2.1',
  })
})

test('生产模型军师上下文固化次日预测而不是只保留五日窗口', () => {
  const context = buildQuantAdviceContext({
    modelVersion: 'default',
    modelLabel: '当前生产模型',
    asOf: '2026-08-19',
    forecast: {
      direction: '震荡',
      upProb: 45,
      expRet: -1.28,
      horizon: 'next5TradingDays',
    },
    nextTradeDayForecast: {
      targetDate: '2026-08-20',
      direction: '震荡',
      upProb: 49,
      expRet: -0.36,
      targetLow: 49.17,
      targetMid: 53.75,
      targetHigh: 58.08,
    },
  })

  assert.deepEqual(context.nextTradeDayForecast, {
    targetDate: '2026-08-20',
    direction: '震荡',
    upProb: 49,
    expRet: -0.36,
    targetLow: 49.17,
    targetMid: 53.75,
    targetHigh: 58.08,
  })
})

test('Judge对实验V2.1禁止单模型确认并识别实际回退', () => {
  assert.match(quantJudgeDiscipline({
    selectedModelVersion: 'v2.1',
    experimental: true,
    fallback: null,
  }), /不得单独构成confirm/)
  assert.match(quantJudgeDiscipline({
    selectedModelVersion: 'v2.1',
    experimental: true,
    fallback: {
      from: 'v2.1',
      to: 'v2',
      reason: '当前时段不支持',
    },
  }), /实际V2\.0/)
})
