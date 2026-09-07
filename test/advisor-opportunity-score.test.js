import test from 'node:test'
import assert from 'node:assert/strict'

import {
  loadAdvisorOpportunityScore,
} from '../api/_advisor_opportunity_score.js'

const decision = {
  formulaId: 'INTRADAY_VWAP_PULLBACK',
  positionMode: 'UNOWNED',
  action: 'WATCH_BUY',
  primaryPrice: 10,
  priceType: 'PULLBACK_WATCH',
  stopPrice: 9.5,
  targetPrice: 11,
  riskReward: 2,
  priceContractValid: true,
}

const payload = {
  todayQuote: {
    price: 10.2,
    preClose: 10,
    open: 10.1,
    high: 10.4,
    low: 9.9,
    pct: 2,
    amount: 2e8,
    turnover: 3,
    volumeRatio: 1.5,
    mainRatio: 6,
    live: true,
  },
  stockFund: {
    mainNetYi: 0.8,
    retailNetYi: -0.2,
  },
  marketEnv: {
    allowRiskIncrease: true,
    weak: false,
  },
  sectorOpportunity: {
    sector: {
      code: 'BK001',
      name: '测试板块',
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
    },
  },
}

test('军师机会评分只使用服务端本轮证据并绑定价格合同', async () => {
  let received = null
  const result = await loadAdvisorOpportunityScore({
    code: '600001',
    name: '测试股份',
    formula: {
      evaluations: [{
        formulaId: 'INTRADAY_VWAP_PULLBACK',
        matched: true,
        score: 82,
        priceType: 'PULLBACK_WATCH',
      }],
    },
    decision,
    payload,
    candles: Array.from({ length: 30 }, (_, index) => ({
      open: 9 + index * 0.03,
      high: 9.2 + index * 0.03,
      low: 8.9 + index * 0.03,
      close: 9.1 + index * 0.03,
    })),
    trends: [{
      price: 10.1,
      avg: 10,
    }, {
      price: 10.2,
      avg: 10.05,
    }],
    now: Date.parse('2026-09-07T02:30:00.000Z'),
    scoreOpportunities: async (inputs) => {
      received = inputs[0]
      return new Map([['600001', {
        schemaVersion: 'opportunity-score.v1',
        state: 'READY',
        modelVersion: 'opportunity-score.20260907',
        code: '600001',
        formulaId: 'INTRADAY_VWAP_PULLBACK',
        pFill: 0.72,
        pWinGivenFill: 0.61,
        expectedNetR: 0.18,
        netRLowerBound: 0.03,
        expectedShortfall10: -1.12,
        calibration: {
          method: 'isotonic',
          sampleCount: 400,
        },
      }]])
    },
  })

  assert.equal(received.code, '600001')
  assert.equal(received.factors.formulaScore, 82)
  assert.equal(received.factors.market_STANDARD, 1)
  assert.equal(result.serverVerified, true)
  assert.deepEqual(result.priceContract, {
    entryPrice: 10,
    stopPrice: 9.5,
    targetPrice: 11,
  })
})

test('持仓或不完整价格合同不调用机会评分模型', async () => {
  let calls = 0
  const result = await loadAdvisorOpportunityScore({
    code: '600001',
    decision: {
      ...decision,
      positionMode: 'HELD',
    },
    payload,
    scoreOpportunities: async () => {
      calls += 1
      return new Map()
    },
  })

  assert.equal(result, null)
  assert.equal(calls, 0)
})
