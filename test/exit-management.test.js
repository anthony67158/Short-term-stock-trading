import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyShortHorizonExitPolicy,
  EXIT_MANAGEMENT_VERSION,
} from '../shared/exitManagement.js'
import {
  portfolioOpportunityCostForStock,
} from '../api/ai.js'

const basePayload = {
  code: '600000',
  holdCost: 10,
  holdQty: 4,
  sellableTodayQty: 4,
  nextTradeDay: '2026-08-27',
  todayQuote: {
    price: 10.8,
    high: 11,
    live: true,
  },
  intraday: {
    now: 10.8,
    vsVwap: 0.3,
    rhythm: '横盘',
  },
  tech: { atr: { atr: 0.2 } },
  shortHorizonTactical: {
    sector: { state: 'CONFIRMING', stockRole: 'FRONT_ROW' },
    stock: { relativeStrength: 68 },
    flow: { relation: 'ACCUMULATION' },
    catalyst: { risk: 'NEUTRAL' },
    timing: { reviewAfter: 'FIVE_MINUTE_BAR' },
  },
}

test('硬止损优先于其他退出条件且直接覆盖为风险退出', () => {
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice',
    result: {
      action: '持有',
      stopPrice: 9.8,
      targetPrice: 11.5,
    },
    payload: {
      ...basePayload,
      todayQuote: { price: 9.7, high: 10.2, live: true },
      intraday: { now: 9.7, atDayLow: true, rhythm: '放量破位' },
      shortHorizonTactical: {
        ...basePayload.shortHorizonTactical,
        sector: { state: 'WEAKENING', stockRole: 'LAGGARD' },
        flow: { relation: 'DISTRIBUTION' },
      },
    },
  })

  assert.equal(result.action, '清仓')
  assert.equal(result.opQty, '清仓4手')
  assert.equal(result.exitManagement.schemaVersion, EXIT_MANAGEMENT_VERSION)
  assert.equal(result.exitManagement.kind, 'HARD_STOP')
  assert.equal(result.exitManagement.priority, 1)
  assert.match(result.exitTiming, /不等待模型再次生成/)
})

test('硬止损触发但仓位受T+1锁定时转为下一交易日优先退出', () => {
  const result = applyShortHorizonExitPolicy({
    mode: 'review',
    result: {
      stance: '持有',
      stopPrice: 9.8,
    },
    payload: {
      ...basePayload,
      sellableTodayQty: 0,
      todayQuote: { price: 9.7, high: 10.2, live: false },
    },
  })

  assert.equal(result.action, '持有')
  assert.equal(result.opQty, '今日不可卖')
  assert.equal(result.exitManagement.kind, 'HARD_STOP')
  assert.equal(result.exitManagement.blockedByT1, true)
  assert.match(result.actionPlan, /2026-08-27优先退出/)
})

test('派发并掉队时按第二优先级释放一半可卖仓位', () => {
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice',
    result: {
      action: '持有',
      stopPrice: 9.5,
      targetPrice: 12,
    },
    payload: {
      ...basePayload,
      shortHorizonTactical: {
        ...basePayload.shortHorizonTactical,
        sector: { state: 'WEAKENING', stockRole: 'LAGGARD' },
        flow: { relation: 'DISTRIBUTION' },
      },
    },
  })

  assert.equal(result.action, '减仓')
  assert.equal(result.opQty, '减仓2手')
  assert.equal(result.exitManagement.kind, 'STRUCTURAL_EXIT')
  assert.equal(result.exitManagement.priority, 2)
})

test('达到目标位时确定性分批止盈而不等待模型重跑', () => {
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice',
    result: {
      action: '持有',
      stopPrice: 9.5,
      targetPrice: 10.6,
    },
    payload: basePayload,
  })

  assert.equal(result.action, '减仓')
  assert.equal(result.opQty, '减仓2手')
  assert.equal(result.exitManagement.kind, 'TAKE_PROFIT')
  assert.match(result.actionPlan, /分批锁定利润/)
})

test('盈利后从高点回撤且分时转弱时启动移动保护', () => {
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice',
    result: {
      action: '持有',
      stopPrice: 9.5,
      targetPrice: 13,
    },
    payload: {
      ...basePayload,
      holdingPeakPrice: 12,
      todayQuote: { price: 11.5, high: 12, live: true },
      intraday: { now: 11.5, vsVwap: -0.6, rhythm: '冲高回落' },
    },
  })

  assert.equal(result.action, '减仓')
  assert.equal(result.exitManagement.kind, 'TRAILING_PROTECT')
  assert.match(result.actionPlan, /从高点回撤/)
})

test('建议窗口到期且存在更强候选时只触发机会成本复核', () => {
  const now = Date.parse('2026-08-26T06:00:00.000Z')
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice',
    result: {
      action: '持有',
      stopPrice: 9.5,
      targetPrice: 12,
    },
    payload: {
      ...basePayload,
      previousAdvice: {
        decisionPlan: {
          validUntil: '2026-08-26T05:00:00.000Z',
        },
      },
      shortHorizonTactical: {
        ...basePayload.shortHorizonTactical,
        opportunityCost: {
          targetCode: '000001',
          targetName: '平安银行',
          edgeScore: 12,
        },
      },
    },
    now,
  })

  assert.equal(result.action, '持有')
  assert.equal(result.exitManagement.kind, 'OPPORTUNITY_REVIEW')
  assert.match(result.reviewTrigger, /平安银行.*12分/)
})

test('机会成本只从账号内已验证的首要轮动读取', () => {
  const accountData = {
    portfolioAnalysisLatest: {
      generatedAt: 123,
      result: {
        analysis: {
          executionPlan: {
            primaryRotation: {
              status: 'READY',
              actionable: true,
              source: { code: '600000' },
              target: { code: '000001', name: '平安银行' },
              comparison: { edgeScore: 14 },
              costs: { total: 36.5 },
            },
          },
        },
      },
    },
  }

  assert.deepEqual(
    portfolioOpportunityCostForStock(accountData, '600000'),
    {
      schemaVersion: 'opportunity-cost.v1',
      status: 'READY',
      actionable: true,
      sourceCode: '600000',
      targetCode: '000001',
      targetName: '平安银行',
      edgeScore: 14,
      tradingCost: 36.5,
      generatedAt: 123,
    },
  )
  assert.equal(
    portfolioOpportunityCostForStock(accountData, '600001'),
    null,
  )
})
