import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUserPrompt } from '../api/_ai_prompts.js'

test('建议量化上下文优先展示模型实际输入截止时间', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600519',
    quantModelVersion: 'default',
    quant: {
      modelVersion: 'default',
      asOf: '2026-08-19',
      inputAsOf: '2026-08-19 14:35:00',
      inputSource: 'completed-5m-aggregated',
      forecast: { direction: '看涨', upProb: 60 },
    },
  })

  assert.match(prompt, /输入截止.*2026-08-19 14:35:00/)
  assert.match(prompt, /已完成5分钟K聚合/)
})

test('日线辅助模型在收盘后优先提供次日预测', () => {
  const prompt = buildUserPrompt('hold_advice', {
    code: '003036',
    quantModelVersion: 'default',
    marketPhase: '非交易时段',
    quant: {
      modelVersion: 'default',
      asOf: '2026-08-19',
      forecast: {
        direction: '震荡',
        upProb: 45,
        expRet: -1.28,
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
    },
  })

  assert.match(prompt, /收盘后\/盘前.*次日预测.*主依据/)
  assert.match(prompt, /5日预测.*辅助/)
  assert.match(prompt, /quantNote.*49%.*-0.36%.*49.17.*58.08/)
  assert.match(prompt, /交易动作、价格、手数和风险只服从服务端V3决策/)
  assert.doesNotMatch(prompt, /Transformer|V2\.1|V2\.0/)
})
