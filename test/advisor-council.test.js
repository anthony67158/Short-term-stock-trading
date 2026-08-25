import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileAdvisorCouncil,
  proposalFromAdvice,
} from '../shared/advisorCouncil.js'

const opinions = [
  {
    role: 'researcher',
    verdict: 'support',
    confidence: 75,
    thesis: '趋势与量价共振',
  },
  {
    role: 'risk_officer',
    verdict: 'support',
    confidence: 70,
    thesis: '仓位可控',
    veto: false,
  },
  {
    role: 'skeptic',
    verdict: 'oppose',
    confidence: 60,
    thesis: '可能是假突破',
  },
]

test('军师结构化建议可编译为统一交易提案', () => {
  const proposal = proposalFromAdvice({
    code: '600001',
    name: '样本股份',
    mode: 'buy_advice',
    advice: {
      action: '回调再买',
      buyPrice: 10,
      stopPrice: 9.5,
      targetPrice: 11.2,
      planQtyNum: 2,
      reason: '等回踩确认',
    },
  })

  assert.equal(proposal.action, 'buy')
  assert.equal(proposal.entryPrice, 10)
  assert.equal(proposal.qty, 2)
  assert.equal(proposal.triggerOp, 'lte')
})

test('委员会交易提案只采用价格契约中的精确价位', () => {
  const proposal = proposalFromAdvice({
    code: '600519',
    name: '贵州茅台',
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10.2,
      stopPrice: 9.4,
      targetPrice: 11.2,
      planQty: 2,
      priceContract: {
        schemaVersion: 'advice-price-contract.v1',
        validationStatus: 'VERIFIED',
        levels: [
          {
            key: 'entry',
            field: 'buyPrice',
            purpose: 'ENTRY',
            price: 10,
            direction: 'LTE',
            strict: true,
          },
          {
            key: 'stop',
            field: 'stopPrice',
            purpose: 'RISK',
            price: 9.5,
            direction: 'LTE',
            strict: true,
          },
          {
            key: 'target',
            field: 'targetPrice',
            purpose: 'OBJECTIVE',
            price: 11,
            direction: 'GTE',
            strict: true,
          },
        ],
        allPricesStrict: true,
        issues: [],
        review: { operator: 'ALL', conditions: [], allMet: false },
      },
    },
  })

  assert.equal(proposal.entryPrice, 10)
  assert.equal(proposal.stopPrice, 9.5)
  assert.equal(proposal.targetPrice, 11)
})

test('委员会拒绝价格契约未通过的交易提案', () => {
  const proposal = proposalFromAdvice({
    code: '600519',
    name: '贵州茅台',
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      planQty: 2,
      priceContract: {
        schemaVersion: 'advice-price-contract.v1',
        validationStatus: 'REJECTED',
        levels: [],
        allPricesStrict: false,
        issues: ['buyPrice缺少可核验依据'],
        review: { operator: 'ALL', conditions: [], allMet: false },
      },
    },
  })

  assert.equal(proposal, null)
})

test('当前策略REJECT时买入委员会只能记录影子阻断结果', () => {
  const result = compileAdvisorCouncil({
    opinions,
    proposal: proposalFromAdvice({
      code: '600001',
      mode: 'buy_advice',
      advice: {
        action: '立即买入',
        buyPrice: 10,
        stopPrice: 9.5,
        targetPrice: 11,
        planQty: 2,
      },
    }),
    account: {
      cash: 10000,
      totalAssets: 50000,
      position: 40,
      stockWeight: 0,
      holdQty: 0,
    },
    strategyGate: { productionEligible: false },
    evidenceSnapshotId: 'ev_1',
  })

  assert.equal(result.shadowOnly, true)
  assert.equal(result.actionable, false)
  assert.equal(result.compiled.consensusReached, true)
  assert.equal(result.compiled.hardGatePassed, false)
  assert.ok(result.compiled.blockers.includes('策略尚未通过生产晋级门禁'))
})

test('风险官否决优先于多数支持且T+1限制卖出数量', () => {
  const result = compileAdvisorCouncil({
    opinions: opinions.map((item) =>
      item.role === 'risk_officer' ? { ...item, veto: true } : item
    ),
    proposal: {
      id: 'sell',
      code: '600001',
      name: '样本股份',
      action: 'sell',
      entryPrice: 9.5,
      qty: 2,
      triggerOp: 'lte',
      reason: '止损',
    },
    account: {
      holdQty: 3,
      sellableTodayQty: 1,
    },
    strategyGate: { productionEligible: false },
    evidenceSnapshotId: 'ev_2',
  })

  assert.equal(result.compiled.hardGatePassed, false)
  assert.ok(result.compiled.blockers.includes('风险官否决'))
  assert.ok(result.compiled.blockers.includes('卖出手数超过今日可卖数量'))
})

test('降低风险的卖出不受策略REJECT阻断但仍保持影子不可执行', () => {
  const result = compileAdvisorCouncil({
    opinions,
    proposal: {
      id: 'sell',
      code: '600001',
      name: '样本股份',
      action: 'sell',
      entryPrice: 9.5,
      qty: 1,
      triggerOp: 'lte',
      reason: '止损',
    },
    account: {
      holdQty: 3,
      sellableTodayQty: 2,
    },
    strategyGate: { productionEligible: false },
    evidenceSnapshotId: 'ev_3',
  })

  assert.equal(result.compiled.hardGatePassed, true)
  assert.equal(result.compiled.eligibleForConfirmation, true)
  assert.equal(result.shadowOnly, true)
  assert.equal(result.actionable, false)
})

test('委员会拒绝缺少手数、实时价带越界和账户事实不完整的提案', () => {
  const result = compileAdvisorCouncil({
    opinions,
    proposal: {
      id: 'buy',
      code: '600001',
      name: '样本股份',
      action: 'buy',
      entryPrice: 11.5,
      targetPrice: 12,
      stopPrice: 10,
      triggerOp: 'lte',
      reason: '突破买入',
    },
    account: {
      holdQty: 0,
      cash: 10000,
    },
    quote: {
      live: true,
      limitDownPrice: 9,
      limitUpPrice: 11,
    },
    strategyGate: { productionEligible: true },
    evidenceSnapshotId: 'ev_4',
  })

  assert.equal(result.compiled.hardGatePassed, false)
  assert.ok(result.compiled.blockers.includes('缺少可执行整数手数'))
  assert.ok(result.compiled.blockers.includes('交易价格超出实时合法价带'))
  assert.ok(result.compiled.blockers.includes('账户风险事实不完整'))
})
