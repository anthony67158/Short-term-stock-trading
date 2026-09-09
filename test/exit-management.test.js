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

test('重新生成不能下移账本止损来掩盖已经发生的破位', () => {
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice',
    result: { action: '持有', stopPrice: 9, targetPrice: 12 },
    payload: { ...basePayload, holdingStopPrice: 10,
      todayQuote: { price: 9.7, live: true } },
  })
  assert.equal(result.stopPrice, 10)
  assert.equal(result.exitManagement.kind, 'HARD_STOP')
  assert.equal(result.opQty, '清仓4手')
})

test('持仓到期不机械退出而由当前动作价值继续管理', () => {
  const started = Date.parse('2026-09-03T02:00:00Z')
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice', now: Date.parse('2026-09-09T06:50:00Z'),
    result: { action: '持有', stopPrice: 9, targetPrice: 13 },
    payload: { ...basePayload, holdingStartedAt: started, sellableTodayQty: 2 },
  })
  assert.equal(result.exitManagement.kind, 'HOLD')
  assert.equal(result.action, '加仓')
  assert.equal(result.adaptiveAction.selected.action, 'ADD')
  assert.ok(result.exitManagement.actionValue)
  assert.equal(result.exitManagement.actionValue.state.sellable, 2)
})

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

test('派发并掉队时动作价值允许直接退出全部可卖仓位', () => {
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

  assert.equal(result.action, '清仓')
  assert.equal(result.opQty, '清仓4手')
  assert.equal(result.exitManagement.kind, 'STRUCTURAL_EXIT')
  assert.equal(result.exitManagement.priority, 2)
})

test('一手持仓的风险释放必须是清仓而不是减仓', () => {
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice',
    result: {
      action: '持有',
      stopPrice: 9.5,
      targetPrice: 12,
    },
    payload: {
      ...basePayload,
      holdQty: 1,
      sellableTodayQty: 1,
      shortHorizonTactical: {
        ...basePayload.shortHorizonTactical,
        sector: { state: 'WEAKENING', stockRole: 'LAGGARD' },
        flow: { relation: 'DISTRIBUTION' },
      },
    },
  })

  assert.equal(result.action, '清仓')
  assert.equal(result.opQty, '清仓1手')
  assert.equal(result.exitManagement.action, '清仓')
  assert.match(result.exitTiming, /持仓归零/)
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
  assert.match(result.actionPlan, /达到计划目标/)
})

test('盈利后从高点回撤且分时转弱时动作价值主动减仓', () => {
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
  assert.equal(result.exitManagement.kind, 'VALUE_DECAY')
  assert.match(result.actionPlan, /从持仓高点回撤/)
})

test('存在明显更强候选时直接降低当前仓位释放机会成本', () => {
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

  assert.equal(result.action, '减仓')
  assert.equal(result.exitManagement.kind, 'VALUE_DECAY')
  assert.match(result.exitManagement.reason, /替代机会优势高12分/)
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
    portfolioOpportunityCostForStock(accountData, '600000', 1123),
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
    portfolioOpportunityCostForStock(accountData, '600001', 1123),
    null,
  )
  assert.equal(
    portfolioOpportunityCostForStock(
      accountData,
      '600000',
      123 + 25 * 3600 * 1000,
    ),
    null,
  )
})

test('持仓最终动作服从模型调用前的自适应动作价值', () => {
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice',
    result: {
      action: '加仓',
      opQty: '加仓4手',
      stopPrice: 8,
      targetPrice: 15,
    },
    payload: {
      ...basePayload,
      holdingStopPrice: 9.5,
      adaptiveAction: {
        schemaVersion: 'holding-action-value.v2',
        selected: {
          action: 'REDUCE',
          quantity: 2,
          reasons: ['替代机会费后价值更高'],
        },
        alternatives: [],
        economics: { expectedNetR: -0.1 },
      },
    },
  })

  assert.equal(result.action, '减仓')
  assert.equal(result.opQty, '减仓2手')
  assert.equal(result.stopPrice, 9.5)
  assert.equal(result.adaptiveAction.selected.action, 'REDUCE')
})

test('模型清仓文本不能覆盖服务端已选继续持有动作', () => {
  const result = applyShortHorizonExitPolicy({
    mode: 'hold_advice',
    result: {
      action: '清仓',
      opQty: '清仓4手',
      stopPrice: 9,
      targetPrice: 12,
    },
    payload: {
      ...basePayload,
      adaptiveAction: {
        schemaVersion: 'holding-action-value.v2',
        selected: {
          action: 'HOLD',
          quantity: 0,
          reasons: ['继续持有费后价值仍为正'],
        },
        alternatives: [],
        economics: { expectedNetR: 0.3 },
      },
    },
  })

  assert.equal(result.action, '持有')
  assert.equal(result.opQty, '无需操作')
  assert.equal(result.addPrice, null)
  assert.equal(result.exitManagement.action, '持有')
})
