import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQuantAdviceContext,
  quantJudgeDiscipline,
} from '../shared/quantAdviceContext.js'

test('旧模型上下文统一投影为日线辅助模型', () => {
  const context = buildQuantAdviceContext({
    selectedModelVersion: 'v2.1',
    modelVersion: 'v2',
    runtimeModelVersion: 'legacy-runtime',
    modelLabel: 'legacy-model',
    asOf: '2026-08-12',
    forecast: { horizon: '下一交易日' },
  }, 'v2.1')

  assert.deepEqual(context, {
    selectedModelVersion: 'default',
    effectiveModelVersion: 'default',
    runtimeModelVersion: '',
    modelLabel: '36因子日线辅助模型',
    horizon: '下一交易日',
    asOf: '2026-08-12',
    experimental: false,
    fallback: null,
    reliability: null,
  })
  assert.equal(quantJudgeDiscipline(context), '')
})

test('日线辅助上下文固化次日预测', () => {
  const context = buildQuantAdviceContext({
    modelVersion: 'default',
    asOf: '2026-08-19',
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
