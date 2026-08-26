import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SHORT_HORIZON_ACTION_POLICY_VERSION,
  SHORT_HORIZON_TACTICAL_VERSION,
  attachShortHorizonSummary,
  buildShortHorizonTactical,
  deriveShortHorizonActionPolicy,
} from '../shared/shortHorizonTactical.js'

function payload(overrides = {}) {
  return {
    todayQuote: {
      price: 100,
      pct: 2,
      low: 97,
      high: 104,
      turnover: 5,
      volRatio: 1.8,
      live: true,
      phase: '上午盘中',
    },
    marketEnv: {
      score: 70,
      weak: false,
      allowRiskIncrease: true,
    },
    sectorOpportunity: {
      matched: true,
      sector: { actionability: '可买' },
      stock: { roleLabel: '前排龙头', score: 68 },
    },
    stockFund: {
      mainNetYi: 1.2,
      retailNetYi: -0.6,
    },
    quant: {
      score: 64,
      forecast: { direction: '看涨', upProb: 62 },
      highConfSignal: { fired: true },
    },
    tech: {
      atr: 2,
      support: 97,
      resistance: 104,
      rsi: 58,
    },
    intraday: {
      posInDay: 55,
    },
    ...overrides,
  }
}

test('强市场前排个股与主力吸筹投影为短线可行动状态', () => {
  const result = buildShortHorizonTactical(payload(), {
    now: Date.parse('2026-08-26T02:30:00.000Z'),
  })

  assert.equal(result.schemaVersion, SHORT_HORIZON_TACTICAL_VERSION)
  assert.equal(result.market.riskTone, 'RISK_ON')
  assert.equal(result.sector.state, 'LEADING')
  assert.equal(result.sector.stockRole, 'LEADER')
  assert.equal(result.flow.relation, 'ACCUMULATION')
  assert.equal(result.timing.state, 'READY')
  assert.equal(result.horizon, 'INTRADAY')
  assert.equal(result.conflicts.length, 0)
})

test('高位拥挤即使量化偏多也等待回踩并显式记录冲突', () => {
  const result = buildShortHorizonTactical(payload({
    todayQuote: {
      price: 100,
      pct: 9,
      low: 96,
      high: 101,
      turnover: 20,
      volRatio: 5.5,
      live: true,
      phase: '上午盘中',
    },
    intraday: { posInDay: 96 },
    tech: {
      atr: 3,
      support: 96,
      resistance: 101,
      rsi: 82,
    },
  }))

  assert.equal(result.stock.location, 'EXTENDED')
  assert.equal(result.stock.crowdingRisk, 'HIGH')
  assert.equal(result.timing.state, 'TOO_EXTENDED')
  assert.match(result.conflicts.join('；'), /量化偏多/)
})

test('主力流出且小单流入明确识别为派发风险', () => {
  const result = buildShortHorizonTactical(payload({
    stockFund: {
      mainNetYi: -1.5,
      retailNetYi: 1.1,
    },
  }))

  assert.equal(result.flow.mainDirection, 'OUTFLOW')
  assert.equal(result.flow.retailDirection, 'INFLOW')
  assert.equal(result.flow.relation, 'DISTRIBUTION')
})

test('远端复权支撑不进入战术路径并回退近期真实高低点', () => {
  const result = buildShortHorizonTactical(payload({
    todayQuote: {
      price: 128.61,
      pct: 0.5,
      low: 126.8,
      high: 130.2,
      turnover: 3,
      volRatio: 1.2,
      live: true,
      phase: '上午盘中',
    },
    tech: {
      atr: 3,
      support: 89.09,
      resistance: 89.09,
      rsi: 55,
    },
  }))

  assert.equal(result.timing.pullbackPrice, 126.8)
  assert.equal(result.timing.breakoutPrice, 130.2)
  assert.notEqual(result.timing.pullbackPrice, 89.09)
})

test('行情缺失时战术状态不可执行', () => {
  const result = buildShortHorizonTactical(payload({
    todayQuote: {},
    intraday: {},
  }))

  assert.equal(result.timing.state, 'INVALID')
  assert.equal(result.stock.location, 'UNKNOWN')
})

test('模型漏填短线摘要时由战术合同补齐用户字段', () => {
  const tactical = buildShortHorizonTactical(payload())
  const result = attachShortHorizonSummary({
    action: '观望',
  }, tactical)

  assert.equal(result.shortHorizon, '盘中')
  assert.match(result.edge, /板块前排|主力承接/)
  assert.ok(result.crowdingRisk)
  assert.ok(result.catalystWindow)
  assert.ok(result.reviewTrigger)
  assert.equal(
    result.shortHorizonTactical.schemaVersion,
    SHORT_HORIZON_TACTICAL_VERSION,
  )
})

test('账号内首要轮动只以机会成本摘要进入单股战术合同', () => {
  const tactical = buildShortHorizonTactical(payload({
    opportunityCost: {
      status: 'READY',
      actionable: true,
      sourceCode: '600000',
      targetCode: '000001',
      targetName: '平安银行',
      edgeScore: 12.4,
      tradingCost: 35.67,
      generatedAt: 1787700000000,
      ignored: '不应透传',
    },
  }))

  assert.deepEqual(tactical.opportunityCost, {
    status: 'READY',
    actionable: true,
    targetCode: '000001',
    targetName: '平安银行',
    edgeScore: 12.4,
    tradingCost: 35.67,
    generatedAt: 1787700000000,
  })
})

test('只有量化资金时机与流动性同时确认才允许新增风险', () => {
  const tactical = buildShortHorizonTactical(payload({
    todayQuote: {
      ...payload().todayQuote,
      amount: 2e8,
    },
  }))
  const policy = deriveShortHorizonActionPolicy({
    mode: 'buy_advice',
    tactical,
    requestedAction: 'BUY',
  })

  assert.equal(
    policy.schemaVersion,
    SHORT_HORIZON_ACTION_POLICY_VERSION,
  )
  assert.equal(policy.canIncreaseRisk, true)
  assert.deepEqual(policy.allowedActions, ['BUY', 'WATCH'])
  assert.equal(policy.effectiveAction, 'BUY')
  assert.equal(policy.overridden, false)
  assert.equal(policy.nextSessionPlan, null)
})

test('核心信号共振但成交额证据不足时只开放5%人工试仓', () => {
  const tactical = buildShortHorizonTactical(payload())
  const policy = deriveShortHorizonActionPolicy({
    mode: 'buy_advice',
    tactical,
    requestedAction: 'BUY',
  })

  assert.equal(policy.canIncreaseRisk, true)
  assert.equal(policy.riskTier, 'PROBE')
  assert.equal(policy.maxPositionPct, 5)
  assert.equal(policy.manualConfirmationOnly, true)
  assert.deepEqual(policy.allowedActions, ['BUY', 'WATCH'])
  assert.equal(policy.preferredAction, 'BUY')
  assert.match(
    policy.reasons.join('；'),
    /成交额数据未取得/,
  )
})

test('成交额证据明确区分数据缺失与低于流动性门槛', () => {
  const missing = buildShortHorizonTactical(payload())
  const limited = buildShortHorizonTactical(payload({
    todayQuote: {
      ...payload().todayQuote,
      amount: 80_000_000,
    },
  }))
  const sufficient = buildShortHorizonTactical(payload({
    todayQuote: {
      ...payload().todayQuote,
      amount: 2_520_236_581.02,
    },
  }))

  assert.match(
    missing.stock.liquidityEvidence.reason,
    /成交额数据未取得/,
  )
  assert.match(
    limited.stock.liquidityEvidence.reason,
    /0\.8亿元.*低于.*1亿元/,
  )
  assert.match(
    sufficient.stock.liquidityEvidence.reason,
    /25\.2亿元.*达到.*1亿元/,
  )
  assert.equal(sufficient.stock.liquidity, 'GOOD')
})

test('休市时当前保持观望但保留下一交易日条件买入预案', () => {
  const tactical = buildShortHorizonTactical(payload({
    marketPhase: '盘后(已收盘)',
    todayQuote: {
      ...payload().todayQuote,
      amount: 2e8,
      live: false,
      phase: '盘后(已收盘)',
    },
  }))
  const policy = deriveShortHorizonActionPolicy({
    mode: 'buy_advice',
    tactical,
    requestedAction: 'BUY',
  })

  assert.equal(policy.executionOpen, false)
  assert.deepEqual(policy.allowedActions, ['WATCH'])
  assert.equal(policy.effectiveAction, 'WATCH')
  assert.deepEqual(policy.nextSessionPlan, {
    action: 'BUY',
    actionLabel: '条件买入',
    session: 'NEXT_TRADING_DAY',
    sessionLabel: '下一交易日盘中',
    maxPositionPct: null,
    manualConfirmationOnly: true,
    requiresLiveReview: true,
    trigger: '下一交易日盘中，回踩97元确认承接或放量站上104元后重新评估',
  })
  assert.match(policy.reasons.join('；'), /盘中再判断/)
})

test('午间休市保留下午小仓试仓预案但不开放当前买入', () => {
  const tactical = buildShortHorizonTactical(payload({
    marketPhase: '午间休市',
    todayQuote: {
      ...payload().todayQuote,
      amount: null,
      phase: '午间休市',
    },
  }))
  const policy = deriveShortHorizonActionPolicy({
    mode: 'buy_advice',
    tactical,
    requestedAction: 'BUY',
  })

  assert.equal(policy.riskTier, 'PROBE')
  assert.equal(policy.executionOpen, false)
  assert.equal(policy.canIncreaseRisk, false)
  assert.deepEqual(policy.allowedActions, ['WATCH'])
  assert.deepEqual(policy.nextSessionPlan, {
    action: 'PROBE',
    actionLabel: '小仓试仓',
    session: 'AFTERNOON',
    sessionLabel: '下午盘中',
    maxPositionPct: 5,
    manualConfirmationOnly: true,
    requiresLiveReview: true,
    trigger: '下午盘中，回踩97元确认承接或放量站上104元后重新评估',
  })
})

test('持仓在盘后保留下一交易日小仓加仓预案', () => {
  const tactical = buildShortHorizonTactical(payload({
    marketPhase: '盘后(已收盘)',
    todayQuote: {
      ...payload().todayQuote,
      amount: null,
      live: false,
      phase: '盘后(已收盘)',
    },
  }))
  const policy = deriveShortHorizonActionPolicy({
    mode: 'hold_advice',
    tactical,
    requestedAction: 'HOLD',
  })

  assert.equal(policy.executionOpen, false)
  assert.equal(policy.riskTier, 'PROBE')
  assert.deepEqual(policy.allowedActions, [
    'HOLD',
    'REDUCE',
    'EXIT',
    'WATCH',
  ])
  assert.equal(policy.nextSessionPlan.action, 'PROBE_ADD')
  assert.equal(policy.nextSessionPlan.actionLabel, '小仓加仓')
  assert.equal(policy.nextSessionPlan.maxPositionPct, 5)
  assert.match(
    policy.nextSessionPlan.trigger,
    /下一交易日盘中/,
  )
})

test('量化轻度偏多只能参与人工试仓不能升级正式建仓', () => {
  const tactical = buildShortHorizonTactical(payload({
    quant: {
      score: 72,
      forecast: {
        direction: '震荡',
        upProb: 55,
        expRet: 0.5,
      },
      highConfSignal: { fired: false },
    },
  }))
  const policy = deriveShortHorizonActionPolicy({
    mode: 'buy_advice',
    tactical,
    requestedAction: 'BUY',
  })

  assert.equal(policy.riskTier, 'PROBE')
  assert.ok(policy.confirmations.includes('量化轻度偏多'))
  assert.equal(policy.manualConfirmationOnly, true)
  assert.match(
    policy.reasons.join('；'),
    /量化尚未形成强偏多确认/,
  )
})

test('高位追涨请求被短线动作政策确定性降级为观望', () => {
  const tactical = buildShortHorizonTactical(payload({
    todayQuote: {
      ...payload().todayQuote,
      pct: 9,
      turnover: 20,
      volRatio: 5.5,
      amount: 3e8,
    },
    intraday: { posInDay: 96 },
  }))
  const policy = deriveShortHorizonActionPolicy({
    mode: 'buy_advice',
    tactical,
    requestedAction: 'BUY',
  })

  assert.deepEqual(policy.allowedActions, ['WATCH'])
  assert.equal(policy.effectiveAction, 'WATCH')
  assert.equal(policy.overridden, true)
  assert.match(policy.reasons.join('；'), /禁止追涨|拥挤度/)
})

test('持仓场景始终放行减仓退出但严格限制加仓', () => {
  const tactical = buildShortHorizonTactical(payload({
    todayQuote: {
      ...payload().todayQuote,
      amount: 2e8,
    },
    stockFund: {
      mainNetYi: -1.5,
      retailNetYi: 1.2,
    },
  }))
  const addPolicy = deriveShortHorizonActionPolicy({
    mode: 'hold_advice',
    tactical,
    requestedAction: 'ADD',
  })
  const exitPolicy = deriveShortHorizonActionPolicy({
    mode: 'hold_advice',
    tactical,
    requestedAction: 'EXIT',
  })

  assert.equal(addPolicy.effectiveAction, 'HOLD')
  assert.equal(addPolicy.overridden, true)
  assert.ok(addPolicy.allowedActions.includes('REDUCE'))
  assert.ok(addPolicy.allowedActions.includes('EXIT'))
  assert.equal(exitPolicy.effectiveAction, 'EXIT')
})

test('做T未完成腿只允许继续既定方向', () => {
  const tactical = {
    ...buildShortHorizonTactical(payload()),
    tAction: { stage: 'buy_wait_sell' },
  }
  const policy = deriveShortHorizonActionPolicy({
    mode: 't_advice',
    tactical,
    requestedAction: 'T_BUY_FIRST',
  })

  assert.deepEqual(
    policy.allowedActions,
    ['T_SELL_FIRST', 'WATCH'],
  )
  assert.equal(policy.effectiveAction, 'WATCH')
  assert.equal(policy.overridden, true)
})
