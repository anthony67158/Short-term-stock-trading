import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFallbackDecisionAdvice,
  compileDecisionPlan,
  decisionPlanConfirmationGate,
} from '../shared/decisionPlan.js'
import { adviceCompleteness } from '../shared/adviceBatchPolicy.js'
import { buildAdvicePriceContract } from '../shared/advicePriceContract.js'
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

test('统一决策计划固化全部价格依据和观望双条件', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '观望',
      actionPlan: '放量站上10.8元且策略审核通过后重新判断',
      watchPrice: 10.8,
      stopPrice: 9,
      targetPrice: 11,
    },
    payload: {
      ...payload,
      tech: {
        atr: 0.4,
        support: 9,
        resistance: 10.8,
        stopLoss: 9,
        takeProfit: 11,
      },
    },
    evidenceSnapshot: snapshot,
    strategyGate: {
      productionEligible: false,
      blockers: [{ code: 'BACKTEST_REQUIRED' }],
    },
    now,
  })

  assert.equal(plan.prices.watch, 10.8)
  assert.equal(plan.priceContract.schemaVersion, 'advice-price-contract.v1')
  assert.equal(plan.priceContract.levels.find(
    (level) => level.key === 'watch',
  ).basis, 'technical.resistance')
  assert.deepEqual(
    plan.priceContract.review.conditions.map((condition) => [
      condition.key,
      condition.status,
    ]),
    [
      ['WATCH_PRICE', 'PENDING'],
      ['STRATEGY_ELIGIBLE', 'PENDING'],
    ],
  )
})

test('缺少价格依据的主动交易计划必须被阻断', () => {
  const unverifiedAdvice = {
    action: '立即买入',
    buyPrice: 10.7,
    stopPrice: 9.1,
    targetPrice: 10.9,
    planQty: 1,
    actionPlan: '10.7元买入1手',
  }
  const unverifiedPayload = {
    ...payload,
    tech: {
      atr: 0.1,
      support: 9.5,
      resistance: 10.4,
      stopLoss: 9.5,
      takeProfit: 10.4,
    },
  }
  unverifiedAdvice.priceContract = buildAdvicePriceContract({
    mode: 'buy_advice',
    advice: unverifiedAdvice,
    payload: unverifiedPayload,
    strategyGate: { productionEligible: true },
    action: 'BUY',
  })
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: unverifiedAdvice,
    payload: unverifiedPayload,
    evidenceSnapshot: snapshot,
    strategyGate: { productionEligible: true, blockers: [] },
    now,
  })

  assert.equal(plan.action, 'WATCH')
  assert.equal(plan.actionability, 'BLOCKED')
  assert.match(plan.blockedReasons.join('；'), /关键执行价缺少可核验依据/)
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

test('当前减仓指令优先于后续防守条件编译为立即处理', () => {
  const plan = compileDecisionPlan({
    mode: 'hold_advice',
    advice: {
      action: '减仓',
      reducePrice: 33.24,
      stopPrice: 31.82,
      targetPrice: 36,
      opQty: '减仓1手',
      actionPlan: '弱市中未显著抗跌，先减仓1手控制回撤',
      timing: '触及31.82元且30至60分钟不能收回再减仓',
    },
    payload: {
      ...payload,
      holdQty: 2,
      sellableTodayQty: 2,
      account: { ...account, stockWeight: 12 },
    },
    evidenceSnapshot: snapshot,
    strategySpec: getActiveStrategySpec(),
    strategyGate: { productionEligible: true, blockers: [] },
    now,
  })

  assert.equal(plan.trigger, '弱市中未显著抗跌，先减仓1手控制回撤')
  assert.equal(plan.triggerDirection, 'IMMEDIATE')
  assert.equal(plan.prices.reference, 33.24)
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

test('休市快照进入决策计划时保留数据口径和截至交易日', () => {
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '回调再买',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQty: 1,
    },
    payload: {
      ...payload,
      todayQuote: {
        ...payload.todayQuote,
        live: false,
        phase: '休市(周末)',
        asOfLabel: '2026-08-21(周五)',
      },
    },
    evidenceSnapshot: {
      ...snapshot,
      marketTime: {
        phase: '休市(周末)',
        dataDayLabel: '2026-08-21(周五)',
        isLive: false,
        evidenceState: 'PREVIOUS_CLOSE',
        basisLabel: '最近交易日完整数据',
      },
      freshness: {
        status: 'PREVIOUS_CLOSE',
        missingSources: [],
        missingRequiredSources: [],
      },
    },
    strategySpec: getActiveStrategySpec(),
    strategyGate: { productionEligible: true, blockers: [] },
    now,
  })

  assert.deepEqual(plan.evidenceBasis, {
    state: 'PREVIOUS_CLOSE',
    label: '最近交易日完整数据',
    dataAsOf: '2026-08-21(周五)',
    phase: '休市(周末)',
    isLive: false,
  })
  assert.doesNotMatch(plan.blockedReasons.join('；'), /关键证据不完整/)
})

test('证据缺失只报告根因并抑制市场策略与预算派生误判', () => {
  const missingDetails = [
    {
      source: 'quote',
      label: '实时行情',
      status: 'ERROR',
      reason: '接口返回 HTTP 401',
      impact: '无法确认当前价和价格时效',
      recovery: '行情接口恢复后重新生成',
      required: true,
    },
    {
      source: 'market',
      label: '市场状态',
      status: 'ERROR',
      reason: '接口返回 HTTP 401',
      impact: '无法判断是否允许新增风险',
      recovery: '大盘数据恢复后重新生成',
      required: true,
    },
    {
      source: 'quant',
      label: '量化预测',
      status: 'SKIPPED',
      reason: '个股K线数据不足，量化预测未启动',
      impact: '无法验证方向概率和目标价区间',
      recovery: 'K线和量化服务恢复后重新生成',
      required: true,
    },
  ]
  const plan = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 1,
    },
    payload: {
      code: '600519',
      name: '贵州茅台',
      account,
    },
    evidenceSnapshot: {
      ...snapshot,
      freshness: {
        status: 'PARTIAL',
        missingSources: ['quote', 'market', 'quant'],
        missingRequiredSources: ['quote', 'market', 'quant'],
        missingDetails,
      },
    },
    strategySpec: getActiveStrategySpec(),
    strategyGate: {
      productionEligible: false,
      blockers: [{ code: 'BACKTEST_REQUIRED' }],
    },
    now,
  })
  const reasons = plan.blockedReasons.join('；')

  assert.deepEqual(plan.evidenceIssues, missingDetails)
  assert.match(reasons, /实时行情.*HTTP 401/)
  assert.match(reasons, /量化预测.*K线数据不足/)
  assert.doesNotMatch(reasons, /当前市场状态禁止新增风险/)
  assert.doesNotMatch(reasons, /策略入场条件未通过/)
  assert.doesNotMatch(reasons, /风险预算或现金不足一手/)
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

test('账户级熔断会阻止新增风险但不阻止减仓退出', () => {
  const accountCircuitBreaker = {
    schemaVersion: 'account-circuit-breaker.v1',
    allowRiskIncrease: false,
    blockerCodes: ['DAILY_DRAWDOWN'],
    blockers: [{
      code: 'DAILY_DRAWDOWN',
      message: '当日总资产回撤达到熔断线',
    }],
  }
  const buy = compileDecisionPlan({
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQtyNum: 2,
    },
    payload,
    evidenceSnapshot: snapshot,
    strategySpec: getActiveStrategySpec(),
    strategyGate: { productionEligible: true, blockers: [] },
    accountCircuitBreaker,
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
    payload: {
      ...payload,
      holdQty: 2,
      sellableTodayQty: 2,
    },
    evidenceSnapshot: snapshot,
    strategySpec: getActiveStrategySpec(),
    strategyGate: { productionEligible: true, blockers: [] },
    accountCircuitBreaker,
    now,
  })

  assert.equal(buy.actionability, 'BLOCKED')
  assert.ok(buy.blockedReasons.some((item) => /回撤/.test(item)))
  assert.equal(reduce.actionability, 'READY')
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
