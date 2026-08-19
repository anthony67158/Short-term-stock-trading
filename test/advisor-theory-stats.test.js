import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ADVICE_OUTCOME_POLICY_VERSION,
} from '../shared/adviceOutcome.js'
import {
  adviceTheoryTextOf,
  theoryTagsOf,
} from '../shared/advisorTheory.js'
import { planStore } from '../src/planStore.js'

test('理论归因识别个股建议实际采用的三个A股短线体系', () => {
  assert.deepEqual(
    theoryTagsOf(
      '龙头战法看分歧转一致；短线情绪周期处于修复期；题材主线仍有资金持续流入。',
    ),
    ['龙头战法', '短线情绪周期', '题材主线'],
  )
})

test('军师战绩只统计theoryNote实际采用理论而不统计六条检索候选', () => {
  planStore.setData({
    plan: [],
    holding: [],
    closed: [],
    adviceLog: [{
      id: 'theory-new-1',
      code: '000001',
      mode: 'buy_advice',
      action: '回调再买',
      at: new Date('2026-08-10T10:00:00+08:00').getTime(),
      verified: true,
      hit: true,
      resultPct: 3.2,
      outcomePolicyVersion: ADVICE_OUTCOME_POLICY_VERSION,
      theoryNote: '龙头战法看分歧转一致；短线情绪周期处于修复期；题材主线仍有资金持续流入。',
      theoryRefs: [
        { book: '《凯利公式与资金管理》', topic: '仓位管理' },
        { book: '《道氏理论》', topic: '趋势确认与转折' },
      ],
    }],
  })

  const groups = planStore.theoryStats().groups
  assert.deepEqual(
    groups.map((group) => group.theory).sort(),
    ['龙头战法', '短线情绪周期', '题材主线'].sort(),
  )
  assert.equal(groups.some((group) => group.theory === '凯利/R风控'), false)
  assert.equal(groups.every((group) => group.total === 1), true)
})

test('旧版利弗莫尔与凯利归因继续兼容', () => {
  assert.deepEqual(
    theoryTagsOf('按利弗莫尔关键点突破跟进，并用凯利公式控制风险敞口。'),
    ['利弗莫尔关键点', '凯利/R风控'],
  )
})

test('通用顺势盈亏比措辞不冒充具名理论引用', () => {
  assert.deepEqual(
    theoryTagsOf('顺势而为，盈亏比至少2比1，并控制仓位与风险敞口。'),
    [],
  )
  assert.deepEqual(
    theoryTagsOf('均线多头排列，观察聪明钱与主力脚印。'),
    [],
  )
})

test('做T的theory字段兼容为实际采用理论文本', () => {
  const advice = {
    theory: '缠论三买确认中枢突破，并结合量价关系等待放量。',
    theoryRefs: [
      { book: '《龙头战法》', topic: '只做龙头' },
    ],
  }

  assert.equal(adviceTheoryTextOf(advice), advice.theory)
  assert.deepEqual(theoryTagsOf(advice), ['缠论结构', '量价关系'])
})

test('军师战绩文案明确统计实际采用理论且不把候选引用计入', () => {
  const planTab = readFileSync(
    new URL('../src/components/PlanTab.jsx', import.meta.url),
    'utf8',
  )
  const precision = readFileSync(
    new URL('../src/styles/precision.css', import.meta.url),
    'utf8',
  )

  assert.match(planTab, /实际采用理论的建议归因/)
  assert.match(planTab, /检索候选不计入/)
  assert.match(planTab, /实际采用2至3个理论/)
  assert.match(
    precision,
    /\.advisor-score-dialog \.ap-row\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/s,
  )
  assert.match(
    precision,
    /\.advisor-score-dialog \.ap-mode\s*{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s,
  )
})
