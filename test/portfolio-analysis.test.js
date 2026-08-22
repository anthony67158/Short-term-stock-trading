import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPortfolioDecisionNodes,
  normalizePortfolioAnalysis,
  sanitizePortfolioAnalysisRequest,
  selectPortfolioCandidates,
} from '../shared/portfolioAnalysis.js'

const distribution = {
  totalAssets: 100000,
  investedValue: 78000,
  cash: 22000,
  positionPct: 78,
  cashReservePct: 22,
  groups: [
    {
      name: 'PCB',
      accountWeightPct: 48,
      holdingWeightPct: 61.54,
      children: [],
    },
    {
      name: '创新药',
      accountWeightPct: 30,
      holdingWeightPct: 38.46,
      children: [],
    },
  ],
  stocks: [
    {
      code: '300476',
      name: '胜宏科技',
      concept: 'PCB',
      qty: 5,
      sellableQty: 3,
      price: 90,
      marketValue: 48000,
      accountWeightPct: 48,
      holdingWeightPct: 61.54,
      category: '核心仓',
    },
    {
      code: '600276',
      name: '恒瑞医药',
      concept: '创新药',
      qty: 6,
      sellableQty: 6,
      price: 50,
      marketValue: 30000,
      accountWeightPct: 30,
      holdingWeightPct: 38.46,
      category: '核心仓',
    },
  ],
  categories: [
    { name: '核心仓', accountWeightPct: 78, stockCount: 2 },
    { name: '标准仓', accountWeightPct: 0, stockCount: 0 },
    { name: '卫星仓', accountWeightPct: 0, stockCount: 0 },
  ],
}

test('持仓诊断请求只接受深度模式与刷新开关，不接受客户端持仓事实', () => {
  assert.deepEqual(
    sanitizePortfolioAnalysisRequest({
      deepMode: true,
      refresh: 1,
      holding: [{ code: '伪造持仓' }],
      cash: 99999999,
    }),
    {
      deepMode: true,
      refresh: true,
    },
  )
})

test('持仓诊断按服务端快照生成可审计决策节点', () => {
  const nodes = buildPortfolioDecisionNodes(distribution, {
    regime: 'defensive',
    note: '指数偏弱，涨跌比不足',
  })

  assert.deepEqual(
    nodes.map((node) => node.key),
    ['position', 'concentration', 'category', 'market'],
  )
  assert.match(nodes[0].conclusion, /78\.0%/)
  assert.match(nodes[1].conclusion, /PCB.*48\.0%/)
  assert.match(nodes[2].conclusion, /核心仓.*78\.0%/)
  assert.match(nodes[3].conclusion, /指数偏弱/)
})

test('模型诊断结果会钳制比例、过滤无证据股票和伪造证据编号', () => {
  const result = normalizePortfolioAnalysis({
    headline: '集中度过高，应先降风险',
    positionAssessment: {
      score: 130,
      level: '偏高',
      rationale: '总仓位与单一概念暴露均偏高',
    },
    allocation: {
      targetPositionPct: 165,
      targetCashReservePct: -10,
      categoryTargets: {
        corePct: 45,
        standardPct: 25,
        satellitePct: 10,
      },
      adjustments: [
        {
          target: 'PCB',
          action: 'reduce',
          changePct: 18,
          reason: '集中度过高',
        },
      ],
      cashStrategy: '至少保留两成现金',
      dynamicRules: ['大盘转强且放量后再逐级加仓'],
    },
    stockActions: [
      {
        code: '300476',
        name: '模型伪造名称',
        action: 'reduce',
        reducePct: 20,
        targetWeightPct: 28,
        reason: '单票占比过高且量化转弱',
        evidenceIds: ['E1', 'E999'],
      },
      {
        code: '000000',
        name: '模型编造股票',
        action: 'buy',
        reason: '没有真实证据',
        evidenceIds: ['E1'],
      },
      {
        code: '600276',
        name: '恒瑞医药',
        action: 'reduce',
        reason: '没有有效证据的减持',
        evidenceIds: ['E999'],
      },
    ],
    recommendations: [
      {
        concept: '模型伪造概念',
        code: '002747',
        name: '模型伪造名称',
        reason: '活跃概念领涨股',
        trigger: '放量站稳压力位',
        maxWeightPct: 9,
        evidenceIds: ['E2'],
      },
      {
        concept: '未知概念',
        code: '123456',
        name: '模型编造标的',
        reason: '无证据',
        evidenceIds: ['E7'],
      },
    ],
    risks: ['市场退潮时高仓位放大回撤'],
    decisionNodes: [
      {
        title: '仓位预算',
        conclusion: '先降到可防守水平',
        evidenceIds: ['E1', 'E404'],
      },
    ],
  }, {
    distribution,
    allowedEvidenceIds: ['E1', 'E2'],
    allowedHoldingCodes: ['300476', '600276'],
    allowedRecommendationCodes: ['002747'],
    recommendationCatalog: {
      '002747': {
        code: '002747',
        name: '埃斯顿',
        concept: '机器人',
      },
    },
  })

  assert.equal(result.positionAssessment.score, 100)
  assert.equal(result.allocation.targetPositionPct, 100)
  assert.equal(result.allocation.targetCashReservePct, 0)
  assert.equal(result.stockActions.length, 1)
  assert.equal(result.stockActions[0].name, '胜宏科技')
  assert.deepEqual(result.stockActions[0].evidenceIds, ['E1'])
  assert.equal(result.recommendations.length, 1)
  assert.equal(result.recommendations[0].name, '埃斯顿')
  assert.equal(result.recommendations[0].concept, '机器人')
  assert.deepEqual(result.recommendations[0].evidenceIds, ['E2'])
  assert.deepEqual(result.decisionNodes[0].evidenceIds, ['E1'])
})

test('目标现金与仓位类别会收敛到目标总仓位口径', () => {
  const result = normalizePortfolioAnalysis({
    allocation: {
      targetPositionPct: 60,
      targetCashReservePct: 60,
      categoryTargets: {
        corePct: 50,
        standardPct: 40,
        satellitePct: 30,
      },
    },
  }, { distribution })

  assert.equal(result.allocation.targetPositionPct, 60)
  assert.equal(result.allocation.targetCashReservePct, 40)
  assert.deepEqual(result.allocation.categoryTargets, {
    corePct: 25,
    standardPct: 20,
    satellitePct: 15,
  })
})

test('持仓诊断生成金额手数明确且资金守恒的组合执行单', () => {
  const result = normalizePortfolioAnalysis({
    headline: '降低PCB集中度并用卖出资金补充机器人',
    positionAssessment: {
      score: 76,
      level: '偏高',
      rationale: 'PCB占比过高，机器人方向量价与量化共振',
    },
    allocation: {
      targetPositionPct: 66,
      categoryTargets: {
        corePct: 30,
        standardPct: 30,
        satellitePct: 6,
      },
    },
    executionSummary: {
      verdict: 'rebalance',
      todayGoal: '卖出胜宏科技2手，条件满足后买入埃斯顿2手',
      nextReviewTrigger: '指数放量转强或机器人主力净流入转负',
    },
    stockActions: [
      {
        priority: 1,
        code: '300476',
        action: 'reduce',
        targetWeightPct: 30,
        triggerPrice: 90,
        invalidation: '重新放量突破前高则暂停第二笔减持',
        reason: 'PCB单一概念占比48%，超过组合上限',
        evidenceIds: ['E1', 'E3'],
      },
    ],
    recommendations: [
      {
        priority: 2,
        concept: '机器人',
        code: '002747',
        name: '模型伪造名称',
        targetWeightPct: 6,
        maxWeightPct: 6,
        triggerPrice: 30,
        trigger: '放量站稳30元',
        invalidation: '跌破28元或板块主力转负',
        reason: '机器人资金活跃且量化评分靠前',
        evidenceIds: ['E2', 'E4'],
      },
    ],
    conceptActions: [
      {
        concept: 'PCB',
        targetWeightPct: 30,
        reason: '降低单一主线回撤',
        evidenceIds: ['E1'],
      },
      {
        concept: '创新药',
        targetWeightPct: 30,
        reason: '维持现有配置',
        evidenceIds: ['E1'],
      },
      {
        concept: '机器人',
        targetWeightPct: 6,
        reason: '补充当前缺失的活跃方向',
        evidenceIds: ['E2', 'E4'],
      },
    ],
    scenarioPlan: [
      {
        regime: 'strong',
        signal: '指数放量且机器人资金连续流入',
        targetPositionPct: 76,
        actions: ['机器人确认后再增加5%'],
      },
      {
        regime: 'weak',
        signal: '指数跌破支撑且涨跌比恶化',
        targetPositionPct: 50,
        actions: ['优先继续降低PCB'],
      },
    ],
  }, {
    distribution,
    allowedEvidenceIds: ['E1', 'E2', 'E3', 'E4'],
    allowedHoldingCodes: ['300476', '600276'],
    allowedRecommendationCodes: ['002747'],
    recommendationCatalog: {
      '002747': {
        code: '002747',
        name: '埃斯顿',
        concept: '机器人',
        price: 30,
      },
    },
  })

  assert.equal(result.executionPlan.orders.length, 2)
  assert.deepEqual(
    result.executionPlan.orders.map((order) => ({
      code: order.code,
      action: order.action,
      currentWeightPct: order.currentWeightPct,
      targetWeightPct: order.targetWeightPct,
      deltaWeightPct: order.deltaWeightPct,
      estimatedAmount: order.estimatedAmount,
      estimatedLots: order.estimatedLots,
    })),
    [
      {
        code: '300476',
        action: 'reduce',
        currentWeightPct: 48,
        targetWeightPct: 30,
        deltaWeightPct: -18,
        estimatedAmount: 18000,
        estimatedLots: 2,
      },
      {
        code: '002747',
        action: 'buy',
        currentWeightPct: 0,
        targetWeightPct: 6,
        deltaWeightPct: 6,
        estimatedAmount: 3000,
        estimatedLots: 1,
      },
    ],
  )
  assert.equal(result.executionPlan.buyBudget < 6000, true)
  assert.equal(result.executionPlan.estimatedBuyAmount, 3000)
  assert.equal(result.executionPlan.estimatedSellAmount, 18000)
  assert.equal(
    result.executionPlan.estimatedBuyCashOutflow
      > result.executionPlan.estimatedBuyAmount,
    true,
  )
  assert.equal(
    result.executionPlan.estimatedSellNetProceeds
      < result.executionPlan.estimatedSellAmount,
    true,
  )
  assert.equal(result.executionPlan.estimatedFees > 0, true)
  assert.deepEqual(
    result.conceptActions.map((item) => [
      item.concept,
      item.currentWeightPct,
      item.targetWeightPct,
      item.deltaWeightPct,
    ]),
    [
      ['PCB', 48, 30, -18],
      ['创新药', 30, 30, 0],
      ['机器人', 0, 6, 6],
    ],
  )
  assert.equal(result.scenarioPlan.length, 2)
  assert.equal(result.quality.score >= 80, true)
  assert.deepEqual(result.quality.missing, [])
})

test('减仓手数不得超过T+1可卖数量并明确标记未完成部分', () => {
  const constrained = structuredClone(distribution)
  constrained.stocks[0].sellableQty = 1
  const result = normalizePortfolioAnalysis({
    allocation: { targetPositionPct: 30 },
    executionSummary: {
      verdict: 'defensive',
      todayGoal: '退出胜宏科技',
      nextReviewTrigger: '下一交易日解锁后继续执行',
    },
    stockActions: [{
      priority: 1,
      code: '300476',
      action: 'exit',
      targetWeightPct: 0,
      triggerPrice: 90,
      invalidation: '重新站稳前高',
      reason: '集中度和趋势均不再符合计划',
      evidenceIds: ['E1'],
    }],
  }, {
    distribution: constrained,
    allowedEvidenceIds: ['E1'],
    allowedHoldingCodes: ['300476', '600276'],
  })

  assert.equal(result.executionPlan.orders[0].estimatedLots, 1)
  assert.equal(result.executionPlan.orders[0].sellableLots, 1)
  assert.equal(result.executionPlan.orders[0].t1Blocked, true)
  assert.equal(result.executionPlan.orders[0].remainingLots, 4)
})

test('新增方向候选排除已持有概念、已持有股票和资金流出板块', () => {
  const candidates = selectPortfolioCandidates([
    {
      name: 'PCB',
      pct: 3.2,
      mainInflowYi: 8,
      leadCode: '300476',
      leadName: '胜宏科技',
    },
    {
      name: '机器人',
      pct: 2.6,
      mainInflowYi: 6,
      leadCode: '002747',
      leadName: '埃斯顿',
    },
    {
      name: '低空经济',
      pct: 1.8,
      mainInflowYi: 3,
      leadCode: '002085',
      leadName: '万丰奥威',
    },
    {
      name: '算力租赁',
      pct: -0.5,
      mainInflowYi: 5,
      leadCode: '000977',
      leadName: '浪潮信息',
    },
    {
      name: '消费电子',
      pct: 1.1,
      mainInflowYi: -2,
      leadCode: '002475',
      leadName: '立讯精密',
    },
  ], distribution, 4)

  assert.deepEqual(
    candidates.map((item) => [item.concept, item.code, item.name]),
    [
      ['机器人', '002747', '埃斯顿'],
      ['低空经济', '002085', '万丰奥威'],
    ],
  )
})

test('整手和现金限制下展示本次执行后的真实预计权重', () => {
  const result = normalizePortfolioAnalysis({
    allocation: {
      targetPositionPct: 73,
      categoryTargets: {
        corePct: 35,
        standardPct: 30,
        satellitePct: 8,
      },
    },
    executionSummary: {
      verdict: 'rebalance',
      todayGoal: '降低PCB并新增机器人',
      nextReviewTrigger: '成交后重新核验',
    },
    stockActions: [{
      priority: 1,
      code: '300476',
      action: 'reduce',
      targetWeightPct: 35,
      triggerPrice: 90,
      invalidation: '突破前高',
      reason: '集中度过高',
      evidenceIds: ['E1'],
    }],
    recommendations: [{
      priority: 2,
      concept: '机器人',
      code: '002747',
      targetWeightPct: 8,
      maxWeightPct: 8,
      triggerPrice: 30,
      trigger: '站稳30元',
      invalidation: '跌破28元',
      reason: '量化与资金共振',
      evidenceIds: ['E2'],
    }],
    conceptActions: [
      {
        concept: 'PCB',
        targetWeightPct: 35,
        reason: '降低集中度',
        evidenceIds: ['E1'],
      },
      {
        concept: '创新药',
        targetWeightPct: 30,
        reason: '维持',
        evidenceIds: ['E1'],
      },
      {
        concept: '机器人',
        targetWeightPct: 8,
        reason: '新增方向',
        evidenceIds: ['E2'],
      },
    ],
    scenarioPlan: [
      { regime: 'strong', signal: '放量', targetPositionPct: 78, actions: ['加仓'] },
      { regime: 'weak', signal: '跌破', targetPositionPct: 55, actions: ['减仓'] },
    ],
  }, {
    distribution,
    allowedEvidenceIds: ['E1', 'E2'],
    allowedHoldingCodes: ['300476', '600276'],
    allowedRecommendationCodes: ['002747'],
    recommendationCatalog: {
      '002747': {
        code: '002747',
        name: '埃斯顿',
        concept: '机器人',
        price: 30,
      },
    },
  })

  assert.equal(result.executionPlan.projectedPositionPct, 72)
  assert.match(result.executionPlan.todayGoal, /减持胜宏科技1手/)
  assert.match(result.executionPlan.todayGoal, /新买埃斯顿1手/)
  assert.deepEqual(
    result.executionPlan.orders.map((order) => ({
      code: order.code,
      requested: order.requestedTargetWeightPct,
      projected: order.projectedWeightPct,
      lots: order.estimatedLots,
    })),
    [
      { code: '300476', requested: 35, projected: 39, lots: 1 },
      { code: '002747', requested: 8, projected: 3, lots: 1 },
    ],
  )
  assert.deepEqual(
    result.conceptActions.map((item) => [
      item.concept,
      item.targetWeightPct,
      item.executableTargetWeightPct,
    ]),
    [
      ['PCB', 35, 39],
      ['创新药', 30, 30],
      ['机器人', 8, 3],
    ],
  )
})
