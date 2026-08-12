import test from 'node:test'
import assert from 'node:assert/strict'

import { buildUserPrompt } from '../api/_ai_prompts.js'

test('复盘提示词要求区分认知错误执行错误和偶然波动', () => {
  const prompt = buildUserPrompt('review', {
    code: '600000',
    knowledgeActionReview: {
      attribution: 'judgment_error',
      attributionLabel: '认知错误',
      executionScore: 95,
      pnl: -40,
      summary: '按计划止损，执行正确，原判断需校正',
    },
  }, '')

  assert.match(prompt, /知行合一复盘归因/)
  assert.match(prompt, /认知错误/)
  assert.match(prompt, /严格止损后的亏损不能判成执行错误/)
  assert.match(prompt, /违规盈利不能粉饰执行质量/)
})
