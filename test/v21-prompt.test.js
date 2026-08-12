import test from 'node:test'
import assert from 'node:assert/strict'

import { buildUserPrompt } from '../api/_ai_prompts.js'

test('军师明确区分V2.1双头盘中概率与日终V2', () => {
  const prompt = buildUserPrompt('buy_advice', {
    quant: {
      modelVersion: 'v2',
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
})
