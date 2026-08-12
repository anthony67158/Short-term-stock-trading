import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendExecution,
  createRecommendation,
  decisionLedgerStats,
  removeExecutions,
} from '../shared/decisionLedger.js'

const NOW = Date.parse('2026-08-10T02:00:00.000Z')

test('AI 建议只记录为 recommendation，不自动视为用户决策', () => {
  const recommendation = createRecommendation({
    id: 'rec_1',
    code: '600519',
    name: '贵州茅台',
    action: '回调再买',
    mode: 'buy_advice',
    priceAtAdvice: 1400,
  }, NOW)

  assert.equal(recommendation.kind, 'recommendation')
  assert.equal(recommendation.status, 'pending')
  assert.equal(recommendation.executedAt, null)
})

test('同股同方向的真实执行关联最近建议并标记已执行', () => {
  const older = createRecommendation({
    id: 'rec_old',
    code: '000001',
    action: '回调再买',
  }, NOW - 2 * 3600000)
  const latest = createRecommendation({
    id: 'rec_latest',
    code: '000001',
    action: '小仓试错',
  }, NOW - 3600000)

  const next = appendExecution([older, latest], {
    id: 'exec_1',
    code: '000001',
    side: 'buy',
    price: 10.5,
    qty: 2,
    source: 'manual',
  }, NOW)

  const execution = next.find((event) => event.id === 'exec_1')
  const linked = next.find((event) => event.id === 'rec_latest')
  assert.equal(execution.kind, 'execution')
  assert.equal(execution.linkedRecommendationId, 'rec_latest')
  assert.equal(execution.linkType, 'inferred')
  assert.equal(linked.status, 'executed')
  assert.equal(linked.linkedExecutionId, 'exec_1')
  assert.equal(next.find((event) => event.id === 'rec_old').status, 'pending')
})

test('方向冲突或超过 24 小时的交易不错误关联建议', () => {
  const buyRecommendation = createRecommendation({
    id: 'rec_buy',
    code: '000002',
    action: '立即买入',
  }, NOW - 25 * 3600000)

  const next = appendExecution([buyRecommendation], {
    id: 'exec_sell',
    code: '000002',
    side: 'sell',
    price: 8,
    qty: 1,
  }, NOW)

  const execution = next.find((event) => event.id === 'exec_sell')
  assert.equal(execution.linkedRecommendationId, null)
  assert.equal(next.find((event) => event.id === 'rec_buy').status, 'pending')
})

test('决策统计区分建议数、执行数和真实关联率', () => {
  const ledger = appendExecution([
    createRecommendation({ id: 'r1', code: '600001', action: '加仓' }, NOW - 1000),
    createRecommendation({ id: 'r2', code: '600002', action: '观望' }, NOW - 1000),
  ], {
    id: 'e1',
    code: '600001',
    side: 'buy',
    price: 12,
    qty: 1,
  }, NOW)

  assert.deepEqual(decisionLedgerStats(ledger), {
    recommendations: 2,
    actionableRecommendations: 1,
    pending: 0,
    executedRecommendations: 1,
    executions: 1,
    linkedExecutions: 1,
    adoptionRate: 100,
  })
})

test('删除错误交易流水会移除执行事件并恢复建议待执行状态', () => {
  const linked = appendExecution([
    createRecommendation({ id: 'r1', code: '600001', action: '加仓' }, NOW - 1000),
  ], {
    id: 'e1',
    transactionId: 'tx_1',
    code: '600001',
    side: 'buy',
    price: 12,
    qty: 1,
  }, NOW)

  const restored = removeExecutions(linked, ['tx_1'])

  assert.equal(restored.some((event) => event.kind === 'execution'), false)
  assert.equal(restored.find((event) => event.id === 'r1').status, 'pending')
  assert.equal(restored.find((event) => event.id === 'r1').linkedExecutionId, null)
})

test('真实止损执行关联建议并记录知行合一复盘', () => {
  const recommendation = createRecommendation({
    id: 'r-stop',
    code: '600001',
    action: '加仓',
    knowledgeActionPlan: {
      version: 1,
      action: '加仓',
      researchLogic: '支撑位企稳且资金流入',
      executionPlan: '10元加仓1手',
      triggerConditions: '站回VWAP',
      positionRule: '最多1手',
      riskPoints: '跌破支撑',
      stopLoss: { price: 9.6, condition: '有效跌破止损' },
      takeProfit: { price: 11, condition: '分批止盈' },
      exitConditions: '止损或止盈退出',
      invalidation: '跌破9.6元',
      validationWindow: '3个交易日',
      falsifiableClaim: '跌破9.6元则失效',
      preTradeChecklist: ['逻辑', '触发', '仓位', '退出', '周期'],
      plannedQuantity: 1,
    },
  }, NOW - 3600000)

  const opened = appendExecution([recommendation], {
    id: 'e-buy',
    code: '600001',
    side: 'buy',
    price: 10,
    qty: 1,
    outcome: {
      validationComplete: false,
    },
  }, NOW - 1800000)
  const next = appendExecution(opened, {
    id: 'e-stop',
    code: '600001',
    side: 'sell',
    price: 9.59,
    qty: 1,
    outcome: {
      pnl: -41,
      validationComplete: true,
      invalidated: true,
    },
  }, NOW)
  const execution = next.find((event) => event.id === 'e-stop')

  assert.equal(execution.knowledgeActionReview.attribution, 'judgment_error')
  assert.ok(execution.knowledgeActionReview.executionScore >= 90)
  assert.deepEqual(
    next.find((event) => event.id === 'r-stop').linkedExecutionIds,
    ['e-buy', 'e-stop'],
  )
  assert.equal(
    next.find((event) => event.id === 'r-stop').knowledgeActionReview.executionScore,
    execution.knowledgeActionReview.executionScore,
  )
})
