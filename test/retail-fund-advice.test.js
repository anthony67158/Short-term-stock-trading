import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADVISOR_FAST_SYSTEM,
  ADVISOR_SYSTEM,
  buildUserPrompt,
} from '../api/_ai_prompts.js'
import { mapRealtimeStockFund } from '../api/ai.js'
import {
  buildRetailFlowEvidence,
  mergeRetailFundFlow,
} from '../shared/retailFundFlow.js'

test('实时资金快照同时映射主力与小单净流入', () => {
  const snapshot = mapRealtimeStockFund({
    f62: 120_000_000,
    f84: -80_000_000,
    f184: 6.2,
    f66: 70_000_000,
    f72: 50_000_000,
  })

  assert.equal(snapshot.mainNetYi, 1.2)
  assert.equal(snapshot.smallNetYi, -0.8)
  assert.equal(snapshot.retailNetYi, -0.8)
})

test('主力流出且小单流入识别为散户承接风险而非买入信号', () => {
  const evidence = buildRetailFlowEvidence({
    mainNetYi: -1.2,
    retailNetYi: 0.8,
    pct: 4.5,
    turnover: 12,
    volRatio: 2.2,
    asOfDate: '2026-08-24',
    isHistorical: false,
  })

  assert.equal(evidence.relation, 'main_out_retail_in')
  assert.equal(evidence.bias, 'risk')
  assert.match(evidence.interpretation, /小单承接大单抛压/)
  assert.match(evidence.confirmation, /高位|放量|冲高/)
  assert.match(evidence.caveat, /不等于真实账户身份/)
})

test('主力流入且小单流出识别为可能承接但要求量价确认', () => {
  const evidence = buildRetailFlowEvidence({
    mainNetYi: 1.5,
    smallNetYi: -0.6,
    pct: 1.8,
  })

  assert.equal(evidence.relation, 'main_in_retail_out')
  assert.equal(evidence.bias, 'constructive')
  assert.match(evidence.interpretation, /大单承接小单抛压/)
  assert.match(evidence.confirmation, /价格|量能/)
})

test('盘中行情资金可兜底历史接口且非实时快照不能覆盖历史值', () => {
  const live = mergeRetailFundFlow(null, {
    live: true,
    asOfLabel: '2026-08-24',
    pct: 3.2,
    turnover: 9,
    volRatio: 1.8,
    mainNetYi: -1.1,
    retailNetYi: 0.7,
  })
  assert.equal(live.isHistorical, false)
  assert.equal(live.retailFlow.relation, 'main_out_retail_in')

  const historical = mergeRetailFundFlow({
    asOfDate: '2026-08-21',
    isHistorical: true,
    mainNetYi: 1.3,
    smallNetYi: -0.5,
  }, {
    live: false,
    mainNetYi: -9,
    retailNetYi: 9,
  })
  assert.equal(historical.mainNetYi, 1.3)
  assert.equal(historical.retailNetYi, -0.5)
  assert.equal(historical.retailFlow.relation, 'main_in_retail_out')
})

test('缺失的主力或散户资金保持null而不是伪装成0', () => {
  const evidence = buildRetailFlowEvidence({
    mainNetYi: null,
    retailNetYi: 0.4,
  })

  assert.equal(evidence.mainNetYi, null)
  assert.equal(evidence.retailNetYi, 0.4)
  assert.equal(evidence.relation, 'partial')
})

test('军师快速、深度与复核提示都强制合参散户资金', () => {
  const payload = {
    code: '600000',
    generationProfile: 'FAST',
    stockFund: {
      mainNetYi: -1.2,
      retailNetYi: 0.8,
      smallNetYi: 0.8,
      retailFlow: {
        relation: 'main_out_retail_in',
        interpretation: '大单主动卖出、小单主动买入，可能是小单承接大单抛压。',
      },
    },
  }
  const fast = buildUserPrompt('hold_advice', payload)
  const review = buildUserPrompt('review', {
    ...payload,
    generationProfile: 'DEEP',
  })

  assert.match(ADVISOR_SYSTEM, /小单净流入/)
  assert.match(ADVISOR_SYSTEM, /不等于真实账户身份/)
  assert.match(ADVISOR_FAST_SYSTEM, /散户资金/)
  assert.match(fast, /fundNote.*mainNetYi.*retailNetYi/)
  assert.match(review, /fundNote.*主力.*散户/)
  assert.match(review, /main_out_retail_in/)

  const limitUp = buildUserPrompt('hold_advice', {
    ...payload,
    generationProfile: 'DEEP',
    todayQuote: {
      live: true,
      price: 11,
      pct: 10,
      isLimitUp: true,
    },
  })
  assert.doesNotMatch(ADVISOR_SYSTEM, /涨停→今日主力大幅流入/)
  assert.doesNotMatch(limitUp, /说明今日主力大幅流入/)
  assert.match(limitUp, /资金净额.*被动成交|被动排队.*资金/)
})
