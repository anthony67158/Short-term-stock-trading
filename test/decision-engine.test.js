import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDecisionAction } from '../shared/decisionEnginePolicy.js'
import { evaluateDecision } from '../api/_decision_orchestrator.js'
import { adviceCompleteness } from '../shared/adviceBatchPolicy.js'
import { readFileSync } from 'node:fs'
import { buildAdviceCacheEntry } from '../shared/adviceContinuity.js'
import {
  decisionActionAlertMessage,
  isCurrentDecisionAlert,
  projectAdviceAlerts,
} from '../shared/adviceAlerts.js'

const payload = {
  code: '600001',
  name: '测试股份',
  todayQuote: { price: 10, live: true },
  holdQty: 0,
}
const plan = {
  route: 'IMMEDIATE',
  entryPlan: { price: 10 },
  exitPlan: { hardStopPrice: 9, takeProfitPrice: 12 },
  opportunityScore: {
    state: 'READY', serverVerified: true, productionEligible: true,
    shadowOnly: false, pFill: 0.8, pWinGivenFill: 0.6,
    expectedNetR: 0.3, netRLowerBound: -0.8, expectedShortfall10: -1.2,
    modelVersion: 'test-decision-model',
  },
}

test('系统选定动作不接受LLM手数或结论', () => {
  const first = buildDecisionAction({ payload, plans: [plan], now: 1 })
  const second = buildDecisionAction({
    payload: { ...payload, previousAdvice: { action: '清仓', planQty: 99 } },
    plans: [plan], now: 1,
  })
  assert.deepEqual(first, second)
  assert.equal(first.action, '立即买入')
  assert.equal(first.planQty, 0)
  assert.equal(first.decisionSource.explanationRequired, false)
})

test('直接使用模式不要求模型通过晋级', () => {
  const result = buildDecisionAction({
    payload,
    plans: [{ ...plan, opportunityScore: {
      ...plan.opportunityScore, productionEligible: false, shadowOnly: true, usagePolicy: 'DIRECT',
    } }],
  })
  assert.equal(result.action, '立即买入')
  assert.equal(result.decisionSource.state, 'READY')
  assert.equal(result.decisionSource.usagePolicy, 'DIRECT')
})

test('直接使用模型的分布外提示不再伪装成未就绪', () => {
  const result = buildDecisionAction({
    payload, plans: [{ ...plan, opportunityScore: {
      ...plan.opportunityScore, productionEligible: false, shadowOnly: true,
      usagePolicy: 'DIRECT', outOfDistribution: true,
    } }],
  })
  assert.equal(result.action, '立即买入')
  assert.equal(result.decisionSource.state, 'READY')
  assert.equal(result.decisionSource.outOfDistribution, true)
})

test('没有持仓模型时仍保留止损和T+1保护', () => {
  const holding = { ...payload, holdQty: 2, holdingStopPrice: 10.2 }
  const locked = buildDecisionAction({ payload: { ...holding, sellableTodayQty: 0 } })
  const sellable = buildDecisionAction({ payload: { ...holding, sellableTodayQty: 1 } })
  assert.equal(locked.action, '持有')
  assert.match(locked.actionPlan, /T\+1/)
  assert.equal(sellable.action, '减仓')
  assert.equal(sellable.opQty, '减仓1手')
  assert.equal(sellable.decisionSource.state, 'MODEL_ERROR')
})

test('模块化引擎使用统一动作价值管理持仓而不调用旧加权公式', () => {
  const held = { ...payload, holdQty: 2, sellableTodayQty: 2, holdingStopPrice: 9 }
  const positive = buildDecisionAction({ payload: held, plans: [plan] })
  const negative = buildDecisionAction({
    payload: held,
    plans: [{ ...plan, opportunityScore: { ...plan.opportunityScore, expectedNetR: -0.2 } }],
  })
  assert.equal(positive.action, '持有')
  assert.equal(negative.action, '清仓')
  assert.equal(
    negative.actionValues.schemaVersion,
    'action-value-vector.v1',
  )
})

test('持仓仲裁读取任务头价值并输出完整动作向量', () => {
  const held = {
    ...payload,
    holdQty: 2,
    sellableTodayQty: 2,
    holdingStopPrice: 9,
  }
  const scoredPlan = {
    ...plan,
    opportunityScore: {
      ...plan.opportunityScore,
      engine: {
        stateEncoder: 'state-encoder.tree-v1',
        router: 'action-router.tree-v1',
        heads: { portfolio: 'portfolio-heads.tree-v1' },
      },
      taskValues: {
        schemaVersion: 'decision-task-values.v1',
        entry: { expectedNetR: 0.1, pFill: 0.8 },
        portfolio: {
          holdR: -0.2,
          addExecutionAdjustedR: -0.16,
          reduceRelativeToHoldR: 0.25,
          exitRelativeToHoldR: 0.5,
        },
        risk: { q10R: -0.9, cvarR: -1.2 },
        execution: { pFill: 0.8 },
      },
    },
  }
  const result = buildDecisionAction({
    payload: held,
    plans: [scoredPlan],
  })

  assert.equal(result.action, '清仓')
  assert.deepEqual(
    result.actionValues.actions.map((value) => value.action),
    ['HOLD', 'REDUCE', 'EXIT', 'ADD'],
  )
  assert.equal(result.actionValues.actions[2].actionUtilityR, 0.5)
  assert.equal(
    result.actionValues.encoderVersion,
    'state-encoder.tree-v1',
  )
})

test('部分可卖仓位不能被仲裁成全部退出', () => {
  const result = buildDecisionAction({
    payload: {
      ...payload,
      holdQty: 2,
      sellableTodayQty: 1,
      holdingStopPrice: 9,
    },
    plans: [{
      ...plan,
      opportunityScore: {
        ...plan.opportunityScore,
        expectedNetR: -0.2,
      },
    }],
  })

  assert.equal(result.action, '减仓')
  assert.equal(
    result.actionValues.actions.find(
      (value) => value.action === 'EXIT',
    )?.feasible,
    false,
  )
})

test('持仓价值为正时保留当前仓位并生成单一路径加仓观察价', () => {
  const held = {
    ...payload,
    holdQty: 2,
    sellableTodayQty: 2,
    holdingStopPrice: 9,
  }
  const pullback = {
    ...plan,
    route: 'PULLBACK',
    entryPlan: { ...plan.entryPlan, price: 9.8 },
    opportunityScore: {
      ...plan.opportunityScore,
      expectedNetR: 0.5,
      priceContract: {
        entryPrice: 9.8,
        stopPrice: 9,
        targetPrice: 12,
      },
    },
  }
  const result = buildDecisionAction({
    payload: held,
    plans: [plan, pullback],
  })

  assert.equal(result.action, '持有')
  assert.equal(result.pullbackWatchPrice, 9.8)
  assert.equal(result.breakoutWatchPrice, null)
  assert.equal(result.holdingAddPlan.route, 'PULLBACK')
  assert.equal(result.holdingAddPlan.plannedAction, 'PROBE_ADD')
})

test('持仓加仓观察价复核通过后系统输出ADD请求', () => {
  const result = buildDecisionAction({
    payload: {
      ...payload,
      holdQty: 2,
      sellableTodayQty: 2,
      holdingStopPrice: 9,
      reviewEvent: {
        kind: 'price-review',
        reviewMode: 'ENTRY_CONFIRMATION',
        plannedAction: 'PROBE_ADD',
        actionLabel: '条件小仓加仓',
        directionApproved: true,
        maxPositionPct: 5,
      },
    },
    plans: [plan],
  })

  assert.equal(result.action, '加仓')
  assert.equal(result.addPrice, 10)
  assert.equal(result.buyPrice, null)
  assert.equal(result.holdingAddPlan, null)
  assert.match(result.actionPlan, /加仓/)
})

test('完整决策评估在模型未就绪时独立返回明确状态与零LLM调用', async () => {
  let calls = 0
  const result = await evaluateDecision({
    code: '600001',
    book: { account: { totalAssets: 100000, cash: 100000 }, holding: [], closed: [] },
    quotes: [{ code: '600001', price: 10, isLivePrice: false }],
    detail: { candles: Array.from({ length: 30 }, () => ({ close: 10, high: 10.2, low: 9.8 })) },
    trends: [],
    fund: { mainNetYi: 0.1, retailNetYi: -0.1 },
    market: { breadth: { up: 3000, down: 1000, flat: 100 } },
    score: async () => { calls++; return new Map() },
  })
  assert.equal(calls, 3)
  assert.equal(result.meta.llmCalls, 0)
  assert.equal(result.result.decisionSource.state, 'MODEL_ERROR')
  assert.equal(result.result.decisionPlan.quantity.lots, 0)
  assert.match(result.result.actionPlan, /决策模型不可用/)
  assert.equal(adviceCompleteness(result.result, result.mode).complete, true)
})

const now = Date.parse('2026-09-10T02:10:00Z')
function scenario(overrides = {}) {
  return {
    code: '600001', now,
    book: { account: { cash: 100000 }, holding: [], closed: [], executionPlans: [] },
    quotes: [{ code: '600001', price: 10, isLivePrice: true, tradeDate: '2026-09-10' }],
    detail: { candles: Array.from({ length: 30 }, () => ({ close: 10, high: 10.2, low: 9.8 })) },
    trends: [], fund: { mainNetYi: 1, retailNetYi: -1 },
    market: { breadth: { up: 3000, down: 1000, flat: 100 } },
    score: async ([input]) => new Map([[input.code, {
      ...plan.opportunityScore,
      expectedNetR: input.dimensions.route === 'IMMEDIATE' ? 0.8 : 0.1,
    }]]),
    ...overrides,
  }
}

test('系统完整编译保留同一路径价格与概率，保存恢复不依赖LLM', async () => {
  const result = await evaluateDecision(scenario())
  const decision = result.result.decisionPlan
  assert.equal(decision.action, 'BUY')
  assert.equal(decision.actionability, 'READY')
  assert.ok(decision.quantity.lots > 0)
  assert.equal(decision.risk.tradeExpectancy.source, 'DECISION_MODEL')
  assert.equal(
    decision.prices.reference,
    result.result.selectedDecisionPlan.entryPlan.price,
  )
  assert.equal(
    result.result.decisionRationale.schemaVersion,
    'decision-rationale.v1',
  )
  assert.equal(result.result.decisionRationale.context, 'ENTRY')
  assert.equal(
    result.result.decisionRationale.quantity.lots,
    decision.quantity.lots,
  )
  assert.equal(
    result.result.quantNote,
    result.result.decisionRationale.summary,
  )
  const entry = buildAdviceCacheEntry(null, { mode: result.mode, advice: result.result }, now)
  const restored = JSON.parse(JSON.stringify(entry))
  assert.deepEqual(restored.advice.decisionPlan, decision)
  assert.equal(adviceCompleteness(restored.advice, result.mode).complete, true)
})

test('持仓初评生成加仓观察价并保留账户核定预算', async () => {
  const result = await evaluateDecision(scenario({
    book: {
      account: { totalAssets: 100000, cash: 60000 },
      closed: [],
      executionPlans: [],
      holding: [{
        code: '600001',
        qty: 2,
        buyPrice: 9.5,
        sl: 9,
        buyAt: now - 86400000,
      }],
    },
    score: async ([input]) => new Map([[input.code, {
      ...plan.opportunityScore,
      expectedNetR: input.dimensions.route === 'PULLBACK'
        ? 0.7
        : input.dimensions.route === 'IMMEDIATE' ? 0.3 : 0.2,
    }]]),
  }))

  assert.equal(result.result.decisionPlan.action, 'HOLD')
  assert.equal(result.result.decisionPlan.actionability, 'WATCH')
  assert.ok(result.result.decisionPlan.entryBudget.lots > 0)
  assert.ok(result.result.pullbackWatchPrice > 0)
  assert.equal(result.result.holdingAddPlan.route, 'PULLBACK')
  assert.equal(result.result.decisionRationale.context, 'POSITION')
  assert.equal(
    result.result.decisionRationale.entryInstruction.intent,
    'ADD_POSITION',
  )
  assert.equal(
    result.result.decisionRationale.entryInstruction.state,
    'WAIT_TRIGGER',
  )
  assert.equal(
    result.result.decisionRationale.entryInstruction.quantity.plannedLots,
    result.result.decisionPlan.entryBudget.lots,
  )
  assert.equal(
    result.result.decisionRationale.entryInstruction.price.observationPrice,
    result.result.pullbackWatchPrice,
  )
  assert.equal(result.result.decisionRationale.pathComparison.length, 0)
  assert.ok(
    result.result.decisionRationale.actionComparison.some(
      (item) => item.action === 'HOLD',
    ),
  )

  const data = {
    holding: result.result.decisionPlan.quantity.holdingLots
      ? [{ code: '600001', qty: 2, sl: 9 }]
      : [],
    closed: [],
    plan: [],
    alerts: [],
    settings: {},
    advice: { '600001': { mode: 'hold_advice', advice: result.result } },
  }
  projectAdviceAlerts(data, '600001', result.result, {
    now,
    adviceAt: result.updatedAt,
    requirePriceContract: true,
    t1Status: { liveQty: 2, sellableToday: 2 },
  })
  assert.ok(data.alerts.some((alert) =>
    alert.reviewOnly === true
    && alert.reviewCategory === 'holding-add'
  ))

  const blocked = await evaluateDecision(scenario({
    ...scenario(),
    book: {
      account: { totalAssets: 100000, cash: 0 },
      closed: [],
      executionPlans: [],
      holding: [{
        code: '600001',
        qty: 2,
        buyPrice: 9.5,
        sl: 9,
        buyAt: now - 86400000,
      }],
    },
    score: async ([input]) => new Map([[input.code, {
      ...plan.opportunityScore,
      expectedNetR: input.dimensions.route === 'PULLBACK'
        ? 0.7
        : 0.3,
    }]]),
  }))
  assert.equal(blocked.result.decisionPlan.entryBudget, null)
  assert.equal(
    blocked.result.actionValues.actions.find(
      (value) => value.action === 'ADD',
    )?.feasible,
    false,
  )
  assert.equal(blocked.result.holdingAddPlan, null)
  assert.equal(blocked.result.pullbackWatchPrice, null)
  assert.equal(blocked.result.breakoutWatchPrice, null)
})

test('持仓加仓到价后由决策模型和账户风控共同核定手数', async () => {
  const addEvent = {
    kind: 'price-review',
    reviewMode: 'ENTRY_CONFIRMATION',
    plannedAction: 'PROBE_ADD',
    actionLabel: '条件小仓加仓',
    directionApproved: true,
    maxPositionPct: 5,
    direction: 'lte',
    threshold: 10,
    price: 10,
    at: now - 60_000,
  }
  const input = scenario({
    book: {
      account: { totalAssets: 100000, cash: 60000 },
      closed: [],
      executionPlans: [],
      holding: [{
        code: '600001',
        qty: 2,
        buyPrice: 9.5,
        sl: 9,
        buyAt: now - 86400000,
      }],
    },
    reviewEvent: addEvent,
    score: async ([row]) => new Map([[row.code, {
      ...plan.opportunityScore,
      expectedNetR: row.dimensions.route === 'IMMEDIATE' ? 0.6 : 0.1,
    }]]),
  })
  const result = await evaluateDecision(input)

  assert.equal(result.result.decisionPlan.action, 'ADD')
  assert.equal(result.result.decisionPlan.actionability, 'READY')
  assert.ok(result.result.decisionPlan.quantity.lots > 0)
  assert.equal(result.result.addPrice, 10)
  assert.equal(
    result.result.decisionRationale.entryInstruction.intent,
    'ADD_POSITION',
  )
  assert.equal(
    result.result.decisionRationale.entryInstruction.state,
    'READY',
  )
  assert.equal(
    result.result.decisionRationale.entryInstruction.price.executablePrice,
    10,
  )
  assert.equal(
    result.result.decisionRationale.entryInstruction.quantity.plannedLots,
    result.result.decisionPlan.quantity.lots,
  )
  assert.equal(result.result.reviewDecision.terminal, true)
  assert.equal(
    result.result.reviewDecision.quantity,
    result.result.decisionPlan.quantity.lots,
  )

  const blocked = await evaluateDecision({
    ...input,
    book: {
      ...input.book,
      account: { totalAssets: 100000, cash: 0 },
    },
  })
  assert.notEqual(blocked.result.decisionPlan.action, 'ADD')
  assert.equal(blocked.result.decisionPlan.quantity.lots, 0)
  assert.equal(
    blocked.result.decisionRationale.entryInstruction.state,
    'NO_TRADE',
  )
  assert.equal(blocked.result.reviewDecision.quantity, 0)
})

test('单股直接评估使用训练集已有的探索召回语义', async () => {
  const inputs = []
  await evaluateDecision(scenario({
    score: async (values) => {
      inputs.push(...values)
      return new Map(values.map((input) => [input.code, {
        ...plan.opportunityScore,
        usagePolicy: 'DIRECT',
        code: input.code,
        formulaId: input.formulaId,
      }]))
    },
  }))

  assert.ok(inputs.length > 0)
  assert.ok(inputs.every(
    (input) =>
      input.dimensions.recallSource === 'EXPLORATION'
      && input.factors.recall_EXPLORATION === 1
      && input.factors.recall_UNKNOWN === 0,
  ))
})

test('决策结果固化本次使用的技术、五日资金和板块证据', async () => {
  const result = await evaluateDecision(scenario({
    trends: Array.from({ length: 6 }, (_, index) => ({
      time: `10:${String(index).padStart(2, '0')}`,
      price: 9.9 + index * 0.02,
      avg: 9.88 + index * 0.02,
    })),
    fund: {
      asOfDate: '2026-09-10',
      mainNetYi: 1.2,
      retailNetYi: -0.5,
      mainTrend5: [0.2, 0.4, 0.6, 0.8, 1.2],
      retailTrend5: [-0.1, -0.2, -0.3, -0.4, -0.5],
      historyDayCount: 5,
      historyComplete: true,
    },
    sector: {
      matched: true,
      sector: {
        code: 'BK1000',
        name: '测试板块',
        phase: 'ACCUMULATION',
        actionability: 'LAYOUT',
        rank: 2,
        mainNetYi: 3.1,
        breadthPct: 65,
      },
    },
  }))

  const evidence = result.result.decisionEvidence
  assert.equal(evidence.schemaVersion, 'decision-evidence.v1')
  assert.equal(evidence.availability.completeFundHistory, true)
  assert.equal(evidence.availability.sectorContext, true)
  assert.equal(evidence.availability.intradayTechnical, true)
  assert.deepEqual(evidence.funds.mainTrend5, [0.2, 0.4, 0.6, 0.8, 1.2])
  assert.equal(evidence.funds.mainStreak5, 5)
  assert.equal(evidence.sector.name, '测试板块')
  assert.equal(evidence.knownGaps.length, 0)
})

test('触发后路径特征只在复核事件中生成', async () => {
  const trends = {
    preClose: 9.8,
    trends: [
      { time: '10:09', price: 9.98, avg: 10, volume: 100 },
      { time: '10:10', price: 10, avg: 10, volume: 120 },
      { time: '10:11', price: 10.08, avg: 10.01, volume: 180 },
      { time: '10:12', price: 10.12, avg: 10.03, volume: 200 },
    ],
  }
  const initial = await evaluateDecision(scenario({ trends }))
  const review = await evaluateDecision(scenario({
    trends,
    reviewEvent: {
      kind: 'price-review',
      at: now,
      threshold: 10,
      direction: 'gte',
      plannedAction: 'BUY',
    },
  }))

  assert.equal(initial.meta.reviewScoreInput, null)
  assert.equal(
    review.meta.reviewScoreInput.schemaVersion,
    'opportunity-review-feature.v1',
  )
  assert.equal(
    review.meta.reviewScoreInput.factors.direction_BREAKOUT,
    1,
  )
})

test('预留买入现金、单票预留和模型尾损均约束决策手数', async () => {
  const input = scenario()
  const normal = await evaluateDecision(input)
  const pending = await evaluateDecision({
    ...input, book: { ...input.book, executionPlans: [{
      code: '600001', side: 'BUY', status: 'USER_CONFIRMED',
      reservedCash: 99500, targetLots: 99, remainingLots: 99,
      referencePrice: 10, stopPrice: 9.8,
    }] },
  })
  assert.equal(pending.result.decisionPlan.quantity.lots, 0)
  assert.notEqual(pending.result.decisionPlan.actionability, 'READY')
  const stressed = await evaluateDecision({ ...input,
    score: async ([row]) => new Map([[row.code, { ...plan.opportunityScore,
      expectedNetR: row.dimensions.route === 'IMMEDIATE' ? 0.8 : 0.1,
      expectedShortfall10: -20,
    }]]),
  })
  assert.ok(stressed.result.decisionPlan.quantity.lots < normal.result.decisionPlan.quantity.lots)
})

test('过时报价和缺失资金不产生买入指令', async () => {
  const stale = await evaluateDecision(scenario({
    quotes: [{ code: '600001', price: 10, isLivePrice: true, tradeDate: '2026-09-09' }],
  }))
  assert.equal(stale.result.decisionPlan.quantity.lots, 0)
  const missing = await evaluateDecision(scenario({ fund: null }))
  assert.equal(missing.result.decisionSource.state, 'EVIDENCE_INCOMPLETE')
  assert.equal(missing.result.decisionPlan.quantity.lots, 0)
  assert.ok(missing.result.decisionSource.missingEvidence.includes('主力与小单资金'))
})

test('模型缺失及资金故障不能阻断持仓硬止损', async () => {
  const result = await evaluateDecision(scenario({
    book: { account: { cash: 80000 }, closed: [],
      holding: [{ code: '600001', qty: 2, buyPrice: 10, sl: 10.1, buyAt: now - 86400000 }],
    },
    fund: null, market: null, score: async () => new Map(),
  }))
  assert.equal(result.result.decisionPlan.action, 'EXIT')
  assert.equal(result.result.decisionPlan.quantity.lots, 2)
  assert.equal(result.result.decisionPlan.actionability, 'READY')
  assert.equal(result.meta.llmCalls, 0)
})

test('其他持仓风险不完整不阻断负期望仓位退出', async () => {
  const result = await evaluateDecision(scenario({
    book: { account: { cash: 80000 }, closed: [], holding: [
      { code: '600001', qty: 2, buyPrice: 10, sl: 9, buyAt: now - 86400000 },
      { code: '600002', qty: 1, buyPrice: 10, buyAt: now - 86400000 },
    ] },
    score: async ([input]) => new Map([[input.code, { ...plan.opportunityScore, expectedNetR: -0.2 }]]),
  }))
  assert.equal(result.result.decisionSource.state, 'READY')
  assert.equal(result.result.decisionPlan.action, 'EXIT')
  assert.equal(result.result.decisionPlan.quantity.lots, 2)
  assert.equal(result.result.decisionPlan.actionability, 'CONDITIONAL')
  assert.equal(result.result.decisionSource.hardProtection, false)
})

test('只有真实触及账本止损才允许退出直接进入可执行态', async () => {
  const result = await evaluateDecision(scenario({
    book: { account: { cash: 80000 }, closed: [], holding: [
      { code: '600001', qty: 2, buyPrice: 10, sl: 10.1, buyAt: now - 86400000 },
    ] },
    score: async ([input]) => new Map([[input.code, {
      ...plan.opportunityScore,
      expectedNetR: -0.2,
    }]]),
  }))

  assert.equal(result.result.decisionPlan.action, 'EXIT')
  assert.equal(result.result.decisionPlan.actionability, 'READY')
  assert.equal(result.result.decisionSource.hardProtection, true)
})

test('退出前复核用最新模型结果撤销反弹后的旧清仓或确认新价退出', async () => {
  const holdingBook = {
    account: { cash: 80000 },
    closed: [],
    holding: [{
      code: '600001',
      qty: 1,
      buyPrice: 51.55,
      sl: 48.85,
      buyAt: now - 86400000,
    }],
  }
  const marketData = {
    detail: {
      candles: Array.from({ length: 30 }, () => ({
        close: 53,
        high: 54,
        low: 52,
      })),
    },
    trends: Array.from({ length: 12 }, (_, index) => ({
      time: `10:${String(index).padStart(2, '0')}`,
      price: 53 + index * 0.08,
      avgPrice: 53 + index * 0.04,
      volume: 1000 + index * 100,
    })),
  }
  const initial = await evaluateDecision(scenario({
    ...marketData,
    book: holdingBook,
    quotes: [{
      code: '600001',
      price: 53.47,
      isLivePrice: true,
      tradeDate: '2026-09-10',
    }],
    score: async ([input]) => new Map([[input.code, {
      ...plan.opportunityScore,
      expectedNetR: -0.2,
    }]]),
  }))
  assert.equal(initial.result.decisionPlan.action, 'EXIT')
  assert.equal(initial.result.decisionPlan.actionability, 'CONDITIONAL')

  const rebound = await evaluateDecision(scenario({
    ...marketData,
    book: holdingBook,
    quotes: [{
      code: '600001',
      price: 53.9,
      isLivePrice: true,
      tradeDate: '2026-09-10',
    }],
    reviewEvent: {
      kind: 'price-review',
      price: 53.9,
    },
    score: async ([input]) => new Map([[input.code, {
      ...plan.opportunityScore,
      expectedNetR: 0.18,
    }]]),
  }))
  assert.equal(rebound.result.decisionPlan.action, 'HOLD')
  assert.equal(rebound.result.action, '持有')
  assert.equal(rebound.result.reviewDecision.terminal, true)
  assert.equal(rebound.meta.llmCalls, 0)

  const confirmedExit = await evaluateDecision(scenario({
    ...marketData,
    book: holdingBook,
    quotes: [{
      code: '600001',
      price: 53.9,
      isLivePrice: true,
      tradeDate: '2026-09-10',
    }],
    reviewEvent: {
      kind: 'price-review',
      price: 53.9,
    },
    score: async ([input]) => new Map([[input.code, {
      ...plan.opportunityScore,
      expectedNetR: -0.2,
    }]]),
  }))
  assert.equal(confirmedExit.result.decisionPlan.action, 'EXIT')
  assert.equal(confirmedExit.result.decisionPlan.actionability, 'READY')
  assert.equal(confirmedExit.result.decisionPlan.prices.reference, 53.9)
})

test('模型换版期间不得混用三条路径的模型概率', () => {
  const result = buildDecisionAction({ payload, plans: [plan, {
    ...plan, route: 'PULLBACK',
    opportunityScore: { ...plan.opportunityScore, modelVersion: 'different-model' },
  }] })
  assert.equal(result.selectedDecisionPlan, null)
  assert.equal(result.planQty, 0)
})

test('到价复核终态采用账户核定后的动作而不是核定前买入', async () => {
  const input = scenario()
  const result = await evaluateDecision({ ...input, reviewEvent: { kind: 'price_event' },
    book: { ...input.book, account: { cash: 0 } },
  })
  const advice = result.result
  assert.notEqual(advice.decisionPlan.action, 'BUY')
  assert.equal(advice.reviewDecision.quantity, 0)
  assert.equal(advice.reviewDecision.outcome, advice.action)
  assert.equal(advice.reviewDecision.operation, advice.actionPlan)
  assert.equal(advice.pullbackWatchPrice, null)
  assert.equal(advice.breakoutWatchPrice, null)
})

test('单股入口和任务worker的决策主链不调用LLM', () => {
  const service = readFileSync(new URL('../api/_decision_orchestrator.js', import.meta.url), 'utf8')
  assert.doesNotMatch(service, /callChat|_llm|ensureConfig/)
  const source = readFileSync(new URL('../api/ai.js', import.meta.url), 'utf8')
  const api = source.slice(source.indexOf('export default async function handler'))
  assert.ok(api.indexOf('return finishDecision(await runDecision') < api.indexOf('ensureConfig()'))
  const cron = readFileSync(new URL('../api/cron_advice.js', import.meta.url), 'utf8')
  const worker = cron.slice(cron.indexOf('async function runJobGen('), cron.indexOf('export function mergeExternalJobs'))
  assert.match(worker, /await runDecision/)
  assert.doesNotMatch(worker, /genOne\(|callChat/)
})

test('可执行提醒无需LLM二次裁决且过期或换版即失效', async () => {
  const result = await evaluateDecision(scenario())
  const data = { holding: [], plan: [{ code: '600001' }], alerts: [], settings: {} }
  projectAdviceAlerts(data, '600001', result.result, { now, requirePriceContract: true })
  assert.equal(data.alerts.length, 1)
  const alert = data.alerts[0]
  assert.equal(alert.decisionEngine, 'MULTI_TASK')
  assert.equal(alert.phase, null)
  assert.ok(decisionActionAlertMessage(alert, { price: 10 }))
  assert.equal(decisionActionAlertMessage(alert, { price: 8 }), null)
  assert.equal(isCurrentDecisionAlert(alert, result.result, now), true)
  assert.equal(isCurrentDecisionAlert(alert, result.result, now + 86400000), false)
  assert.equal(isCurrentDecisionAlert(alert, { decisionSource: { engine: 'MULTI_TASK' },
    decisionPlan: { decisionId: 'changed' } }, now), false)
  assert.equal(isCurrentDecisionAlert({ candCode: '600001' }, {}, now), false)
  assert.equal(isCurrentDecisionAlert({ code: '600001', type: 'price' }, {}, now), true)
})

test('模型未就绪时不把缺失的模型价位回写并清空账本止损', async () => {
  const { planStore, advicePlan } = await import('../src/planStore.js')
  const { saveAdvice } = await import('../src/adviceCache.js')
  const result = await evaluateDecision(scenario({
    book: { account: { cash: 80000 }, closed: [],
      holding: [{ code: '600001', qty: 2, buyPrice: 10, sl: 9, buyAt: now - 86400000 }],
    },
    score: async () => new Map(),
  }))
  planStore.setData({ plan: [], holding: [{
    code: '600001', qty: 2, buyPrice: 10, sl: 9,
  }], closed: [], account: { cash: 80000 } })
  saveAdvice('600001', { mode: result.mode, advice: result.result })
  assert.equal(advicePlan('600001'), null)
  assert.equal(planStore.get().holding[0].sl, 9)
})
