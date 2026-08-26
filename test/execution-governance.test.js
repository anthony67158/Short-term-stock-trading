import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createExecutionEvent,
  processExecutionEvent,
  summarizeExecutionEventState,
  summarizeExecutionEvents,
} from '../shared/executionEvents.js'
import {
  aggregateExecutionAttribution,
  attributeExecution,
} from '../shared/executionAttribution.js'
import {
  evaluateAccountCircuitBreaker,
} from '../shared/accountCircuitBreaker.js'
import {
  buildTGridExperiment,
  evaluateTGridEligibility,
} from '../shared/tGridPolicy.js'

const now = Date.parse('2026-08-21T02:30:00.000Z')

test('行情事件只运行确定性逻辑且相同幂等键只处理一次', () => {
  const state = { processed: {}, history: [] }
  const quote = createExecutionEvent({
    type: 'QUOTE_UPDATE',
    code: '600000',
    sourceAsOf: '2026-08-21T10:30:00+08:00',
    payload: { price: 10 },
  }, now)
  const first = processExecutionEvent(state, quote, now)
  const replay = processExecutionEvent(first.state, quote, now + 1)

  assert.equal(first.duplicate, false)
  assert.equal(first.decision.runDeterministic, true)
  assert.equal(first.decision.runLlm, false)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.state.history.length, 1)
  assert.deepEqual(summarizeExecutionEventState(replay.state), {
    schemaVersion: 'execution-event-metrics.v1',
    total: 2,
    unique: 1,
    duplicates: 1,
    llmRuns: 0,
    deterministicOnly: 1,
    llmSaved: 1,
    llmSavedPct: 100,
  })
})

test('只有实质新闻、冲突或用户主动请求才调用LLM', () => {
  const inputs = [
    ['BAR_5M_CLOSED', {}, false],
    ['PRICE_TRIGGERED', { hardRisk: true }, false],
    ['PRICE_TRIGGERED', { planConflict: true }, true],
    ['ACCOUNT_CHANGED', {}, false],
    ['NEWS_MATERIAL', { material: true }, true],
    ['SCHEDULED_REVIEW', { evidenceChanged: false }, false],
    ['SCHEDULED_REVIEW', { evidenceChanged: true }, true],
    ['USER_REQUEST', {}, true],
  ]

  for (const [type, payload, expected] of inputs) {
    const event = createExecutionEvent({
      type,
      code: '600000',
      sourceAsOf: `${type}:${now}`,
      payload,
    }, now)
    const result = processExecutionEvent(
      { processed: {}, history: [] },
      event,
      now,
    )
    assert.equal(result.decision.runLlm, expected, type)
  }
})

test('事件指标记录LLM节省比例', () => {
  const summary = summarizeExecutionEvents([
    { duplicate: false, runLlm: false },
    { duplicate: false, runLlm: false },
    { duplicate: false, runLlm: true },
    { duplicate: true, runLlm: false },
  ])

  assert.deepEqual(summary, {
    total: 4,
    unique: 3,
    duplicates: 1,
    llmRuns: 1,
    deterministicOnly: 2,
    llmSaved: 2,
    llmSavedPct: 66.7,
  })
})

test('真实成交归因区分决策滑点、执行滑点、VWAP偏差和费用', () => {
  const result = attributeExecution({
    schemaVersion: 'execution-plan.v1',
    planId: 'exec-plan-1',
    side: 'BUY',
    targetLots: 2,
    referencePrice: 10,
    triggerPrice: 10.05,
    createdAt: now,
  }, {
    fills: [
      {
        fillId: 'f1',
        lots: 1,
        price: 10.08,
        fee: 5,
        at: now + 60_000,
        manuallyRecorded: true,
      },
      {
        fillId: 'f2',
        lots: 1,
        price: 10.12,
        fee: 5,
        at: now + 120_000,
        manuallyRecorded: true,
      },
    ],
    vwap: 10.06,
  })

  assert.equal(result.schemaVersion, 'execution-attribution.v1')
  assert.equal(result.status, 'COMPLETED')
  assert.equal(result.averageFillPrice, 10.1)
  assert.equal(result.decisionSlippageBps, 100)
  assert.equal(result.executionSlippageBps, 49.75)
  assert.equal(result.vwapDeviationBps, 39.76)
  assert.equal(result.totalFees, 10)
  assert.equal(result.recordDelayMs, 120000)
})

test('真实价格路径计算持有时长MFE、MAE与盈利捕获率', () => {
  const result = attributeExecution({
    schemaVersion: 'execution-plan.v1',
    planId: 'exec-plan-metrics',
    side: 'SELL',
    targetLots: 1,
    referencePrice: 11.2,
    triggerPrice: 11.1,
    createdAt: now,
  }, {
    fills: [{
      fillId: 'f-metrics',
      transactionId: 'tx-metrics',
      lots: 1,
      price: 11.2,
      fee: 6,
      at: now + 2 * 86400000,
      manuallyRecorded: true,
    }],
    entryPrice: 10,
    entryAt: now,
    exitAt: now + 2 * 86400000,
    pricePath: [
      { high: 10.8, low: 9.6 },
      { high: 12, low: 10.5 },
    ],
    netPnl: 114,
    validationComplete: true,
  })

  assert.deepEqual(result.transactionIds, ['tx-metrics'])
  assert.equal(result.holdingDurationMinutes, 2880)
  assert.equal(result.mfePct, 20)
  assert.equal(result.maePct, -4)
  assert.equal(result.profitCapturePct, 60)
  assert.equal(result.learningEligible, true)
})

test('账户熔断预留未完成买入现金且不提前释放卖出资金', () => {
  const result = evaluateAccountCircuitBreaker({
    account: {
      totalAssets: 100000,
      cash: 20000,
      dayStartAssets: 105000,
    },
    portfolio: {
      position: 82,
      industryWeights: [{ industry: '电子', weight: 32 }],
    },
    closed: [
      {
        type: 'SELL',
        realizedPnl: -2200,
        at: now - 1000,
      },
    ],
    executionPlans: [
      {
        status: 'ARMED',
        side: 'BUY',
        reservedCash: 8000,
      },
      {
        status: 'USER_CONFIRMED',
        side: 'SELL',
        expectedNetProceeds: 5000,
      },
    ],
    now,
  })

  assert.equal(result.allowRiskIncrease, false)
  assert.equal(result.reservedBuyCash, 8000)
  assert.equal(result.availableCashAfterReservations, 12000)
  assert.equal(result.pendingSellProceedsRecognized, 0)
  assert.ok(result.blockerCodes.includes('DAILY_REALIZED_LOSS'))
  assert.ok(result.blockerCodes.includes('DAILY_DRAWDOWN'))
  assert.deepEqual(result.allowedActions, ['REDUCE', 'EXIT', 'WATCH'])
})

test('做T网格仅在有底仓的震荡市且流动性波动合格时开放', () => {
  const eligible = evaluateTGridEligibility({
    marketRegime: 'RANGE',
    hasBasePosition: true,
    sellableLots: 4,
    adv20: 150_000_000,
    atrPct: 2.4,
    amplitudePct: 4.2,
    completedToday: 0,
    netBuyLots: 0,
    now,
  })
  const experiment = buildTGridExperiment({
    eligibility: eligible,
    referencePrice: 10,
    baseLots: 4,
    maxNetBuyLots: 1,
  })
  const blocked = evaluateTGridEligibility({
    marketRegime: 'TREND_STRONG',
    hasBasePosition: true,
    sellableLots: 4,
    adv20: 150_000_000,
    atrPct: 2.4,
    amplitudePct: 4.2,
    now,
  })

  assert.equal(eligible.eligible, true)
  assert.equal(experiment.schemaVersion, 't-grid-experiment.v1')
  assert.equal(experiment.automaticExecution, false)
  assert.ok(experiment.levels.length >= 2)
  assert.ok(experiment.levels.every((item) => item.lots <= 1))
  assert.equal(blocked.eligible, false)
  assert.ok(blocked.reasons.includes('MARKET_NOT_RANGE'))
})

test('归因聚合只让真实费后已完成结果进入效果学习', () => {
  const summary = aggregateExecutionAttribution([
    {
      status: 'COMPLETED',
      marketRegime: 'TREND_STRONG',
      totalFees: 10,
      netPnl: 120,
      holdingDurationMinutes: 180,
      mfePct: 8,
      maePct: -2,
      profitCapturePct: 62.5,
      validationComplete: true,
    },
    {
      status: 'PARTIAL',
      totalFees: 5,
      netPnl: 40,
      validationComplete: false,
    },
  ])

  assert.equal(summary.total, 2)
  assert.equal(summary.learningEligible, 1)
  assert.equal(summary.groups[0].netPnl, 120)
  assert.equal(summary.groups[0].averageHoldingMinutes, 180)
  assert.equal(summary.groups[0].averageMfePct, 8)
  assert.equal(summary.groups[0].averageMaePct, -2)
  assert.equal(summary.groups[0].averageProfitCapturePct, 62.5)
})
