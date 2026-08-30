import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTriggeredReviewFallback,
  enforceTriggeredReviewDecisionPlan,
  normalizeTriggeredReviewDecision,
  shouldCollectTriggeredReviewSource,
  TRIGGERED_REVIEW_MODEL_BUDGET_MS,
  TRIGGERED_REVIEW_TIME_LIMIT_MINUTES,
  triggeredReviewRuntime,
} from '../shared/triggeredReviewDecision.js'

const NOW = Date.parse('2026-08-28T02:00:00.000Z')

function payload(overrides = {}) {
  return {
    todayQuote: {
      price: 12.43,
      pct: 2.1,
      volRatio: 1.8,
    },
    stockFund: {
      mainNetYi: 0.82,
      retailNetYi: -0.31,
    },
    reviewEvent: {
      kind: 'price-review',
      direction: 'gte',
      threshold: 12.42,
      price: 12.43,
      at: NOW,
      timeLimitMinutes: TRIGGERED_REVIEW_TIME_LIMIT_MINUTES,
      decisionDeadlineAt:
        NOW + TRIGGERED_REVIEW_TIME_LIMIT_MINUTES * 60 * 1000,
    },
    ...overrides,
  }
}

test('价格触发复核保留两分钟硬截止并将模型预算收紧到45秒', () => {
  const runtime = triggeredReviewRuntime(payload().reviewEvent, NOW)
  assert.equal(runtime.remainingMs, 120000)
  assert.equal(TRIGGERED_REVIEW_MODEL_BUDGET_MS, 45000)
  assert.equal(runtime.runtimeBudgetMs, TRIGGERED_REVIEW_MODEL_BUDGET_MS)
  assert.equal(runtime.maxAttempts, 1)
  assert.equal(runtime.expired, false)

  const expired = triggeredReviewRuntime(
    payload().reviewEvent,
    NOW + 115000,
  )
  assert.equal(expired.expired, true)
})

test('到价复核只重新采集价格决策所需的快速证据', () => {
  const event = payload().reviewEvent
  for (const key of [
    'market',
    'sectorFlow',
    'dailyCandles',
    'intraday',
    'stockFunds',
    'quote',
  ]) {
    assert.equal(shouldCollectTriggeredReviewSource(event, key), true)
  }
  for (const key of [
    'dragonTiger',
    'stockNews',
    'macroNews',
    'dailyReport',
    'macroFlashes',
    'quant',
    'stockSearch',
    'industrySearch',
  ]) {
    assert.equal(shouldCollectTriggeredReviewSource(event, key), false)
  }
  assert.equal(
    shouldCollectTriggeredReviewSource({}, 'stockNews'),
    true,
  )
})

test('买入复核成功只输出立即买入并带区间手数与依据', () => {
  const result = normalizeTriggeredReviewDecision({
    mode: 'buy_advice',
    payload: payload(),
    now: NOW + 45000,
    result: {
      action: '小仓试错',
      title: '突破成立',
      actionPlan: '突破后买入',
      buyPrice: 12.43,
      stopPrice: 12.1,
      targetPrice: 13.2,
      planQty: 3,
      fundNote: '主力净流入0.82亿元，小单净流出0.31亿元',
      techNote: '放量站稳触发价与分时均价',
      invalidation: '跌破12.1元',
      nextOpenPlan: '次日跌破止损即退出',
      futurePlan: '五日内未达目标则退出',
      pullbackWatchPrice: 12.2,
      breakoutWatchPrice: 12.42,
    },
  })

  assert.equal(result.action, '立即买入')
  assert.equal(result.reviewDecision.outcome, '立即买入')
  assert.equal(result.reviewDecision.operation, '买入')
  assert.equal(result.reviewDecision.quantity, 3)
  assert.equal(result.reviewDecision.priceLow, 12.43)
  assert.equal(result.reviewDecision.terminal, true)
  assert.equal(
    result.reviewDecision.followUpPlan.source,
    'CURRENT_REVIEW',
  )
  assert.equal(
    result.reviewDecision.followUpPlan.manualConfirmationRequired,
    true,
  )
  assert.match(
    result.reviewDecision.followUpPlan.nextSessionPlan,
    /次日跌破止损/,
  )
  assert.match(
    result.reviewDecision.followUpPlan.futurePlan,
    /五日内未达目标/,
  )
  assert.match(result.actionPlan, /立即买入3手/)
  assert.match(result.actionPlan, /执行区间12\.43元/)
  assert.ok(result.reviewDecision.basis.length >= 1)
  assert.equal(result.pullbackWatchPrice, null)
  assert.equal(result.breakoutWatchPrice, null)
})

test('买入复核未确认时终态只能维持观望且不得生成新观察价', () => {
  const result = normalizeTriggeredReviewDecision({
    mode: 'buy_advice',
    payload: payload(),
    result: {
      action: '观望',
      title: '量能不足',
      actionPlan: '再看13元',
      pullbackWatchPrice: 12.2,
      breakoutWatchPrice: 13,
      fundNote: '主力净流入但价格未站稳',
      techNote: '触价后缩量回落',
      invalidation: '未确认',
    },
  })

  assert.equal(result.action, '观望')
  assert.equal(result.reviewDecision.outcome, '维持观望')
  assert.match(result.actionPlan, /原触发价已经消费/)
  assert.equal(result.pullbackWatchPrice, null)
  assert.equal(result.breakoutWatchPrice, null)
  assert.doesNotMatch(result.actionPlan, /13元/)
})

test('买入逻辑失效时终态为放弃买入', () => {
  const result = normalizeTriggeredReviewDecision({
    mode: 'buy_advice',
    payload: payload(),
    result: {
      action: '放弃买入',
      title: '突破失败',
      actionPlan: '取消计划',
      newsNote: '重大利空已由交易所公告确认',
      invalidation: '原买入逻辑失效',
    },
  })

  assert.equal(result.action, '观望')
  assert.equal(result.reviewDecision.outcome, '放弃买入')
  assert.equal(result.reviewDecision.operation, '不操作')
  assert.match(result.actionPlan, /本轮结束/)
})

test('持仓复核锁定利润时给出执行区间和可卖手数', () => {
  const result = normalizeTriggeredReviewDecision({
    mode: 'hold_advice',
    payload: payload({ sellableTodayQty: 2 }),
    result: {
      action: '锁定利润',
      title: '冲高回落',
      actionPlan: '锁定利润',
      reducePrice: 13.1,
      opQty: '锁定利润3手',
      fundNote: '主力流出0.5亿元',
      techNote: '冲高后跌破分时均价',
      invalidation: '重新站回13.2元',
      nextOpenPlan: '次日按剩余仓位处理',
      futurePlan: '五日内退出',
    },
  })

  assert.equal(result.action, '减仓')
  assert.equal(result.reviewDecision.outcome, '锁定利润')
  assert.equal(result.reviewDecision.operation, '锁利润')
  assert.equal(result.reviewDecision.quantity, 2)
  assert.match(result.actionPlan, /锁定利润2手/)
  assert.match(result.actionPlan, /13\.1元/)
})

test('限时复核失败直接形成维持观望终态而不是重排新价格', () => {
  const result = buildTriggeredReviewFallback({
    mode: 'buy_advice',
    payload: payload(),
    previousAdvice: {
      action: '观望',
      title: '等待突破',
      actionPlan: '等待12.42元',
      breakoutWatchPrice: 12.42,
      techNote: '原计划等待放量',
    },
    reason: '模型在限时内未返回完整结论',
    now: NOW + 120000,
  })

  assert.equal(result.action, '观望')
  assert.equal(result.reviewDecision.terminal, true)
  assert.equal(result.breakoutWatchPrice, null)
  assert.match(result.actionPlan, /不再设置新的复核价格/)
  assert.match(result.reason, /限时内未返回/)
})

test('LLM给出买入但服务端计划不可执行时收敛为维持观望', () => {
  const aligned = enforceTriggeredReviewDecisionPlan({
    mode: 'buy_advice',
    result: {
      action: '立即买入',
      title: '立即买入',
      buyPrice: 12.43,
      planQty: 3,
      actionPlan: '立即买入3手',
      reviewDecision: {
        schemaVersion: 'triggered-review-decision.v1',
        terminal: true,
        outcome: '立即买入',
        operation: '买入',
        priceLow: 12.4,
        priceHigh: 12.45,
        quantity: 3,
      },
      decisionPlan: {
        schemaVersion: 'decision-plan.v2',
        action: 'WATCH',
        actionability: 'BLOCKED',
        blockedReasons: ['可用资金不足'],
      },
    },
  })

  assert.equal(aligned.changed, true)
  assert.equal(aligned.result.action, '观望')
  assert.equal(aligned.result.reviewDecision.outcome, '维持观望')
  assert.equal(aligned.result.reviewDecision.operation, '不操作')
  assert.match(aligned.result.actionPlan, /可用资金不足/)
  assert.equal(aligned.result.buyPrice, null)
})
