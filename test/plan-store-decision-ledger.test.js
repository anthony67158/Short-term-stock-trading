import test from 'node:test'
import assert from 'node:assert/strict'

import { planStore } from '../src/planStore.js'

test('生成 AI 建议不会增加真实执行数', () => {
  planStore.setData({ plan: [], holding: [], closed: [], decisionLog: [] })

  planStore.logAdvice({
    code: '600519',
    name: '贵州茅台',
    mode: 'buy_advice',
    action: '立即买入',
    priceAtAdvice: 1400,
  })

  assert.deepEqual(planStore.decisionStats(), {
    recommendations: 1,
    actionableRecommendations: 1,
    pending: 1,
    executedRecommendations: 0,
    executions: 0,
    linkedExecutions: 0,
    adoptionRate: 0,
  })
})

test('真实买入会新增 execution 并关联同方向建议', () => {
  planStore.setData({
    plan: [{ code: '000001', name: '平安银行' }],
    holding: [],
    closed: [],
    decisionLog: [],
  })
  planStore.logAdvice({
    code: '000001',
    name: '平安银行',
    mode: 'buy_advice',
    action: '小仓试错',
    priceAtAdvice: 10,
  })

  planStore.buy('000001', 10, 1)

  const stats = planStore.decisionStats()
  const execution = planStore.get().decisionLog.find((event) => event.kind === 'execution')
  assert.equal(stats.executions, 1)
  assert.equal(stats.linkedExecutions, 1)
  assert.equal(stats.executedRecommendations, 1)
  assert.equal(execution.side, 'buy')
  assert.equal(execution.price, 10)
  assert.equal(execution.qty, 1)
})

test('删除已记录交易会同步回滚决策闭环统计', () => {
  planStore.setData({
    plan: [{ code: '000001', name: '平安银行' }],
    holding: [],
    closed: [],
    decisionLog: [],
  })
  planStore.logAdvice({
    code: '000001',
    name: '平安银行',
    mode: 'buy_advice',
    action: '小仓试错',
    priceAtAdvice: 10,
  })
  planStore.buy('000001', 10, 1)
  const buy = planStore.get().closed.find((record) => record.type === 'BUY')

  planStore.removeClosed(buy.id)

  const stats = planStore.decisionStats()
  assert.equal(stats.executions, 0)
  assert.equal(stats.executedRecommendations, 0)
  assert.equal(stats.pending, 1)
})
