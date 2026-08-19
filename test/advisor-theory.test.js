import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildAdvisorTheoryBlock,
  buildAdvisorTheoryQuery,
  theoryReferencesOf,
} from '../shared/advisorTheory.js'
import { buildUserPrompt } from '../api/_ai_prompts.js'
import { retrieveTheoryKeywords } from '../api/_kb.js'

test('个股买入建议按短线事件构造龙头战法与情绪周期检索词', () => {
  const query = buildAdvisorTheoryQuery('buy_advice', {
    code: '000001',
    name: '测试股份',
    industry: '机器人',
    eventSignal: {
      limitUpToday: true,
      limitStreak: 3,
      reasons: ['连板3板', '封单强'],
    },
    marketEnv: { level: '强势' },
    intraday: { rhythm: '分歧转一致' },
  })

  assert.match(query, /测试股份/)
  assert.match(query, /龙头战法/)
  assert.match(query, /情绪周期/)
  assert.match(query, /题材主线/)
  assert.match(query, /分歧转一致/)
  const hits = retrieveTheoryKeywords(query, 6)
  assert.equal(hits.length, 6)
  assert.ok(hits.some((item) => item.book.includes('龙头战法')))
  assert.ok(hits.some((item) => item.book.includes('情绪周期')))
})

test('个股操作建议注入六条同源理论并要求理论服从真实证据', () => {
  const hits = Array.from({ length: 6 }, (_, index) => ({
    book: `理论${index + 1}`,
    topic: `主题${index + 1}`,
    text: `第${index + 1}条理论正文`,
  }))
  const block = buildAdvisorTheoryBlock(hits)
  const prompt = buildUserPrompt('hold_advice', {
    code: '000001',
  }, '', hits)

  assert.match(block, /经典理论知识库动态检索/)
  assert.match(block, /第6条理论正文/)
  assert.match(block, /不得因为检索命中就生搬硬套/)
  assert.match(prompt, /第6条理论正文/)
  assert.match(prompt, /theoryNote/)
  assert.match(prompt, /龙头战法/)
  assert.match(prompt, /短线情绪周期/)
})

test('理论引用去重并限制为六条可展示来源', () => {
  const refs = theoryReferencesOf([
    { book: '《龙头战法》', topic: '只做龙头', text: 'A' },
    { book: '《龙头战法》', topic: '只做龙头', text: 'A2' },
    ...Array.from({ length: 8 }, (_, index) => ({
      book: `理论${index}`,
      topic: `主题${index}`,
      text: `正文${index}`,
    })),
  ])

  assert.equal(refs.length, 6)
  assert.deepEqual(refs[0], {
    book: '《龙头战法》',
    topic: '只做龙头',
  })
})

test('AI建议链路检索六条理论并回传到个股建议展示', () => {
  const ai = readFileSync(
    new URL('../api/ai.js', import.meta.url),
    'utf8',
  )
  const presentation = readFileSync(
    new URL('../src/components/AdvicePresentation.jsx', import.meta.url),
    'utf8',
  )
  const precision = readFileSync(
    new URL('../src/styles/precision.css', import.meta.url),
    'utf8',
  )

  assert.match(ai, /retrieveTheoryKeywords\([^,]+,\s*6\)/)
  assert.match(ai, /result\.theoryRefs\s*=\s*theoryRefs/)
  assert.match(presentation, /advice\.theoryRefs/)
  assert.match(presentation, /参考理论/)
  assert.match(
    precision,
    /\.advice-presentation \.theory-chip\s*{[^}]*max-width:\s*100%[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s,
  )
})
