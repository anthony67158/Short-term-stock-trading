import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFallbackDecisionAdvice,
  compileDecisionPlan,
  decisionPlanConfirmationGate,
} from '../shared/decisionPlan.js'
import { adviceCompleteness } from '../shared/adviceBatchPolicy.js'
import { buildAdvicePriceContract } from '../shared/advicePriceContract.js'

const now = Date.parse('2026-08-21T02:30:00.000Z')
const snapshot = {
  snapshotId: 'evidence.test',
  asOf: '2026-08-21T02:30:00.000Z',
  freshness: { status: 'LIVE', missingSources: [] },
}
const payload = {
  code: '600519',
  name: '贵州茅台',
  todayQuote: {
    price: 10,
    pct: 2,
    volRatio: 2,
    limitDownPrice: 9,
    limitUpPrice: 13,
    live: true,
  },
  marketEnv: {
    schemaVersion: 'market-regime.v1',
    regime: 'TREND_STRONG',
    score: 76,
    dataQuality: 'COMPLETE',
    riskMultiplier: 1,
    allowRiskIncrease: true,
    targetPositionPct: { min: 50, max: 70 },
  },
  quant: {
    score: 72,
    forecast: { upProb: 62, expRet: 2.4 },
    highConfSignal: { fired: true },
  },
  account: {
    totalAssets: 100000,
    cash: 50000,
    position: 40,
    stockWeight: 0,
    maxStockWeight: 25,
  },
}

test('证据和风险条件满足时买入计划直接进入可执行状态', () => {
  const plan = compileDecisionPlan({
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
    now,
  })

  assert.equal(plan.action, 'BUY')
  assert.equal(plan.actionability, 'READY')
  assert.equal(plan.risk.maxLossAmount, 1000)
  assert.ok(plan.quantity.lots > 0)
  assert.ok(plan.quantity.lots < 10)
  assert.deepEqual(plan.blockedReasons, [])
  assert.equal(plan.strategy, undefined)
  assert.equal(plan.strategyRoute, undefined)
})

test('小仓试错保留5%仓位上限但不受策略晋级限制', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '小仓试错',
      tier: 'probe',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 10,
    },
    payload: {
      ...payload,
      sectorOpportunity: {
        schemaVersion: 'sector-opportunity.v1',
        matched: true,
        probeEligible: true,
        sector: { name: '新能源', actionability: 'BUY_READY' },
        stock: { roleLabel: '前排候选' },
      },
    },
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.actionability, 'READY')
  assert.equal(plan.manualConfirmationOnly, true)
  assert.equal(plan.risk.manualProbeLimitPct, 5)
  assert.ok(plan.quantity.lots <= 5)
})

test('新增风险必须满足至少1.8比1的盈亏比', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 11.5,
      planQtyNum: 2,
    },
    payload,
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.action, 'WATCH')
  assert.equal(plan.actionability, 'BLOCKED')
  assert.match(plan.blockedReasons.join('；'), /盈亏比/)
})

test('观望计划只保留可核验的价格复核条件', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '观望',
      actionPlan: '放量站上10.8元后重新判断',
      watchPrice: 10.8,
    },
    payload: {
      ...payload,
      tech: { atr: 0.4, resistance: 10.8 },
    },
    evidenceSnapshot: snapshot,
    now,
  })

  assert.deepEqual(
    plan.priceContract.review.conditions.map((condition) => condition.key),
    ['WATCH_PRICE'],
  )
})

test('缺少价格依据的主动交易计划必须被阻断', () => {
  const advice = {
    action: '立即买入',
    buyPrice: 10.7,
    stopPrice: 9.1,
    targetPrice: 12.9,
    planQty: 1,
  }
  const unverifiedPayload = {
    ...payload,
    tech: {
      atr: 0.1,
      support: 9.5,
      resistance: 10.4,
      stopLoss: 9.5,
      takeProfit: 12,
    },
  }
  advice.priceContract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice,
    payload: unverifiedPayload,
    action: 'BUY',
  })
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice,
    payload: unverifiedPayload,
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.actionability, 'BLOCKED')
  assert.match(plan.blockedReasons.join('；'), /关键执行价缺少可核验依据/)
})

test('降低风险动作不受新增风险约束且不得超过今日可卖数量', () => {
  const plan = compileDecisionPlan({
    mode: 'hold_advice',
    advice: {
      action: '减仓',
      reducePrice: 12,
      stopPrice: 9,
      targetPrice: 13,
      opQty: '减仓5手',
    },
    payload: {
      ...payload,
      holdQty: 5,
      sellableTodayQty: 2,
      account: { ...payload.account, stockWeight: 12 },
    },
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.action, 'REDUCE')
  assert.equal(plan.actionability, 'READY')
  assert.equal(plan.quantity.lots, 2)
})

test('关键证据不完整时新增风险必须阻断', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 1,
    },
    payload: { code: '600519', name: '贵州茅台', account: payload.account },
    evidenceSnapshot: {
      ...snapshot,
      freshness: {
        status: 'PARTIAL',
        missingRequiredSources: ['quote', 'market', 'quant'],
      },
    },
    now,
  })

  assert.equal(plan.actionability, 'BLOCKED')
  assert.match(plan.blockedReasons.join('；'), /关键证据不完整/)
})

test('账户熔断阻止新增风险但不阻止减仓退出', () => {
  const breaker = {
    allowRiskIncrease: false,
    blockers: [{ message: '当日总资产回撤达到熔断线' }],
  }
  const buy = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 1,
    },
    payload,
    evidenceSnapshot: snapshot,
    accountCircuitBreaker: breaker,
    now,
  })
  const reduce = compileDecisionPlan({
    mode: 'hold_advice',
    advice: {
      action: '减仓',
      reducePrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      opQty: '减仓1手',
    },
    payload: { ...payload, holdQty: 2, sellableTodayQty: 2 },
    evidenceSnapshot: snapshot,
    accountCircuitBreaker: breaker,
    now,
  })

  assert.equal(buy.actionability, 'BLOCKED')
  assert.equal(reduce.actionability, 'READY')
})

test('被阻断的新增风险计划不能升级为执行确认', () => {
  const gate = decisionPlanConfirmationGate({
    schemaVersion: 'decision-plan.v2',
    action: 'BUY',
    actionability: 'BLOCKED',
  }, 'buy')

  assert.equal(gate.allowed, false)
  assert.match(gate.reason, /账户、证据或风险条件未通过/)
})

test('首次模型失败时返回不含交易数字的确定性等待计划', () => {
  const fallback = buildFallbackDecisionAdvice({
    mode: 'buy_advice',
    payload: { ...payload, quant: null, tech: null },
    evidenceSnapshot: snapshot,
    error: '模型超时',
    now,
  })

  assert.equal(fallback.action, '观望')
  assert.equal(fallback.decisionPlan.actionability, 'WATCH')
  assert.equal(fallback.planQty, 0)
  assert.equal(fallback.buyPrice, null)
  assert.equal(adviceCompleteness(fallback, 'buy_advice').complete, true)
})
