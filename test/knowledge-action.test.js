import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildJudgeKnowledgeActionAssessment,
  buildKnowledgeActionPlan,
  evaluateKnowledgeActionCycle,
  scoreKnowledgeActionPlan,
} from '../shared/knowledgeAction.js'

const completeAdvice = {
  action: '加仓',
  reason: '量化上涨概率62%，主力连续流入，回踩支撑后风险收益比合适',
  timing: '回踩10.00~10.10并重新站上VWAP后执行',
  actionPlan: '10.05元附近企稳加仓1手',
  opQty: '加仓1手',
  positionNote: '加仓后单票不超过总资产20%',
  bearCase: '板块退潮可能导致支撑失效',
  risk: '主力流入中断与放量跌破支撑',
  stopPrice: 9.6,
  targetPrice: 11,
  exitTiming: '止损需收盘或放量跌破确认；目标位先减仓一半',
  invalidation: '收盘跌破9.60元且次日无法收回',
  validationWindow: '3个交易日',
  continuity: {
    zones: {
      add: { low: 10, high: 10.1, anchor: 10.05 },
    },
  },
}

test('军师建议被标准化为可执行可证伪的知行合一契约', () => {
  const plan = buildKnowledgeActionPlan(completeAdvice, {
    mode: 'hold_advice',
  })
  const score = scoreKnowledgeActionPlan(plan)

  assert.equal(plan.version, 1)
  assert.equal(plan.action, '加仓')
  assert.match(plan.researchLogic, /量化上涨概率62%/)
  assert.match(plan.triggerConditions, /VWAP/)
  assert.match(plan.positionRule, /20%/)
  assert.equal(plan.stopLoss.price, 9.6)
  assert.equal(plan.takeProfit.price, 11)
  assert.match(plan.invalidation, /跌破9.60/)
  assert.equal(plan.validationWindow, '3个交易日')
  assert.match(plan.falsifiableClaim, /则原交易逻辑失效/)
  assert.equal(score.total, 100)
  assert.equal(score.grade, '知行合一')
})

test('缺少失效条件和仓位规则时知行合一评分必须降级', () => {
  const score = scoreKnowledgeActionPlan(buildKnowledgeActionPlan({
    action: '买入',
    reason: '看多',
    actionPlan: '可以买',
  }, { mode: 'buy_advice' }))

  assert.ok(score.total < 60)
  assert.equal(score.dimensions.falsifiability.score, 0)
  assert.ok(score.missing.includes('策略失效条件'))
  assert.ok(score.missing.includes('仓位规则'))
})

test('严格按计划止损即使亏损也获得高执行评价', () => {
  const review = evaluateKnowledgeActionCycle({
    plan: buildKnowledgeActionPlan(completeAdvice),
    execution: {
      side: 'sell',
      price: 9.59,
      qty: 1,
    },
    outcome: {
      pnl: -46,
      validationComplete: true,
      invalidated: true,
    },
  })

  assert.ok(review.executionScore >= 90)
  assert.equal(review.attribution, 'judgment_error')
  assert.equal(review.attributionLabel, '认知错误')
  assert.equal(review.disciplineVerdict, '严格执行')
  assert.match(review.summary, /止损纪律/)
})

test('超仓侥幸盈利仍判定为低质量执行', () => {
  const review = evaluateKnowledgeActionCycle({
    plan: buildKnowledgeActionPlan(completeAdvice),
    execution: {
      side: 'buy',
      price: 10.05,
      qty: 3,
    },
    outcome: {
      pnl: 300,
      validationComplete: true,
      targetHit: true,
    },
  })

  assert.ok(review.executionScore < 60)
  assert.equal(review.attribution, 'execution_error')
  assert.equal(review.attributionLabel, '执行错误')
  assert.equal(review.luckyProfit, true)
  assert.match(review.summary, /盈利不能掩盖/)
})

test('验证周期未结束时短期亏损归为偶然波动', () => {
  const review = evaluateKnowledgeActionCycle({
    plan: buildKnowledgeActionPlan(completeAdvice),
    execution: {
      side: 'buy',
      price: 10.05,
      qty: 1,
    },
    outcome: {
      pnl: -30,
      validationComplete: false,
      invalidated: false,
    },
  })

  assert.ok(review.executionScore >= 90)
  assert.equal(review.attribution, 'randomness')
  assert.equal(review.attributionLabel, '偶然波动')
  assert.match(review.summary, /验证周期尚未结束/)
})

test('Judge按固定权重输出知行合一评分且不能突破计划基线', () => {
  const assessment = buildJudgeKnowledgeActionAssessment(
    completeAdvice,
    {
      dimensions: {
        executability: 18,
        logicConsistency: 17,
        falsifiability: 16,
        disciplineCompliance: 21,
        reviewability: 13,
      },
      findings: ['触发条件可执行'],
      violations: [],
    },
  )

  assert.equal(assessment.total, 85)
  assert.equal(assessment.grade, '知行合一')
  assert.equal(assessment.dimensions.executability.max, 20)
  assert.equal(assessment.dimensions.disciplineCompliance.max, 25)
  assert.deepEqual(assessment.findings, ['触发条件可执行'])
})

test('Judge不能用主观评分掩盖缺失的失效条件', () => {
  const assessment = buildJudgeKnowledgeActionAssessment({
    action: '买入',
    reason: '看多',
    actionPlan: '现在买入',
  }, {
    dimensions: {
      executability: 20,
      logicConsistency: 20,
      falsifiability: 20,
      disciplineCompliance: 25,
      reviewability: 15,
    },
  })

  assert.equal(assessment.dimensions.falsifiability.score, 0)
  assert.ok(assessment.total < 60)
  assert.ok(assessment.missing.includes('策略失效条件'))
})
