import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTodayCommandList } from '../src/planStore.js'

const now = Date.parse('2026-09-09T02:00:00.000Z')

function entry(advice) {
  return { mode: advice.mode || 'buy_advice', at: now, advice }
}

test('当前指令优先退出风险并保留服务端核定数量', () => {
  const advice = new Map([
    ['600001:hold_advice', entry({
      mode: 'hold_advice',
      action: '减仓',
      actionPlan: '跌破10元减仓2手',
      decisionPlan: {
        schemaVersion: 'decision-plan.v2',
        action: 'REDUCE',
        actionability: 'READY',
        quantity: { lots: 2 },
        prices: { reference: 10, stop: 9.8 },
        validUntil: new Date(now + 60_000).toISOString(),
      },
    })],
    ['600002:buy_advice', entry({
      action: '观望',
      actionPlan: '回踩20元企稳后确认',
      decisionPlan: {
        schemaVersion: 'decision-plan.v2',
        action: 'WATCH',
        actionability: 'WATCH',
        quantity: { lots: 0 },
        entryBudget: {
          state: 'ESTIMATED',
          executionAllowed: false,
          lots: 3,
          stopLossAmount: 180,
        },
        prices: { watch: 20, observations: [{
          key: 'watch_pullback',
          label: '回踩观察',
          price: 20,
          direction: 'LTE',
        }] },
        priceContract: {
          schemaVersion: 'advice-price-contract.v1',
          levels: [{
            key: 'watch_pullback',
            label: '回踩观察',
            price: 20,
            direction: 'LTE',
            strict: true,
          }],
        },
        actionPolicy: {
          riskTier: 'PROBE',
          nextSessionPlan: {
            action: 'PROBE',
            session: 'NEXT_TRADING_DAY',
            trigger: '回踩20元企稳后确认',
          },
        },
        validUntil: new Date(now + 60_000).toISOString(),
      },
    })],
  ])
  const commands = buildTodayCommandList({
    book: {
      holding: [{ code: '600001', name: '退出股' }],
      plan: [{ code: '600002', name: '条件股' }],
      alerts: [],
      executionPlans: [],
    },
    quoteMap: {
      '600001': { price: 9.9 },
      '600002': { price: 20.2 },
    },
    adviceFor: (code, mode) => advice.get(`${code}:${mode}`),
    now,
  })

  assert.equal(commands[0].code, '600001')
  assert.equal(commands[0].state, 'READY_EXIT')
  assert.equal(commands[0].quantity, '减仓2手')
  assert.equal(commands[1].state, 'WAITING')
  assert.equal(commands[1].quantity, '3手')
  assert.equal(commands[1].riskAmount, 180)
})

test('执行计划与最新建议方向冲突时只输出冲突状态', () => {
  const commands = buildTodayCommandList({
    book: {
      holding: [{ code: '600003', name: '冲突股' }],
      plan: [],
      alerts: [],
      executionPlans: [{
        schemaVersion: 'execution-plan.v1',
        planId: 'execution.buy',
        code: '600003',
        side: 'BUY',
        actionLabel: '加仓',
        status: 'ARMED',
        remainingLots: 1,
        targetLots: 1,
        referencePrice: 10,
        triggerPrice: 10,
        validUntil: new Date(now + 60_000).toISOString(),
        updatedAt: now,
      }],
    },
    quoteMap: { '600003': { price: 10 } },
    adviceFor: () => entry({
      mode: 'hold_advice',
      action: '清仓',
      actionPlan: '跌破10元清仓',
      decisionPlan: {
        schemaVersion: 'decision-plan.v2',
        action: 'EXIT',
        actionability: 'READY',
        quantity: { lots: 1 },
        prices: { reference: 10 },
        validUntil: new Date(now + 60_000).toISOString(),
      },
    }),
    now,
  })

  assert.equal(commands[0].state, 'CONFLICT')
  assert.equal(commands[0].actionLabel, '计划冲突，暂停操作')
})

test('过期计划不能继续显示待触发或可执行', () => {
  const commands = buildTodayCommandList({
    book: {
      holding: [],
      plan: [{ code: '600004', name: '过期股' }],
      alerts: [{ code: '600004', phase: 'watching' }],
      executionPlans: [],
    },
    quoteMap: { '600004': { price: 10 } },
    adviceFor: () => entry({
      action: '观望',
      decisionPlan: {
        schemaVersion: 'decision-plan.v2',
        action: 'WATCH',
        actionability: 'WATCH',
        quantity: { lots: 0 },
        prices: { watch: 10 },
        validUntil: new Date(now - 1).toISOString(),
      },
    }),
    now,
  })

  assert.equal(commands[0].state, 'ENDED')
})

test('停止或成交完成的同版指令不能从缓存建议重新出现', () => {
  const commands = buildTodayCommandList({
    book: { holding: [], plan: [{ code: '600005' }], executionPlans: [{
      code: '600005', decisionId: 'closed-decision', status: 'COMPLETED',
    }] },
    adviceFor: () => entry({ action: '立即买入', decisionPlan: {
      schemaVersion: 'decision-plan.v2', decisionId: 'closed-decision', action: 'BUY',
      actionability: 'READY', quantity: { lots: 1 }, prices: { reference: 10 },
    } }),
    quoteMap: { '600005': { price: 10 } }, now,
  })
  assert.equal(commands[0].state, 'ENDED')
})

test('旧建议过期仍须显示已触及的持仓止损风险', () => {
  const commands = buildTodayCommandList({
    book: { holding: [{ code: '600006', qty: 2, buyPrice: 11, sl: 10,
      buyAt: now - 86400000 }], closed: [], plan: [] },
    adviceFor: () => entry({ action: '持有', expireAt: now - 1 }),
    quoteMap: { '600006': { price: 9.9, isLivePrice: true } }, now,
  })
  assert.equal(commands[0].state, 'RISK_EXIT')
  assert.match(commands[0].instruction, /今日可卖2手/)
})

test('最新风险阻断旧买入授权，但不阻断退出与真实成交补录', () => {
  const book = {
    plan: [{ code: '600007' }, { code: '600008' }, { code: '600009' }],
    executionPlans: [
      { code: '600007', side: 'BUY', status: 'ALERTED' },
      { code: '600008', side: 'SELL', status: 'ALERTED' },
      { code: '600009', side: 'BUY', status: 'USER_CONFIRMED' },
    ],
  }
  const currentRisk = { complete: true, breaker: {
    allowRiskIncrease: false,
    blockers: [{ message: '账户回撤达到熔断线', value: 4, limit: 3 }],
  } }
  const commands = buildTodayCommandList({ book, now, currentRisk })
  const buy = commands.find((item) => item.code === '600007')
  assert.equal(buy.state, 'RISK_BLOCKED')
  assert.equal(buy.quantity, '')
  assert.match(buy.instruction, /当前4，上限3/)
  assert.equal(commands.find((item) => item.code === '600008').state, 'READY_EXIT')
  assert.equal(commands.find((item) => item.code === '600009').state, 'RECORD')
  const marketOnly = buildTodayCommandList({
    book, now, marketRegime: { allowRiskIncrease: false, label: '数据不足' },
  })
  assert.equal(marketOnly.find((item) => item.code === '600007').state, 'RISK_BLOCKED')
  const probe = entry({ action: '买入', decisionPlan: {
    schemaVersion: 'decision-plan.v2', action: 'BUY', actionability: 'READY',
    quantity: { lots: 1 }, prices: { reference: 10 },
    actionPolicy: { riskTier: 'PROBE' }, marketRegime: { regime: 'RISK_OFF' },
    validUntil: new Date(now + 60000).toISOString(),
  } })
  const marketRegime = {
    regime: 'RISK_OFF', dataQuality: 'COMPLETE', allowRiskIncrease: false, hardRiskOff: false,
  }
  const weak = buildTodayCommandList({
    book, now, marketRegime, adviceFor: (code) => code === '600007' ? probe : null,
  })
  assert.equal(weak.find((item) => item.code === '600007').state, 'READY')
  const redLine = buildTodayCommandList({
    book, now, marketRegime: { ...marketRegime, hardRiskOff: true },
    adviceFor: (code) => code === '600007' ? probe : null,
  })
  assert.equal(redLine.find((item) => item.code === '600007').state, 'RISK_BLOCKED')
})
