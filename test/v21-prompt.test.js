import test from 'node:test'
import assert from 'node:assert/strict'

import { buildUserPrompt } from '../api/_ai_prompts.js'

test('军师明确区分V2.1双头盘中概率与日终V2', () => {
  const prompt = buildUserPrompt('buy_advice', {
    quant: {
      selectedModelVersion: 'v2.1',
      modelVersion: 'v2.1',
      runtimeModelVersion: 'v2.1-intraday',
      asOf: '2026-08-12 10:30:00',
      v21: {
        activeHead: 'next30m',
        session: 'morning',
        heads: {
          next30m: {
            horizon: '未来30分钟',
            probabilities: {
              stopLoss: 0.2,
              timeout: 0.3,
              takeProfit: 0.5,
            },
          },
          sessionClose: {
            horizon: '截至今日收盘',
            probabilities: {
              stopLoss: 0.3,
              timeout: 0.5,
              takeProfit: 0.2,
            },
          },
        },
      },
    },
  })

  assert.match(prompt, /V2\.1盘中双头模型/)
  assert.match(prompt, /2026-08-12 10:30:00/)
  assert.match(prompt, /未来30分钟/)
  assert.match(prompt, /截至今日收盘/)
  assert.match(prompt, /不得与上一收盘日V2概率混用/)
  assert.match(prompt, /用户手动选择的实验模型/)
  assert.match(prompt, /53\.92%/)
  assert.match(prompt, /54\.58%/)
  assert.match(prompt, /未达到58%生产门槛/)
  assert.match(prompt, /confidence最多为“中”/)
})

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

test('生产模型军师在收盘后必须优先使用次日预测', () => {
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
})

test('军师明确显示V2.1回退V2.0且不冒充盘中双头', () => {
  const prompt = buildUserPrompt('hold_advice', {
    quant: {
      selectedModelVersion: 'v2.1',
      modelVersion: 'v2',
      runtimeModelVersion: 'v2.0-daily',
      modelLabel: '分钟 Transformer V2.0',
      fallback: {
        from: 'v2.1',
        to: 'v2',
        reason: '当前时段不支持V2.1',
      },
      forecast: {
        horizon: '下一交易日',
      },
      v2: {
        probabilities: {
          stopLoss: 0.2,
          timeout: 0.3,
          takeProfit: 0.5,
        },
        outlook: {},
        marketContext: {},
        priceReferences: {},
      },
    },
  })

  assert.match(prompt, /选择了V2\.1/)
  assert.match(prompt, /实际已回退V2\.0/)
  assert.match(prompt, /当前时段不支持V2\.1/)
  assert.doesNotMatch(prompt, /当前量化版本：V2\.1盘中双头模型/)
})
