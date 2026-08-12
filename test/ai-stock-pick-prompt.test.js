import test from 'node:test'
import assert from 'node:assert/strict'

import { buildUserPrompt } from '../api/_ai_prompts.js'

test('AI选股提示词要求无立即买点时仍输出条件候选', () => {
  const prompt = buildUserPrompt('scan_pick', {
    session: 'next_open',
    quantModelVersion: 'v2',
    quantMissing: true,
    candidates: [{ code: '600001', name: '甲公司', combinedScore: 75 }],
  })

  assert.match(prompt, /candidates 非空时 picks 必须给1~3只/)
  assert.match(prompt, /等待触发/)
  assert.match(prompt, /下一交易日开盘/)
  assert.match(prompt, /分钟 Transformer V2/)
  assert.match(prompt, /不得混用默认模型/)
  assert.doesNotMatch(prompt, /noTrade=true 时 picks 必须为空数组/)
})
