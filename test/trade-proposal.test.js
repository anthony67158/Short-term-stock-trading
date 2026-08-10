import test from 'node:test'
import assert from 'node:assert/strict'

import {
  proposalAlertSpec,
  sanitizeTradeProposal,
} from '../shared/tradeProposal.js'

test('交易提案只保留白名单字段并过滤无效证据编号', () => {
  const proposal = sanitizeTradeProposal({
    id: 'p1',
    code: '600519',
    name: '贵州茅台',
    action: 'buy',
    entryPrice: 1400,
    targetPrice: 1500,
    stopPrice: 1350,
    qty: 2.8,
    triggerOp: 'lte',
    reason: '回踩关键位置后试仓',
    confirmSignal: '缩量企稳并站回均价线',
    evidenceIds: ['证据1', '证据9', '伪造'],
    password: '不应保留',
  }, ['证据1', '证据2'])

  assert.deepEqual(proposal, {
    id: 'p1',
    code: '600519',
    name: '贵州茅台',
    action: 'buy',
    entryPrice: 1400,
    targetPrice: 1500,
    stopPrice: 1350,
    qty: 2,
    triggerOp: 'lte',
    reason: '回踩关键位置后试仓',
    confirmSignal: '缩量企稳并站回均价线',
    evidenceIds: ['证据1'],
  })
  assert.equal('password' in proposal, false)
})

test('拒绝非法代码、动作、触发方向和买入价格关系', () => {
  assert.equal(sanitizeTradeProposal({ code: 'abc', action: 'buy', entryPrice: 10, triggerOp: 'lte' }), null)
  assert.equal(sanitizeTradeProposal({ code: '600519', action: 'hold', entryPrice: 10, triggerOp: 'lte' }), null)
  assert.equal(sanitizeTradeProposal({ code: '600519', action: 'buy', entryPrice: 10, stopPrice: 11, triggerOp: 'lte' }), null)
  assert.equal(sanitizeTradeProposal({ code: '600519', action: 'buy', entryPrice: 10, targetPrice: 9, triggerOp: 'lte' }), null)
  assert.equal(sanitizeTradeProposal({ code: '600519', action: 'sell', entryPrice: 10, stopPrice: 12, targetPrice: 11, triggerOp: 'gte' }), null)
  assert.equal(sanitizeTradeProposal({ code: '600519', action: 'buy', entryPrice: 10, triggerOp: 'bad' }), null)
})

test('提案转换为人工确认后的价格预警', () => {
  const add = sanitizeTradeProposal({
    code: '000001', name: '平安银行', action: 'add',
    entryPrice: 10.2, triggerOp: 'lte', qty: 1,
  })
  const sell = sanitizeTradeProposal({
    code: '000001', name: '平安银行', action: 'sell',
    entryPrice: 11.8, triggerOp: 'gte', qty: 1,
  })

  assert.deepEqual(proposalAlertSpec(add), {
    code: '000001',
    name: '平安银行',
    type: 'price',
    op: 'lte',
    value: 10.2,
    note: '助手提案·加仓',
    proposalId: add.id,
    phase: 'armed',
  })
  assert.equal(proposalAlertSpec(sell).note, '助手提案·卖出')
  assert.equal(proposalAlertSpec(sell).op, 'gte')
  assert.equal(proposalAlertSpec({ ...sell, id: 'stop', triggerOp: 'lte' }).note, '助手提案·止损卖出')
})
