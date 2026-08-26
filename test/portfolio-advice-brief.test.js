import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPortfolioAdviceBrief,
} from '../shared/portfolioAdviceBrief.js'

test('持仓建议摘要只保留操作结论、可执行动作和推荐股票原因', () => {
  const brief = buildPortfolioAdviceBrief({
    headline: '组合集中度偏高，应降低单一概念暴露',
    positionAssessment: {
      rationale: '当前总仓位82%，机器人概念占比过高，需要先减仓并提高现金储备。',
    },
    executionPlan: {
      todayGoal: '先减机器人概念，再用小仓关注存储芯片',
      projectedPositionPct: 68,
      primaryRotation: {
        status: 'READY',
        actionable: true,
        summary: '先释放机器人股份2手，放量站稳后转入长鑫科技1手',
        source: {
          code: '600001',
          name: '机器人股份',
          lots: 2,
          referencePrice: 110,
        },
        target: {
          code: '688825',
          name: '长鑫科技',
          lots: 1,
          referencePrice: 98,
        },
        comparison: { edgeScore: 18 },
        costs: { total: 42.5 },
        funding: { netCashChange: 12100 },
        t1: {
          note: '新买仓位当日不可卖出，需承担隔夜风险',
        },
        blockedReasons: [],
      },
      orders: [{
        priority: 1,
        action: 'reduce',
        code: '600001',
        name: '机器人股份',
        concept: '机器人',
        estimatedLots: 2,
        estimatedAmount: 22000,
        referencePrice: 110,
        reason: '单一概念占比过高且量化转弱，应先降低组合波动。',
      }, {
        priority: 2,
        action: 'buy',
        code: '688825',
        name: '长鑫科技',
        concept: '存储芯片',
        estimatedLots: 1,
        estimatedAmount: 9800,
        referencePrice: 98,
        reason: '存储芯片资金持续流入，真实成分股领导力较强。',
      }],
    },
    recommendations: [{
      priority: 1,
      code: '688825',
      name: '长鑫科技',
      concept: '存储芯片',
      reason: '存储芯片资金持续流入，真实成分股领导力较强。',
    }, {
      priority: 2,
      code: '600584',
      name: '长电科技',
      concept: '半导体',
      reason: '板块成交额充足，趋势与量价结构相对稳定。',
    }],
  })

  assert.equal(brief.conclusion, '先减机器人概念，再用小仓关注存储芯片')
  assert.match(brief.logic, /组合集中度偏高/)
  assert.equal(brief.actions.length, 2)
  assert.deepEqual(
    brief.actions.map((item) => [item.actionLabel, item.name, item.lots]),
    [['减持', '机器人股份', 2], ['新买', '长鑫科技', 1]],
  )
  assert.deepEqual(
    brief.recommendations.map((item) => item.code),
    ['688825', '600584'],
  )
  assert.match(brief.recommendations[0].reason, /资金持续流入/)
  assert.equal(brief.projectedPositionPct, 68)
  assert.equal(brief.primaryRotation.status, 'READY')
  assert.equal(brief.primaryRotation.source.code, '600001')
  assert.equal(brief.primaryRotation.target.code, '688825')
  assert.equal(brief.primaryRotation.edgeScore, 18)
  assert.equal(brief.primaryRotation.tradingCost, 42.5)
})

test('持仓建议摘要对重复推荐去重并限制长文长度', () => {
  const longReason = '推荐原因'.repeat(80)
  const brief = buildPortfolioAdviceBrief({
    headline: longReason,
    executionPlan: {
      orders: [{
        action: 'buy',
        code: '600001',
        name: '甲公司',
        concept: '机器人',
        estimatedLots: 1,
        reason: longReason,
      }],
    },
    recommendations: [{
      code: '600001',
      name: '甲公司',
      concept: '机器人',
      reason: longReason,
    }],
  })

  assert.equal(brief.recommendations.length, 1)
  assert.ok(brief.logic.length <= 100)
  assert.ok(brief.actions[0].reason.length <= 100)
  assert.ok(brief.recommendations[0].reason.length <= 100)
})

test('没有新增推荐时明确提示本次不新增股票', () => {
  const brief = buildPortfolioAdviceBrief({
    headline: '维持现有组合',
    executionPlan: {
      todayGoal: '现有持仓继续观察',
      orders: [{
        action: 'reduce',
        code: '600001',
        name: '甲公司',
        estimatedLots: 1,
        reason: '降低集中度',
      }],
    },
    recommendations: [],
  })

  assert.deepEqual(brief.recommendations, [])
  assert.equal(brief.noRecommendationText, '本次不新增股票')
})
