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

test('AI选股在V2.1回退时必须按实际V2.0解释候选分数', () => {
  const prompt = buildUserPrompt('scan_pick', {
    session: 'next_open',
    quantModelVersion: 'v2.1',
    candidates: [{
      code: '600001',
      name: '甲公司',
      combinedScore: 65,
      quant: {
        modelVersion: 'v2.1',
        effectiveModelVersion: 'v2',
        runtimeModelVersion: 'v2.0-daily',
        modelLabel: '分钟 Transformer V2.0',
        fallback: {
          from: 'v2.1',
          to: 'v2',
          reason: '当前时段不在盘中窗口',
        },
        score: 60,
      },
    }],
  })

  assert.match(prompt, /候选实际运行版本/)
  assert.match(prompt, /回退V2\.0/)
  assert.match(prompt, /不得把V2\.0分数描述成V2\.1盘中结果/)
})
