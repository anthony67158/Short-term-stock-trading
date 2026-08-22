import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFallbackDecisionAdvice,
  compileDecisionPlan,
  decisionPlanConfirmationGate,
} from '../shared/decisionPlan.js'
import { adviceCompleteness } from '../shared/adviceBatchPolicy.js'
import { getActiveStrategySpec } from '../shared/strategySpec.js'
import { getStrategySpecV2 } from '../shared/strategyCatalogV2.js'
import { routeStrategyPortfolio } from '../shared/strategyRouter.js'

const now = Date.parse('2026-08-21T02:30:00.000Z')
const snapshot = {
  snapshotId: 'evidence.test',
  asOf: '2026-08-21T02:30:00.000Z',
  freshness: { status: 'LIVE', missingSources: [] },
}
const strongMarket = {
  schemaVersion: 'market-regime.v1',
  regime: 'TREND_STRONG',
  score: 76,
  dataQuality: 'COMPLETE',
  weak: false,
  riskMultiplier: 1,
  allowRiskIncrease: true,
  targetPositionPct: { min: 50, max: 70 },
}
const account = {
  totalAssets: 100000,
  cash: 50000,
  position: 40,
  stockWeight: 0,
  maxStockWeight: 25,
}
const payload = {
  code: '600519',
  name: '贵州茅台',
  todayQuote: {
    price: 10,
    pct: 2,
    volRatio: 2,
    limitDownPrice: 9,
    limitUpPrice: 11,
    live: true,
  },
  marketEnv: strongMarket,
  market: { score: 76 },
  quant: {
    score: 72,
    forecast: { upProb: 62, expRet: 2.4 },
    highConfSignal: { fired: true },
    modelVersion: 'default',
  },
  account,
}

test('未晋级策略的买入建议被编译为研究级计划且手数受风险预算约束', () => {
  const first = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 10,
      actionPlan: '立即买入10手',
      invalidation: '跌破9元',
    },
    payload,
    evidenceSnapshot: snapshot,
    strategySpec: getActiveStrategySpec(),
    strategyGate: {
      productionEligible: false,
      blockers: [{ code: 'OFFLINE_REJECTED' }],
    },
    now,
  })
  const second = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 10,
      actionPlan: '立即买入10手',
      invalidation: '跌破9元',
    },
    payload,
    evidenceSnapshot: snapshot,
    strategySpec: getActiveStrategySpec(),
    strategyGate: {
      productionEligible: false,
      blockers: [{ code: 'OFFLINE_REJECTED' }],
    },
    now,
  })

  assert.equal(first.schemaVersion, 'decision-plan.v2')
  assert.equal(first.action, 'BUY')
  assert.equal(first.actionability, 'RESEARCH_ONLY')
  assert.equal(first.strategy.signalPassed, true)
  assert.equal(first.risk.maxLossAmount, 600)
  assert.ok(first.quantity.lots > 0)
  assert.ok(first.quantity.lots < 10)
  assert.ok(first.costs.estimatedFees > 0)
  assert.ok(first.targetWeightPct <= 20)
  assert.match(first.blockedReasons.join(' '), /策略尚未通过生产晋级/)
  assert.equal(first.decisionId, second.decisionId)
})

test('v2影子路由写入策略族、适用状态、样本外成绩和治理级别', () => {
  const strategySpec = getStrategySpecV2('trend-breakout')
  const strategyRoute = routeStrategyPortfolio({
    marketRegime: 'TREND_STRONG',
    requestedAction: 'BUY',
    context: {
      marketRegime: 'TREND_STRONG',
      marketScore: 76,
      pct: 2,
      volRatio: 1.8,
      quant: { score: 72 },
      technical: {
        donchianBreakout: true,
        maSlope20: 0.8,
      },
    },
  })
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 2,
    },
    evidenceSnapshot: snapshot,
    strategySpec,
    strategyRoute,
    payload: {
      ...payload,
      tech: {
        donchianBreakout: true,
        maSlope20: 0.8,
      },
    },
    strategyGate: {
      productionEligible: false,
      blockers: [{ code: 'BACKTEST_REQUIRED' }],
    },
    now,
  })

  assert.equal(plan.actionability, 'RESEARCH_ONLY')
  assert.equal(plan.strategy.schemaVersion, 'strategy-spec.v2')
  assert.equal(plan.strategy.strategyId, 'trend-breakout')
  assert.equal(plan.strategy.family, 'TREND_BREAKOUT')
  assert.equal(plan.strategy.governanceState, 'draft')
  assert.deepEqual(plan.strategy.eligibleRegimes, ['TREND_STRONG'])
  assert.equal(plan.strategy.outOfSample, null)
  assert.equal(plan.strategy.routeMode, 'SHADOW_ONLY')
  assert.equal(plan.strategyRoute.schemaVersion, 'strategy-route.v1')
})

test('没有通过策略信号的风险增加动作被阻断', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQty: 2,
      invalidation: '跌破9元',
    },
    payload: {
      ...payload,
      todayQuote: { ...payload.todayQuote, pct: 9.5, volRatio: 12 },
      quant: {
        ...payload.quant,
        score: 40,
        forecast: { upProb: 40, expRet: -1 },
      },
    },
    evidenceSnapshot: snapshot,
    strategySpec: getActiveStrategySpec(),
    strategyGate: { productionEligible: true, blockers: [] },
    now,
  })

  assert.equal(plan.action, 'WATCH')
  assert.equal(plan.requestedAction, 'BUY')
  assert.equal(plan.actionability, 'BLOCKED')
  assert.equal(plan.quantity.lots, 0)
  assert.match(plan.blockedReasons.join(' '), /策略入场条件未通过/)
})

test('降低风险动作不受策略REJECT阻断但不得超过今日可卖数量', () => {
  const plan = compileDecisionPlan({
    mode: 'hold_advice',
    advice: {
      action: '减仓',
      reducePrice: 12,
      stopPrice: 9,
      targetPrice: 13,
      opQty: '减仓5手',
      actionPlan: '反弹减仓',
      invalidation: '重新站稳13元',
    },
    payload: {
      ...payload,
      holdQty: 5,
      sellableTodayQty: 2,
      account: { ...account, stockWeight: 12 },
    },
    evidenceSnapshot: snapshot,
    strategySpec: getActiveStrategySpec(),
    strategyGate: {
      productionEligible: false,
      blockers: [{ code: 'OFFLINE_REJECTED' }],
    },
    now,
  })

  assert.equal(plan.action, 'REDUCE')
  assert.equal(plan.actionability, 'READY')
  assert.equal(plan.quantity.lots, 2)
  assert.equal(plan.quantity.requestedLots, 5)
  assert.equal(plan.costs.side, 'SELL')
  assert.ok(plan.costs.estimatedNetAmount < 2400)
  assert.doesNotMatch(plan.blockedReasons.join(' '), /策略尚未通过/)
})

test('关键证据不完整时风险增加动作必须阻断', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '回调再买',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQty: 1,
      invalidation: '跌破9元',
    },
    payload,
    evidenceSnapshot: {
      ...snapshot,
      freshness: {
        status: 'PARTIAL',
        missingSources: ['account', 'quant'],
      },
    },
    strategySpec: getActiveStrategySpec(),
    strategyGate: { productionEligible: true, blockers: [] },
    now,
  })

  assert.equal(plan.actionability, 'BLOCKED')
  assert.equal(plan.action, 'WATCH')
  assert.equal(plan.quantity.lots, 0)
  assert.match(plan.blockedReasons.join(' '), /关键证据不完整/)
})

test('研究级或被阻断的新增风险计划不能被Judge升级为确认', () => {
  assert.deepEqual(
    decisionPlanConfirmationGate({
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      actionability: 'RESEARCH_ONLY',
    }, 'buy'),
    {
      allowed: false,
      policy: 'decision-plan-not-ready',
      reason: '当前仅为研究级条件建议，不能升级为执行确认',
    },
  )
  assert.equal(
    decisionPlanConfirmationGate({
      schemaVersion: 'decision-plan.v2',
      action: 'REDUCE',
      actionability: 'READY',
    }, 'sell').allowed,
    true,
  )
})

test('首次LLM失败时返回不含交易数字的确定性等待计划', () => {
  const fallback = buildFallbackDecisionAdvice({
    mode: 'buy_advice',
    payload: {
      ...payload,
      quant: null,
      tech: null,
    },
    evidenceSnapshot: snapshot,
    strategySpec: getActiveStrategySpec(),
    strategyGate: { productionEligible: false, blockers: [] },
    error: '模型超时',
    now,
  })

  assert.equal(fallback.action, '观望')
  assert.equal(fallback.decisionPlan.action, 'WATCH')
  assert.equal(fallback.decisionPlan.actionability, 'WATCH')
  assert.equal(fallback.planQty, 0)
  assert.equal(fallback.buyPrice, null)
  assert.equal(adviceCompleteness(fallback, 'buy_advice').complete, true)
})
