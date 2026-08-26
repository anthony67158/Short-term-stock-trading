import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveOpportunityLifecycle,
  mergeOpportunityLifecycle,
} from '../shared/opportunityLifecycle.js'

test('未持仓观望进入观察确认而不是执行状态', () => {
  const lifecycle = deriveOpportunityLifecycle({
    code: '600001',
    mode: 'buy_advice',
    advice: {
      action: '观望',
      pullbackWatchPrice: 9.8,
      breakoutWatchPrice: 10.5,
    },
    tactical: { timing: { state: 'WAIT_PULLBACK' } },
    decisionPlan: {
      decisionId: 'd1',
      action: 'WATCH',
      actionability: 'WATCH',
    },
  })

  assert.equal(lifecycle.stage, 'WATCHING')
  assert.equal(lifecycle.stageLabel, '观察确认')
})

test('可执行建仓进入等待触发并由真实执行状态继续推进', () => {
  const armed = deriveOpportunityLifecycle({
    code: '600001',
    mode: 'buy_advice',
    advice: { action: '立即买入' },
    decisionPlan: {
      decisionId: 'd1',
      action: 'BUY',
      actionability: 'READY',
    },
  })
  const confirmed = deriveOpportunityLifecycle({
    code: '600001',
    mode: 'buy_advice',
    decisionPlan: { decisionId: 'd1', action: 'BUY' },
    executionPlan: {
      planId: 'p1',
      status: 'USER_CONFIRMED',
      side: 'BUY',
    },
  })
  const managed = deriveOpportunityLifecycle({
    code: '600001',
    mode: 'hold_advice',
    decisionPlan: { decisionId: 'd1', action: 'HOLD' },
    executionPlan: {
      planId: 'p1',
      status: 'COMPLETED',
      side: 'BUY',
    },
    holdQty: 2,
  })

  assert.equal(armed.stage, 'ARMED')
  assert.equal(confirmed.stage, 'CONFIRMED')
  assert.equal(managed.stage, 'MANAGED')
})

test('持仓退出受T+1限制时明确下一交易日优先退出', () => {
  const lifecycle = deriveOpportunityLifecycle({
    code: '600001',
    mode: 'hold_advice',
    advice: { action: '清仓' },
    decisionPlan: {
      decisionId: 'd2',
      action: 'EXIT',
      actionability: 'READY',
    },
    holdQty: 2,
    sellableTodayQty: 0,
  })

  assert.equal(lifecycle.stage, 'EXIT_PENDING')
  assert.match(lifecycle.nextEvent, /T\+1/)
})

test('确定性止损被T+1锁定时仍保持等待退出阶段', () => {
  const lifecycle = deriveOpportunityLifecycle({
    code: '600000',
    mode: 'hold_advice',
    advice: {
      action: '持有',
      exitManagement: {
        kind: 'HARD_STOP',
        blockedByT1: true,
      },
    },
    decisionPlan: {
      decisionId: 'decision.stop-locked',
      action: 'HOLD',
      actionability: 'WATCH',
    },
    holdQty: 2,
    sellableTodayQty: 0,
  })

  assert.equal(lifecycle.stage, 'EXIT_PENDING')
  assert.match(lifecycle.nextEvent, /T\+1/)
})

test('同一决策终态不会被旧设备运行态回滚', () => {
  const current = {
    decisionId: 'd1',
    stage: 'CLOSED',
    terminal: true,
    updatedAt: 200,
  }
  const incoming = {
    decisionId: 'd1',
    stage: 'ARMED',
    terminal: false,
    updatedAt: 100,
  }

  assert.equal(
    mergeOpportunityLifecycle(current, incoming),
    current,
  )
})
