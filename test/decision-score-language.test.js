import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decisionScoreLanguage,
} from '../shared/decisionScoreLanguage.js'

test('量化分数转成每100次结果与计划风险白话', () => {
  const result = decisionScoreLanguage({
    pFill: 0.159,
    pWinGivenFill: 0.319,
    expectedNetR: -0.475505,
    expectedShortfall10: -2.367365,
  })

  assert.deepEqual(
    result.items.map((item) => item.label),
    ['能否成交', '成交以后', '长期平均', '不利情形'],
  )
  assert.match(result.items[0].text, /每100次.*约16次.*15\.9%/)
  assert.match(result.items[1].text, /约32笔费后盈利、68笔未盈利.*31\.9%/)
  assert.match(result.items[2].text, /每承担1份计划风险.*预计亏0\.48份/)
  assert.match(result.items[3].text, /最差的10%.*亏2\.37份计划风险/)
  assert.match(result.riskUnitNote, /1R.*参考执行价到止损价/)
  assert.doesNotMatch(result.summary, /费后期望|尾部损失参考/)
})

test('正期望使用预计赚且缺失字段不伪造结论', () => {
  const result = decisionScoreLanguage({
    pFill: 0.678,
    expectedNetR: 0.184,
  })

  assert.equal(result.items.length, 2)
  assert.match(result.summary, /约68次能按计划成交/)
  assert.match(result.summary, /平均预计赚0\.18份/)
  assert.doesNotMatch(result.summary, /成交以后|不利情形/)
})
