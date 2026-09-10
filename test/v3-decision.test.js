import test from 'node:test'
import assert from 'node:assert/strict'
import { buildV3Action } from '../shared/adaptiveAdvicePolicy.js'
import { evaluateV3Decision } from '../api/_v3_decision.js'
import { adviceCompleteness } from '../shared/adviceBatchPolicy.js'
import { readFileSync } from 'node:fs'
import { buildAdviceCacheEntry } from '../shared/adviceContinuity.js'
import { projectAdviceAlerts, isCurrentDecisionAlert, v3ActionAlertMessage } from '../shared/adviceAlerts.js'

const payload = { todayQuote: { price: 10, live: true }, holdQty: 0 }
const plan = {
  route: 'IMMEDIATE',
  entryPlan: { price: 10 },
  exitPlan: { hardStopPrice: 9, takeProfitPrice: 12 },
  opportunityScore: {
    state: 'READY', serverVerified: true, productionEligible: true,
    shadowOnly: false, pFill: 0.8, pWinGivenFill: 0.6,
    expectedNetR: 0.3, netRLowerBound: -0.8, expectedShortfall10: -1.2,
    modelVersion: 'test-v3',
  },
}

test('V3选定动作不接受LLM手数或结论', () => {
  const first = buildV3Action({ payload, plans: [plan], now: 1 })
  const second = buildV3Action({
    payload: { ...payload, previousAdvice: { action: '清仓', planQty: 99 } },
    plans: [plan], now: 1,
  })
  assert.deepEqual(first, second)
  assert.equal(first.action, '立即买入')
  assert.equal(first.planQty, 0)
  assert.equal(first.decisionSource.explanationRequired, false)
})

test('直接使用模式不要求模型通过晋级', () => {
  const result = buildV3Action({
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
  const result = buildV3Action({
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
  const locked = buildV3Action({ payload: { ...holding, sellableTodayQty: 0 } })
  const sellable = buildV3Action({ payload: { ...holding, sellableTodayQty: 1 } })
  assert.equal(locked.action, '持有')
  assert.match(locked.actionPlan, /T\+1/)
  assert.equal(sellable.action, '减仓')
  assert.equal(sellable.opQty, '减仓1手')
  assert.equal(sellable.decisionSource.state, 'MODEL_ERROR')
})

test('V3使用剩余价格路径价值管理持仓而不调用旧加权公式', () => {
  const held = { ...payload, holdQty: 2, sellableTodayQty: 2, holdingStopPrice: 9 }
  const positive = buildV3Action({ payload: held, plans: [plan] })
  const negative = buildV3Action({
    payload: held,
    plans: [{ ...plan, opportunityScore: { ...plan.opportunityScore, expectedNetR: -0.2 } }],
  })
  assert.equal(positive.action, '持有')
  assert.equal(negative.action, '清仓')
  assert.equal(negative.adaptiveAction.economics.source, 'V3_PATH_MODEL')
})

test('完整V3评估在模型未就绪时独立返回明确状态与零LLM调用', async () => {
  let calls = 0
  const result = await evaluateV3Decision({
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
  assert.match(result.result.actionPlan, /V3模型调用失败/)
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

test('V3完整编译保留同一路径价格与概率，保存恢复不依赖LLM', async () => {
  const result = await evaluateV3Decision(scenario())
  const decision = result.result.decisionPlan
  assert.equal(decision.action, 'BUY')
  assert.equal(decision.actionability, 'READY')
  assert.ok(decision.quantity.lots > 0)
  assert.equal(decision.risk.tradeExpectancy.source, 'OPPORTUNITY_MODEL')
  assert.equal(decision.prices.reference, result.result.selectedV3Plan.entryPlan.price)
  const entry = buildAdviceCacheEntry(null, { mode: result.mode, advice: result.result }, now)
  const restored = JSON.parse(JSON.stringify(entry))
  assert.deepEqual(restored.advice.decisionPlan, decision)
  assert.equal(adviceCompleteness(restored.advice, result.mode).complete, true)
})

test('单股直接评估使用训练集已有的探索召回语义', async () => {
  const inputs = []
  await evaluateV3Decision(scenario({
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

test('V3结果固化本次使用的技术、五日资金和板块证据', async () => {
  const result = await evaluateV3Decision(scenario({
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
  assert.equal(evidence.schemaVersion, 'v3-decision-evidence.v1')
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
  const initial = await evaluateV3Decision(scenario({ trends }))
  const review = await evaluateV3Decision(scenario({
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

test('预留买入现金、单票预留和模型尾损均约束V3手数', async () => {
  const input = scenario()
  const normal = await evaluateV3Decision(input)
  const pending = await evaluateV3Decision({
    ...input, book: { ...input.book, executionPlans: [{
      code: '600001', side: 'BUY', status: 'USER_CONFIRMED',
      reservedCash: 99500, targetLots: 99, remainingLots: 99,
      referencePrice: 10, stopPrice: 9.8,
    }] },
  })
  assert.equal(pending.result.decisionPlan.quantity.lots, 0)
  assert.notEqual(pending.result.decisionPlan.actionability, 'READY')
  const stressed = await evaluateV3Decision({ ...input,
    score: async ([row]) => new Map([[row.code, { ...plan.opportunityScore,
      expectedNetR: row.dimensions.route === 'IMMEDIATE' ? 0.8 : 0.1,
      expectedShortfall10: -20,
    }]]),
  })
  assert.ok(stressed.result.decisionPlan.quantity.lots < normal.result.decisionPlan.quantity.lots)
})

test('过时报价和缺失资金不产生V3买入指令', async () => {
  const stale = await evaluateV3Decision(scenario({
    quotes: [{ code: '600001', price: 10, isLivePrice: true, tradeDate: '2026-09-09' }],
  }))
  assert.equal(stale.result.decisionPlan.quantity.lots, 0)
  const missing = await evaluateV3Decision(scenario({ fund: null }))
  assert.equal(missing.result.decisionSource.state, 'EVIDENCE_INCOMPLETE')
  assert.equal(missing.result.decisionPlan.quantity.lots, 0)
  assert.ok(missing.result.decisionSource.missingEvidence.includes('主力与小单资金'))
})

test('模型缺失及资金故障不能阻断持仓硬止损', async () => {
  const result = await evaluateV3Decision(scenario({
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

test('其他持仓风险不完整不阻断V3负期望仓位退出', async () => {
  const result = await evaluateV3Decision(scenario({
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

test('只有真实触及账本止损才允许V3退出直接进入可执行态', async () => {
  const result = await evaluateV3Decision(scenario({
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

test('退出前复核用最新V3结果撤销反弹后的旧清仓或确认新价退出', async () => {
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
  const initial = await evaluateV3Decision(scenario({
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

  const rebound = await evaluateV3Decision(scenario({
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

  const confirmedExit = await evaluateV3Decision(scenario({
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

test('V3换版期间不得混用三条路径的模型概率', () => {
  const result = buildV3Action({ payload, plans: [plan, {
    ...plan, route: 'PULLBACK',
    opportunityScore: { ...plan.opportunityScore, modelVersion: 'different-v3' },
  }] })
  assert.equal(result.selectedV3Plan, null)
  assert.equal(result.planQty, 0)
})

test('到价复核终态采用账户核定后的动作而不是核定前买入', async () => {
  const input = scenario()
  const result = await evaluateV3Decision({ ...input, reviewEvent: { kind: 'price_event' },
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
  const service = readFileSync(new URL('../api/_v3_decision.js', import.meta.url), 'utf8')
  assert.doesNotMatch(service, /callChat|_llm|ensureConfig/)
  const source = readFileSync(new URL('../api/ai.js', import.meta.url), 'utf8')
  const api = source.slice(source.indexOf('export default async function handler'))
  assert.ok(api.indexOf('return finishV3(await runV3Decision') < api.indexOf('ensureConfig()'))
  const cron = readFileSync(new URL('../api/cron_advice.js', import.meta.url), 'utf8')
  const worker = cron.slice(cron.indexOf('async function runJobGen('), cron.indexOf('export function mergeExternalJobs'))
  assert.match(worker, /await runV3Decision/)
  assert.doesNotMatch(worker, /genOne\(|callChat/)
})

test('V3可执行提醒无需LLM二次裁决且过期或换版即失效', async () => {
  const result = await evaluateV3Decision(scenario())
  const data = { holding: [], plan: [{ code: '600001' }], alerts: [], settings: {} }
  projectAdviceAlerts(data, '600001', result.result, { now, requirePriceContract: true })
  assert.equal(data.alerts.length, 1)
  const alert = data.alerts[0]
  assert.equal(alert.decisionEngine, 'V3')
  assert.equal(alert.phase, null)
  assert.ok(v3ActionAlertMessage(alert, { price: 10 }))
  assert.equal(v3ActionAlertMessage(alert, { price: 8 }), null)
  assert.equal(isCurrentDecisionAlert(alert, result.result, now), true)
  assert.equal(isCurrentDecisionAlert(alert, result.result, now + 86400000), false)
  assert.equal(isCurrentDecisionAlert(alert, { decisionSource: { engine: 'V3' },
    decisionPlan: { decisionId: 'changed' } }, now), false)
  assert.equal(isCurrentDecisionAlert({ candCode: '600001' }, {}, now), false)
  assert.equal(isCurrentDecisionAlert({ code: '600001', type: 'price' }, {}, now), true)
})

test('模型未就绪时不把缺失的模型价位回写并清空账本止损', async () => {
  const { planStore, advicePlan } = await import('../src/planStore.js')
  const { saveAdvice } = await import('../src/adviceCache.js')
  const result = await evaluateV3Decision(scenario({
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
