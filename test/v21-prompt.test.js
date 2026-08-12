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
