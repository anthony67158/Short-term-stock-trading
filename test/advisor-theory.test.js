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

test('快速深度与复核按各自人格注入分级理论记忆', () => {
  const hits = Array.from({ length: 6 }, (_, index) => ({
    book: `理论${index + 1}`,
    topic: `主题${index + 1}`,
    text: `第${index + 1}条理论正文`,
  }))
  const block = buildAdvisorTheoryBlock(hits)
  const fastPrompt = buildUserPrompt('hold_advice', {
    code: '000001',
  }, '', hits)
  const deepPrompt = buildUserPrompt('hold_advice', {
    code: '000001',
    generationProfile: 'DEEP',
  }, '', hits)
  const reviewPrompt = buildUserPrompt('review', {
    code: '000001',
    reviewEvent: {
      kind: 'price-review',
    },
  }, '', hits)

  assert.match(block, /经典理论知识库动态检索/)
  assert.match(block, /第6条理论正文/)
  assert.match(block, /不得因为检索命中就生搬硬套/)
  assert.match(fastPrompt, /盘中执行官/)
  assert.match(fastPrompt, /快速理论校准/)
  assert.match(fastPrompt, /第1条理论正文/)
  assert.match(fastPrompt, /第3条理论正文/)
  assert.doesNotMatch(fastPrompt, /第4条理论正文/)
  assert.match(fastPrompt, /理论不能替代实时证据/)
  assert.match(fastPrompt, /theoryNote/)
  assert.match(fastPrompt, /最适用的1个理论/)
  assert.match(deepPrompt, /主策略官/)
  assert.match(deepPrompt, /短线经验记忆/)
  assert.match(deepPrompt, /第1条理论正文/)
  assert.match(deepPrompt, /第5条理论正文/)
  assert.doesNotMatch(deepPrompt, /第6条理论正文/)
  assert.doesNotMatch(deepPrompt, /理论1|主题1/)
  assert.match(deepPrompt, /不得为了引用而引用/)
  assert.match(deepPrompt, /事实和风控为准/)
  assert.match(deepPrompt, /theoryNote/)
  assert.match(deepPrompt, /最适用的2个理论/)
  assert.match(reviewPrompt, /临盘裁决官/)
  assert.match(reviewPrompt, /临盘理论校准/)
  assert.match(reviewPrompt, /第1条理论正文/)
  assert.match(reviewPrompt, /第3条理论正文/)
  assert.doesNotMatch(reviewPrompt, /第4条理论正文/)
  assert.match(reviewPrompt, /不得生成新观察价/)
  assert.match(reviewPrompt, /theoryNote/)
  assert.match(reviewPrompt, /最适用的1个理论/)
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

test('AI建议链路为三种模式检索理论并回传到个股建议展示', () => {
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

  assert.match(ai, /theoryLimit/)
  assert.match(
    ai,
    /retrieveTheoryKeywords\(\s*theoryQuery,\s*theoryLimit,\s*\)/,
  )
  assert.doesNotMatch(ai, /retrieveTheory\(/)
  assert.doesNotMatch(
    ai,
    /isAdvisor\s*&&\s*payload\.code\s*&&\s*payload\.generationProfile\s*===\s*['"]DEEP['"]/,
  )
  assert.match(
    ai,
    /useRole === 'review' \|\| mode === 'review'[\s\S]{0,120}ADVISOR_REVIEW_SYSTEM/,
  )
  assert.match(ai, /正在提炼短线实战经验/)
  assert.match(ai, /短线经验库/)
  assert.doesNotMatch(ai, /正在匹配经典操盘理论/)
  assert.match(ai, /result\.theoryRefs\s*=\s*theoryRefs/)
  assert.match(presentation, /displayAdvice\.theoryRefs/)
  assert.match(presentation, /经验来源/)
  assert.match(
    precision,
    /\.advice-presentation \.theory-chip\s*{[^}]*max-width:\s*100%[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s,
  )
})
