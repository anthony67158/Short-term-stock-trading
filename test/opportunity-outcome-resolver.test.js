import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPPORTUNITY_OUTCOME_SCHEMA_VERSION,
  resolveOpportunityOutcome,
} from '../shared/opportunityOutcomeResolver.js'

const SIGNAL_AT = Date.parse('2026-09-01T07:05:00.000Z')

function event(overrides = {}) {
  return {
    decisionId: 'formula:2026-09-01:close:1505:600001',
    asOf: SIGNAL_AT,
    code: '600001',
    name: '测试股份',
    mode: 'CLOSE',
    tradeDate: '2026-09-01',
    ruleVersion: 'CN_A_SHARE_2026_07_06',
    quote: {
      price: 10,
      preClose: 9.8,
    },
    decision: {
      formulaId: 'CLOSE_TREND_PULLBACK',
      action: 'WATCH_BUY',
      primaryPrice: 10,
      priceType: 'PULLBACK_WATCH',
      stopPrice: 9.5,
      targetPrice: 10.8,
      priceContractValid: true,
      timeStopTradingDays: 3,
    },
    ...overrides,
  }
}

function bar(date, {
  open = 10,
  high = 10.4,
  low = 9.8,
  close = 10.1,
  volume = 100_000,
  preClose,
} = {}) {
  return {
    date,
    open,
    high,
    low,
    close,
    volume,
    ...(preClose == null ? {} : { preClose }),
  }
}

test('未形成合法价格合同的候选不进入可执行结果样本', () => {
  const result = resolveOpportunityOutcome({
    event: event({
      decision: {
        priceContractValid: false,
      },
    }),
    bars: [],
    evaluatedAt: Date.parse('2026-09-10T08:00:00.000Z'),
  })

  assert.equal(result.schemaVersion, OPPORTUNITY_OUTCOME_SCHEMA_VERSION)
  assert.equal(result.maturity, 'MATURED')
  assert.equal(result.outcome, 'NOT_ELIGIBLE')
  assert.equal(result.fillStatus, 'NOT_APPLICABLE')
})

test('收盘候选只在下一交易日观察触发，未触发形成负成交样本', () => {
  const result = resolveOpportunityOutcome({
    event: event({
      decision: {
        ...event().decision,
        priceType: 'BREAKOUT_WATCH',
        primaryPrice: 10.8,
        targetPrice: 11.8,
      },
    }),
    bars: [
      bar('2026-09-01'),
      bar('2026-09-02', { high: 10.7, low: 9.9 }),
      bar('2026-09-03', { high: 11.2 }),
    ],
    evaluatedAt: Date.parse('2026-09-03T08:00:00.000Z'),
  })

  assert.equal(result.maturity, 'MATURED')
  assert.equal(result.outcome, 'NOT_TRIGGERED')
  assert.equal(result.fillStatus, 'NOT_TRIGGERED')
  assert.equal(result.observations.entryWindowBars, 1)
})

test('触发后下一根K线一字涨停时记录为触发但未成交', () => {
  const result = resolveOpportunityOutcome({
    event: event(),
    bars: [
      bar('2026-09-01', { close: 10 }),
      bar('2026-09-02', { low: 9.95, close: 10 }),
      bar('2026-09-03', {
        open: 11,
        high: 11,
        low: 11,
        close: 11,
        preClose: 10,
      }),
    ],
    evaluatedAt: Date.parse('2026-09-03T08:00:00.000Z'),
  })

  assert.equal(result.maturity, 'MATURED')
  assert.equal(result.outcome, 'LIMIT_UP_UNFILLED')
  assert.equal(result.fillStatus, 'TRIGGERED_UNFILLED')
  assert.equal(result.entry.rejectionReason, 'LIMIT_UP_UNFILLED')
})

test('买入当日触发止损只能记录T+1锁定，不能伪造成可卖出', () => {
  const result = resolveOpportunityOutcome({
    event: event(),
    bars: [
      bar('2026-09-01', { close: 10 }),
      bar('2026-09-02', { low: 9.9, close: 10 }),
      bar('2026-09-03', {
        open: 10,
        high: 10.3,
        low: 9.3,
        close: 9.6,
        preClose: 10,
      }),
    ],
    evaluatedAt: Date.parse('2026-09-03T08:00:00.000Z'),
  })

  assert.equal(result.maturity, 'PENDING')
  assert.equal(result.outcome, 'OPEN_T1_LOCKED')
  assert.equal(result.fillStatus, 'FILLED')
  assert.equal(result.exitStatus, 'T1_LOCKED')
  assert.equal(result.observations.t1LockedStopHit, true)
})

test('T+1后目标先到时按统一费用与滑点口径结算净结果', () => {
  const result = resolveOpportunityOutcome({
    event: event(),
    bars: [
      bar('2026-09-01', { close: 10 }),
      bar('2026-09-02', { low: 9.9, close: 10 }),
      bar('2026-09-03', { open: 10, low: 9.8, close: 10.2 }),
      bar('2026-09-04', {
        open: 10.2,
        high: 10.9,
        low: 10.1,
        close: 10.8,
        preClose: 10.2,
      }),
    ],
    evaluatedAt: Date.parse('2026-09-04T08:00:00.000Z'),
  })

  assert.equal(result.maturity, 'MATURED')
  assert.equal(result.outcome, 'TAKE_PROFIT')
  assert.equal(result.exitStatus, 'TARGET_FILLED')
  assert.equal(result.entry.tradeDate, '20260903')
  assert.equal(result.exit.tradeDate, '20260904')
  assert.ok(result.metrics.netPnl > 0)
  assert.ok(result.metrics.netR > 0)
  assert.equal(result.metrics.holdingTradingSessions, 2)
})

test('同一根K线止盈止损均触及时按止损优先并标记路径不明', () => {
  const result = resolveOpportunityOutcome({
    event: event(),
    bars: [
      bar('2026-09-01', { close: 10 }),
      bar('2026-09-02', { low: 9.9, close: 10 }),
      bar('2026-09-03', { open: 10, low: 9.8, close: 10.1 }),
      bar('2026-09-04', {
        open: 10.1,
        high: 10.9,
        low: 9.4,
        close: 10.3,
        preClose: 10.1,
      }),
    ],
    evaluatedAt: Date.parse('2026-09-04T08:00:00.000Z'),
  })

  assert.equal(result.maturity, 'MATURED')
  assert.equal(result.outcome, 'AMBIGUOUS_STOP_LOSS')
  assert.equal(result.exitStatus, 'AMBIGUOUS_STOP_FILLED')
  assert.equal(result.observations.pathAmbiguous, true)
  assert.ok(result.metrics.netPnl < 0)
})

test('止损遇连续跌停不能卖出，打开后按首个可成交开盘价退出', () => {
  const result = resolveOpportunityOutcome({
    event: event({
      decision: {
        ...event().decision,
        stopPrice: 9,
        targetPrice: 12,
        timeStopTradingDays: 5,
      },
    }),
    bars: [
      bar('2026-09-01', { close: 10 }),
      bar('2026-09-02', { low: 9.9, close: 10 }),
      bar('2026-09-03', { open: 10, low: 9.8, close: 10 }),
      bar('2026-09-04', {
        open: 9,
        high: 9,
        low: 9,
        close: 9,
        preClose: 10,
      }),
      bar('2026-09-05', {
        open: 8.1,
        high: 8.1,
        low: 8.1,
        close: 8.1,
        preClose: 9,
      }),
      bar('2026-09-08', {
        open: 8.3,
        high: 8.5,
        low: 8.2,
        close: 8.4,
        preClose: 8.1,
      }),
    ],
    evaluatedAt: Date.parse('2026-09-08T08:00:00.000Z'),
  })

  assert.equal(result.maturity, 'MATURED')
  assert.equal(result.outcome, 'STOP_LOSS')
  assert.equal(result.exitStatus, 'STOP_FILLED')
  assert.equal(result.exit.tradeDate, '20260908')
  assert.equal(result.observations.blockedExitAttempts, 2)
  assert.ok(result.metrics.netPnl < -150)
})

test('到期未触发边界时在冻结的第N个交易日按收盘价退出', () => {
  const result = resolveOpportunityOutcome({
    event: event({
      decision: {
        ...event().decision,
        timeStopTradingDays: 2,
      },
    }),
    bars: [
      bar('2026-09-01', { close: 10 }),
      bar('2026-09-02', { low: 9.9, close: 10 }),
      bar('2026-09-03', { open: 10, low: 9.8, close: 10.1 }),
      bar('2026-09-04', {
        open: 10.1,
        high: 10.4,
        low: 9.9,
        close: 10.2,
        preClose: 10.1,
      }),
    ],
    evaluatedAt: Date.parse('2026-09-04T08:00:00.000Z'),
  })

  assert.equal(result.maturity, 'MATURED')
  assert.equal(result.outcome, 'TIME_EXIT')
  assert.equal(result.exitStatus, 'TIME_FILLED')
  assert.equal(result.exit.referencePrice, 10.2)
})

test('盘中候选没有带时点的分钟线时保持数据待补而不误判未触发', () => {
  const intraday = event({
    asOf: Date.parse('2026-09-01T02:00:00.000Z'),
    mode: 'INTRADAY',
    decision: {
      ...event().decision,
      validUntil: Date.parse('2026-09-01T03:00:00.000Z'),
    },
  })
  const result = resolveOpportunityOutcome({
    event: intraday,
    bars: [bar('2026-09-01')],
    evaluatedAt: Date.parse('2026-09-01T04:00:00.000Z'),
  })

  assert.equal(result.maturity, 'PENDING')
  assert.equal(result.outcome, 'DATA_INCOMPLETE')
  assert.equal(result.fillStatus, 'UNKNOWN')
})
