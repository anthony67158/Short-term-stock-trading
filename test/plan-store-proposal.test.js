import test from 'node:test'
import assert from 'node:assert/strict'

import { planStore } from '../src/planStore.js'

const buyProposal = {
  id: 'proposal_buy_1',
  code: '600519',
  name: '贵州茅台',
  action: 'buy',
  entryPrice: 1400,
  targetPrice: 1500,
  stopPrice: 1350,
  qty: 1,
  triggerOp: 'lte',
  reason: '回踩后试仓',
  confirmSignal: '缩量企稳',
  evidenceIds: ['证据1'],
}

test('确认买入提案会加入自选、保存计划并创建预警', () => {
  planStore.setData({ plan: [], holding: [], closed: [], alerts: [], decisionLog: [] })

  const result = planStore.applyAssistantProposal(buyProposal)
  const state = planStore.get()

  assert.equal(result.ok, true)
  assert.equal(state.plan.length, 1)
  assert.equal(state.plan[0].targetPrice, 1400)
  assert.equal(state.plan[0].buyQty, 1)
  assert.equal(state.plan[0].tp, 1500)
  assert.equal(state.plan[0].sl, 1350)
  assert.equal(state.alerts.filter((item) => item.proposalId === buyProposal.id).length, 1)
  assert.equal(state.decisionLog.filter((item) => item.kind === 'plan' && item.proposalId === buyProposal.id).length, 1)
  assert.equal(planStore.decisionStats().executions, 0)
})

test('重复确认同一提案不会重复创建计划或预警', () => {
  planStore.setData({ plan: [], holding: [], closed: [], alerts: [], decisionLog: [] })

  planStore.applyAssistantProposal(buyProposal)
  const result = planStore.applyAssistantProposal(buyProposal)
  const state = planStore.get()

  assert.equal(result.ok, true)
  assert.equal(result.alreadyApplied, true)
  assert.equal(state.plan.length, 1)
  assert.equal(state.alerts.filter((item) => item.proposalId === buyProposal.id).length, 1)
})

test('持仓减仓提案会更新止盈止损并增加动作预警', () => {
  planStore.setData({
    plan: [],
    holding: [{ id: 'h1', code: '000001', name: '平安银行', qty: 2, buyPrice: 10, buyAt: 1, buyFee: 5 }],
    closed: [],
    alerts: [],
    decisionLog: [],
  })
  const proposal = {
    id: 'proposal_sell_1',
    code: '000001',
    name: '平安银行',
    action: 'reduce',
    entryPrice: 11.5,
    targetPrice: 12,
    stopPrice: 9.8,
    qty: 1,
    triggerOp: 'gte',
    reason: '反弹减仓',
    evidenceIds: ['证据2'],
  }

  const result = planStore.applyAssistantProposal(proposal)
  const state = planStore.get()
  const holding = state.holding[0]

  assert.equal(result.ok, true)
  assert.equal(holding.tp, 12)
  assert.equal(holding.sl, 9.8)
  assert.equal(state.alerts.some((item) => item.proposalId === proposal.id && item.value === 11.5), true)
})

test('账本入口再次拒绝非法提案', () => {
  planStore.setData({ plan: [], holding: [], closed: [], alerts: [], decisionLog: [] })
  const result = planStore.applyAssistantProposal({ code: 'bad', action: 'buy', entryPrice: 10, triggerOp: 'lte' })
  assert.equal(result.ok, false)
  assert.equal(planStore.get().alerts.length, 0)
})

test('账本入口拒绝没有数据证据的助手提案', () => {
  planStore.setData({ plan: [], holding: [], closed: [], alerts: [], decisionLog: [] })
  const result = planStore.applyAssistantProposal({
    ...buyProposal,
    id: 'proposal_without_evidence',
    evidenceIds: [],
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /证据/)
  assert.equal(planStore.get().plan.length, 0)
  assert.equal(planStore.get().alerts.length, 0)
  assert.equal(planStore.decisionStats().executions, 0)
})

test('减仓提案手数超过今日可卖量时拒绝落账', () => {
  planStore.setData({
    plan: [],
    holding: [{ id: 'h1', code: '000001', name: '平安银行', qty: 2, buyPrice: 10, buyAt: 1, buyFee: 5 }],
    closed: [],
    alerts: [],
    decisionLog: [],
  })
  const result = planStore.applyAssistantProposal({
    id: 'too_many',
    code: '000001',
    name: '平安银行',
    action: 'reduce',
    entryPrice: 11.5,
    qty: 3,
    triggerOp: 'gte',
    reason: '减仓',
    evidenceIds: ['证据1'],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /可卖/)
  assert.equal(planStore.get().alerts.length, 0)
})
