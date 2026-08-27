import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFallbackDecisionAdvice,
  compileDecisionPlan,
  decisionPlanConfirmationGate,
} from '../shared/decisionPlan.js'
import { adviceCompleteness } from '../shared/adviceBatchPolicy.js'
import { buildAdvicePriceContract } from '../shared/advicePriceContract.js'
import { buildShortHorizonTactical } from '../shared/shortHorizonTactical.js'

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
    amount: 2e8,
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
  stockFund: {
    mainNetYi: 1.2,
    retailNetYi: -0.4,
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
  assert.equal(
    plan.tactical.schemaVersion,
    'short-horizon-tactical.v1',
  )
  assert.equal(plan.tactical.timingState, 'READY')
  assert.equal(plan.tactical.horizon, 'INTRADAY')
  assert.equal(plan.actionPolicy.canIncreaseRisk, true)
  assert.equal(plan.actionPolicy.overridden, false)
  assert.equal(plan.strategy, undefined)
  assert.equal(plan.strategyRoute, undefined)
})

test('条件试仓到价后最终计划可升级为5%小仓试错而不是再次观望', () => {
  const tactical = buildShortHorizonTactical(payload, { now })
  tactical.timing = {
    ...tactical.timing,
    state: 'WAIT_PULLBACK',
  }
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '小仓试错',
      tier: 'probe',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 10,
      actionPlan: '按10元小仓买入，跌破9元退出',
    },
    payload: {
      ...payload,
      shortHorizonTactical: tactical,
      reviewEvent: {
        kind: 'price-review',
        reviewMode: 'ENTRY_CONFIRMATION',
        plannedAction: 'PROBE',
        directionApproved: true,
        maxPositionPct: 5,
        threshold: 10,
        price: 10,
      },
    },
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.requestedAction, 'BUY')
  assert.equal(plan.governedAction, 'BUY')
  assert.equal(plan.action, 'BUY')
  assert.equal(plan.actionability, 'READY')
  assert.equal(plan.actionPolicy.riskTier, 'PROBE')
  assert.equal(plan.actionPolicy.canIncreaseRisk, true)
  assert.ok(plan.quantity.lots > 0)
  assert.ok(plan.quantity.lots <= 5)
})

test('模型建议追高但短线时机过热时确定性改为观望', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 2,
      actionPlan: '立即追涨买入2手',
    },
    payload: {
      ...payload,
      todayQuote: {
        ...payload.todayQuote,
        pct: 9,
        turnover: 20,
        volRatio: 5.5,
      },
      intraday: { posInDay: 96 },
    },
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.requestedAction, 'BUY')
  assert.equal(plan.governedAction, 'WATCH')
  assert.equal(plan.action, 'WATCH')
  assert.equal(plan.actionability, 'WATCH')
  assert.equal(plan.quantity.lots, 0)
  assert.equal(plan.actionPolicy.overridden, true)
  assert.match(
    plan.actionPolicy.reasons.join('；'),
    /禁止追涨|拥挤度/,
  )
  assert.doesNotMatch(plan.trigger, /立即追涨/)
})

test('收盘后买入计划不得进入可执行或显示已经到价', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 9.8,
      stopPrice: 9,
      targetPrice: 11.5,
      planQtyNum: 2,
      actionPlan: '回踩9.8元买入2手',
    },
    payload: {
      ...payload,
      marketPhase: '盘后(已收盘)',
      todayQuote: {
        ...payload.todayQuote,
        price: 10,
        live: false,
        phase: '盘后(已收盘)',
      },
    },
    evidenceSnapshot: {
      ...snapshot,
      marketTime: {
        phase: '盘后(已收盘)',
        isLive: false,
        dataDayLabel: '2026-08-21(周五)',
      },
    },
    now,
  })

  assert.equal(plan.requestedAction, 'BUY')
  assert.equal(plan.governedAction, 'WATCH')
  assert.equal(plan.action, 'WATCH')
  assert.equal(plan.actionability, 'WATCH')
  assert.equal(plan.quantity.lots, 0)
  assert.equal(plan.actionPolicy.executionOpen, false)
  assert.match(plan.trigger, /下一交易日/)
})

test('绕过输出校正的高价买入仍被决策编译器阻断', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10.5,
      stopPrice: 9,
      targetPrice: 13.5,
      planQtyNum: 2,
      actionPlan: '站上10.5元买入2手',
    },
    payload,
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.action, 'WATCH')
  assert.equal(plan.actionability, 'BLOCKED')
  assert.match(
    plan.blockedReasons.join('；'),
    /高于当前价.*不能作为回踩执行价/,
  )
})

test('持仓加仓缺少资金确认时改为持有但不阻止减仓', () => {
  const weakFlowPayload = {
    ...payload,
    holdQty: 3,
    sellableTodayQty: 3,
    stockFund: {
      mainNetYi: -1.2,
      retailNetYi: 0.8,
    },
  }
  const add = compileDecisionPlan({
    mode: 'hold_advice',
    advice: {
      action: '加仓',
      addPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      opQty: '加仓1手',
    },
    payload: weakFlowPayload,
    evidenceSnapshot: snapshot,
    now,
  })
  const reduce = compileDecisionPlan({
    mode: 'hold_advice',
    advice: {
      action: '减仓',
      reducePrice: 10,
      opQty: '减仓1手',
    },
    payload: weakFlowPayload,
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(add.requestedAction, 'ADD')
  assert.equal(add.action, 'HOLD')
  assert.equal(add.actionPolicy.overridden, true)
  assert.equal(reduce.action, 'REDUCE')
  assert.equal(reduce.actionability, 'READY')
})

test('持仓建议的观望语义在决策计划中归一为持有', () => {
  const plan = compileDecisionPlan({
    mode: 'hold_advice',
    advice: {
      action: '观望',
      actionPlan: '当前不加仓、不做T，继续等待新证据',
      stopPrice: 9,
    },
    payload: {
      ...payload,
      holdQty: 1,
      sellableTodayQty: 0,
    },
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.requestedAction, 'HOLD')
  assert.equal(plan.action, 'HOLD')
  assert.equal(plan.actionLabel, '持有')
  assert.equal(plan.actionability, 'WATCH')
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

test('短线政策只开放试仓时即使模型建议重仓也强制限制5%', () => {
  const { amount: _amount, ...quoteWithoutAmount } = payload.todayQuote
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 100,
      actionPlan: '立即买入100手',
    },
    payload: {
      ...payload,
      todayQuote: quoteWithoutAmount,
    },
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.action, 'BUY')
  assert.equal(plan.actionability, 'READY')
  assert.equal(plan.actionPolicy.riskTier, 'PROBE')
  assert.equal(plan.manualConfirmationOnly, true)
  assert.equal(plan.risk.manualProbeLimitPct, 5)
  assert.ok(plan.quantity.lots > 0)
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

test('市场硬红线不能被逆势强票和量化高把握绕过', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '小仓试错',
      tier: 'probe',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 1,
    },
    payload: {
      ...payload,
      marketEnv: {
        ...payload.marketEnv,
        regime: 'RISK_OFF',
        score: 38,
        weak: true,
        allowRiskIncrease: false,
        hardRiskOff: true,
        hardRiskSignals: ['炸板率45%超过40%'],
      },
      counterTrend: { isStrong: true },
    },
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.action, 'WATCH')
  assert.equal(plan.actionability, 'BLOCKED')
  assert.match(plan.blockedReasons.join('；'), /市场风险红线.*炸板率/)
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

test('确定性退出优先级与T+1状态进入统一决策计划', () => {
  const plan = compileDecisionPlan({
    mode: 'hold_advice',
    advice: {
      action: '持有',
      stopPrice: 9,
      targetPrice: 12,
      exitManagement: {
        schemaVersion: 'exit-management.v1',
        kind: 'HARD_STOP',
        priority: 1,
        action: '持有',
        lots: 0,
        totalLots: 2,
        sellableLots: 0,
        lockedLots: 2,
        blockedByT1: true,
        referencePrice: 8.9,
        reason: '止损触发但今日不可卖',
        nextReviewTrigger: '下一交易日仓位解锁',
      },
    },
    payload: {
      ...payload,
      holdQty: 2,
      sellableTodayQty: 0,
    },
    evidenceSnapshot: snapshot,
    now,
  })

  assert.equal(plan.exitManagement.kind, 'HARD_STOP')
  assert.equal(plan.exitManagement.priority, 1)
  assert.equal(plan.exitManagement.blockedByT1, true)
  assert.equal(plan.exitManagement.lockedLots, 2)
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

test('跨日连续亏损会把下一笔风险预算减半', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 10,
    },
    payload,
    evidenceSnapshot: snapshot,
    accountCircuitBreaker: {
      schemaVersion: 'account-circuit-breaker.v1',
      allowRiskIncrease: true,
      riskBudgetMultiplier: 0.5,
      riskBudgetReason: '最近连续亏损2笔，下一笔风险预算降至50%',
      blockers: [],
      blockerCodes: [],
    },
    now,
  })

  assert.equal(plan.actionability, 'READY')
  assert.equal(plan.risk.maxLossAmount, 500)
  assert.equal(
    plan.risk.accountCircuitBreaker.riskBudgetMultiplier,
    0.5,
  )
  assert.match(
    plan.risk.accountCircuitBreaker.riskBudgetReason,
    /降至50%/,
  )
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
