import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import process from 'node:process'

import { evaluateDecision } from '../api/_decision_orchestrator.js'
import {
  fetchDecisionScores,
} from '../api/_action_value_client.js'
import {
  buildRealOutcomeLearning,
} from '../shared/realOutcomeLearning.js'
import {
  computePortfolio,
} from '../shared/portfolioAccounting.js'
import {
  getAllAdvice,
  setAllAdvice,
} from '../src/adviceCache.js'
import {
  planStore,
} from '../src/planStore.js'
import {
  buildContinuousFrame,
  executionFromBar,
  loadContinuousMarketData,
  pricePathOf,
} from './lib/continuous-market-replay.mjs'

const ROOT = process.env.HISTORICAL_MARKET_ROOT
  || `${process.env.HOME}/.stockdb-v6-pattern-work`
const OUTPUT = 'harness-artifacts/continuous-market'
const DATES = [
  '20260824',
  '20260825',
  '20260826',
  '20260827',
  '20260828',
]
const CODES = ['000001', '002594', '600036', '300750', '600519']
const DECISION_SLOTS = new Set(['1000', '1430', '1500'])
const originalDateNow = Date.now
let virtualNow = 0
Date.now = () => virtualNow

await fs.mkdir(OUTPUT, { recursive: true })

const dataset = loadContinuousMarketData({
  root: ROOT,
  dates: DATES,
  codes: CODES,
})

const stock = (code) => {
  const latest = dataset.dailyByCode.get(code)?.findLast(
    (row) => row.date <= DATES.at(-1),
  )
  return {
    code,
    name: latest?.name || code,
  }
}

const emptyBook = {
  fixtureProfile: 'continuous-historical-market.v1',
  fixtureNotice:
    '本地历史行情回放；全部成交为模拟结果，不写云端且不进入真实学习。',
  account: {
    totalAssets: 250_000,
    initialCapital: 250_000,
    cash: 250_000,
    goal: 300_000,
    simulation: true,
  },
  holding: [],
  plan: CODES.map((code, index) => ({
    id: `continuous-plan-${index + 1}`,
    ...stock(code),
    addedAt: 0,
  })),
  closed: [],
  advice: {},
  adviceLog: [],
  decisionLog: [],
  alerts: [],
  reviews: {},
  executionPlans: [],
  executionAttributions: [],
  settings: {
    'advAuto.holdEnabled': false,
    'advAuto.watchEnabled': false,
    aiAutoAlert: false,
  },
}

planStore.setData(emptyBook)
planStore.registerSaver(async () => true)
setAllAdvice({})

const report = {
  schemaVersion: 'continuous-market-acceptance.v1',
  source: 'LOCAL_STOCKDB_HISTORICAL_5M',
  dates: DATES,
  codes: CODES,
  initialCash: emptyBook.account.cash,
  cloudWrites: 0,
  llmCalls: 0,
  modelCalls: 0,
  frames: 0,
  decisions: [],
  orders: [],
  transactions: [],
  checks: [],
  observations: [],
  issues: [],
}

const timeline = []
const pendingOrders = []
const latestAdvice = {}
let lastFrame = null

function event(type, detail = {}) {
  timeline.push({
    at: virtualNow,
    time: new Date(virtualNow).toISOString(),
    type,
    ...detail,
  })
}

function holdingOf(code) {
  return planStore.get().holding.find((item) => item.code === code) || null
}

function beijingDate(timestamp) {
  return new Date(timestamp + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replaceAll('-', '')
}

function queueOrder(order) {
  pendingOrders.push({
    ...order,
    queuedAt: virtualNow,
    earliestFrame: report.frames + 1,
  })
  event('ORDER_QUEUED', order)
}

function recordOrderResult(order, result, frame) {
  const row = {
    id: order.id,
    source: order.source,
    intent: order.intent,
    code: order.code,
    side: order.side,
    lots: order.lots,
    submittedAt: order.queuedAt,
    processedAt: frame.now,
    tradeDate: frame.date,
    slot: frame.slot,
    fillable: result.fillable === true,
    reason: result.reason || null,
    fillPrice: result.fillPrice || null,
    fees: result.fees?.total || null,
    cashFlow: result.cashFlow || null,
  }
  report.orders.push(row)
  event(result.fillable ? 'ORDER_FILLED' : 'ORDER_REJECTED', row)
}

function applyOrder(order, frame) {
  const bar = frame.bars.get(order.code)
  const holding = holdingOf(order.code)
  const execution = executionFromBar({
    side: order.side,
    security: stock(order.code),
    tradeDate: frame.date,
    acquiredDate: holding?.buyAt
      ? beijingDate(holding.buyAt)
      : order.acquiredDate,
    bar,
    lots: order.lots,
  })
  if (!execution.fillable) {
    recordOrderResult(order, execution, frame)
    return
  }
  if (
    order.side === 'BUY'
    && Number(order.maxBuyPrice) > 0
    && execution.fillPrice > Number(order.maxBuyPrice)
  ) {
    recordOrderResult(order, {
      fillable: false,
      reason: 'MAX_BUY_PRICE_EXCEEDED',
    }, frame)
    return
  }
  let result
  if (order.executionPlanId) {
    result = planStore.recordExecutionPlanTrade(
      order.executionPlanId,
      execution.fillPrice,
      order.lots,
      frame.now,
    )
  } else if (order.intent === 'T') {
    result = planStore.addTFlow(
      holding?.id,
      order.side === 'BUY' ? 'buy' : 'sell',
      execution.fillPrice,
      order.lots,
    )
  } else if (order.side === 'BUY') {
    result = holding
      ? planStore.addToHolding(
          holding.id,
          execution.fillPrice,
          order.lots,
          { source: 'historical-simulation' },
        )
      : planStore.get().plan.some((item) => item.code === order.code)
        ? planStore.buy(
            order.code,
            execution.fillPrice,
            order.lots,
            { source: 'historical-simulation' },
          )
        : planStore.buyDirect(
            stock(order.code),
            execution.fillPrice,
            order.lots,
            { source: 'historical-simulation' },
          )
  } else {
    result = planStore.sell(
      holding?.id,
      execution.fillPrice,
      order.lots,
      {
        source: 'historical-simulation',
        tradeIntent: order.intent === 'T' ? 't' : 'position',
      },
    )
  }
  recordOrderResult(order, {
    ...execution,
    fillable: result?.ok === true,
    reason: result?.ok ? null : result?.error || 'LEDGER_REJECTED',
  }, frame)
}

function processPendingOrders(frame) {
  const ready = pendingOrders.filter(
    (order) => order.earliestFrame <= report.frames,
  )
  for (const order of ready) applyOrder(order, frame)
  for (const order of ready) {
    pendingOrders.splice(pendingOrders.indexOf(order), 1)
  }
}

function scheduleManualActions(frame) {
  const key = `${frame.date}:${frame.slot}`
  if (key === '20260824:0935') {
    queueOrder({
      id: 'manual-build-000001',
      source: 'MANUAL_SCENARIO',
      intent: 'POSITION',
      code: '000001',
      side: 'BUY',
      lots: 2,
    })
    queueOrder({
      id: 'manual-build-002594',
      source: 'MANUAL_SCENARIO',
      intent: 'POSITION',
      code: '002594',
      side: 'BUY',
      lots: 1,
    })
  }
  if (key === '20260824:1000') {
    queueOrder({
      id: 'same-day-sell-probe',
      source: 'MANUAL_SCENARIO',
      intent: 'POSITION',
      code: '000001',
      side: 'SELL',
      lots: 1,
    })
  }
  if (key === '20260825:1430') {
    for (const code of ['000001', '002594']) {
      const holding = holdingOf(code)
      if (!holding) continue
      queueOrder({
        id: `manual-exit-${code}`,
        source: 'MANUAL_SCENARIO',
        intent: 'POSITION',
        code,
        side: 'SELL',
        lots: holding.qty,
      })
    }
  }
  if (key === '20260826:0935') {
    queueOrder({
      id: 'manual-build-600036',
      source: 'MANUAL_SCENARIO',
      intent: 'POSITION',
      code: '600036',
      side: 'BUY',
      lots: 3,
    })
  }
  if (key === '20260827:0935') {
    queueOrder({
      id: 'manual-add-600036',
      source: 'MANUAL_SCENARIO',
      intent: 'POSITION',
      code: '600036',
      side: 'BUY',
      lots: 1,
    })
  }
  if (key === '20260827:1000') {
    queueOrder({
      id: 'manual-t-sell-600036',
      source: 'MANUAL_SCENARIO',
      intent: 'T',
      code: '600036',
      side: 'SELL',
      lots: 1,
    })
  }
  if (key === '20260827:1430') {
    queueOrder({
      id: 'manual-t-buy-600036',
      source: 'MANUAL_SCENARIO',
      intent: 'T',
      code: '600036',
      side: 'BUY',
      lots: 1,
    })
  }
  if (key === '20260827:1440') {
    const holding = holdingOf('600036')
    if (holding?.tFlows?.length) {
      planStore.settleTFlows(holding.id)
      event('T_SETTLED', {
        code: '600036',
        flowCount: holding.tFlows.length,
      })
    }
  }
  if (key === '20260828:1430') {
    const holding = holdingOf('600036')
    if (holding) {
      queueOrder({
        id: 'manual-exit-fallback-600036',
        source: 'MANUAL_SCENARIO',
        intent: 'POSITION',
        code: '600036',
        side: 'SELL',
        lots: holding.qty,
      })
    }
  }
}

function causalFund(frame, code) {
  const fund = structuredClone(frame.funds.get(code) || {})
  if (frame.slot === '1500') {
    const completed = (dataset.fundByCode.get(code) || [])
      .filter((row) => row.date <= frame.date)
      .slice(-5)
    const current = completed.at(-1)
    return {
      ...fund,
      source: 'HISTORICAL_SAME_DAY_CLOSE',
      asOfDate: current?.date || null,
      mainNetYi: current?.mainNetYi ?? null,
      retailNetYi: current?.retailNetYi ?? null,
      mainTrend5: completed.map((row) => row.mainNetYi),
      retailTrend5: completed.map((row) => row.retailNetYi),
      historyDayCount: completed.length,
      historyComplete: completed.length === 5,
    }
  }
  const priorMain = fund.mainTrend5?.at(-1)
  const priorRetail = fund.retailTrend5?.at(-1)
  return {
    ...fund,
    source: 'HISTORICAL_PREVIOUS_CLOSE',
    asOfDate: dataset.fundByCode.get(code)
      ?.filter((row) => row.date < frame.date)
      .at(-1)?.date || null,
    mainNetYi: priorMain ?? null,
    retailNetYi: priorRetail ?? null,
  }
}

function decisionRow(advice, frame, code, phase) {
  const plan = advice.decisionPlan || {}
  return {
    at: virtualNow,
    tradeDate: frame.date,
    slot: frame.slot,
    phase,
    code,
    name: frame.quoteMap[code]?.name || code,
    price: frame.quoteMap[code]?.price,
    action: plan.action,
    actionability: plan.actionability,
    lots: plan.quantity?.lots || 0,
    modelVersion: advice.decisionSource?.modelVersion || null,
    usagePolicy: advice.decisionSource?.usagePolicy || null,
    sourceState: advice.decisionSource?.state || null,
    blockedReasons: plan.blockedReasons || [],
    entryInstruction:
      advice.decisionRationale?.entryInstruction || null,
  }
}

async function evaluateAt(frame, code, reviewEvent = null) {
  const result = await evaluateDecision({
    code,
    book: planStore.get(),
    quotes: frame.quotes,
    detail: frame.details.get(code),
    trends: frame.trends.get(code),
    fund: causalFund(frame, code),
    sector: null,
    market: frame.market,
    now: virtualNow,
    reviewEvent,
    score: async (inputs) => {
      report.modelCalls += 1
      return fetchDecisionScores(inputs, { timeoutMs: 8000 })
    },
  })
  assert.equal(result.meta.llmCalls, 0)
  report.llmCalls += result.meta.llmCalls
  const advice = result.result
  latestAdvice[code] = {
    mode: result.mode,
    at: virtualNow,
    cachedAt: virtualNow,
    advice,
  }
  setAllAdvice({
    ...getAllAdvice(),
    [code]: latestAdvice[code],
  })
  planStore.logAdvice({
    code,
    name: frame.quoteMap[code]?.name || code,
    mode: result.mode,
    action: advice.action,
    entryPrice: advice.decisionPlan?.prices?.reference,
    stop: advice.decisionPlan?.prices?.stop,
    target: advice.decisionPlan?.prices?.target,
    priceAtAdvice: frame.quoteMap[code]?.price,
    decisionId: advice.decisionPlan?.decisionId,
  })
  return advice
}

function armReviewedPlan(advice, frame) {
  const draft = advice.executionPlan
  if (!draft?.canArm) return false
  let plan = planStore.armExecutionPlan(
    draft,
    virtualNow,
    frame.quoteMap[draft.code]?.price,
  )
  for (const price of pricePathOf(frame.bars.get(draft.code))) {
    planStore.refreshExecutionPlans({
      [draft.code]: { price },
    }, virtualNow)
    plan = planStore.get().executionPlans.find(
      (item) => item.planId === draft.planId,
    )
    if (plan?.status === 'ALERTED') break
  }
  if (plan?.status !== 'ALERTED') return false
  plan = planStore.confirmExecutionPlan(plan.planId, virtualNow)
  queueOrder({
    id: `system-${plan.planId}`,
    source: 'SYSTEM_DECISION',
    intent: 'POSITION',
    executionPlanId: plan.planId,
    code: plan.code,
    side: plan.side,
    lots: plan.remainingLots,
    maxBuyPrice: plan.maxBuyPrice,
  })
  return true
}

async function runDecisionCycle(frame) {
  if (!DECISION_SLOTS.has(frame.slot)) return
  const heldCodes = planStore.get().holding.map((item) => item.code)
  const watchCodes = frame.slot === '1430'
    ? ['300750', '600519']
    : []
  const codes = [...new Set([...heldCodes, ...watchCodes])]
  for (const code of codes) {
    if (!frame.quoteMap[code]) continue
    const advice = await evaluateAt(frame, code)
    report.decisions.push(decisionRow(advice, frame, code, 'INITIAL'))
    event('DECISION', {
      code,
      action: advice.decisionPlan.action,
      actionability: advice.decisionPlan.actionability,
    })
    const action = advice.decisionPlan.action
    if (
      !['EXIT', 'REDUCE'].includes(action)
      || advice.decisionSource?.exitReviewRequired !== true
    ) continue
    virtualNow = frame.now + 60_000
    const reviewEvent = {
      kind: 'price-review',
      at: frame.now,
      monitoringUntilAt: virtualNow,
      decisionDeadlineAt: virtualNow + 60_000,
      plannedAction: action,
      direction: 'IMMEDIATE',
      directionApproved: true,
      price: frame.quoteMap[code].price,
      threshold: frame.quoteMap[code].price,
      sourceDecisionId: advice.decisionPlan.decisionId,
    }
    const reviewed = await evaluateAt(frame, code, reviewEvent)
    report.decisions.push(
      decisionRow(reviewed, frame, code, 'EXIT_REVIEW'),
    )
    event('EXIT_REVIEW', {
      code,
      action: reviewed.decisionPlan.action,
      actionability: reviewed.decisionPlan.actionability,
    })
    armReviewedPlan(reviewed, frame)
    virtualNow = frame.now
  }
}

try {
  for (const date of DATES) {
    const rows = dataset.minutesByDate.get(date)
    const frameCount = Math.max(
      ...[...rows.values()].map((value) => value.length),
    )
    for (let index = 0; index < frameCount; index += 1) {
      const frame = buildContinuousFrame(dataset, date, index)
      lastFrame = frame
      virtualNow = frame.now
      report.frames += 1
      processPendingOrders(frame)
      scheduleManualActions(frame)
      await runDecisionCycle(frame)
      planStore.refreshExecutionPlans(frame.quoteMap, virtualNow)
      const portfolio = computePortfolio(
        planStore.get().holding,
        frame.quoteMap,
        planStore.get().account,
      )
      if (index === frameCount - 1) {
        event('SESSION_CLOSE', {
          date,
          cash: portfolio.cash,
          totalAssets: portfolio.totalAssets,
          holdingCount: planStore.get().holding.length,
        })
      }
    }
  }
  if (lastFrame) processPendingOrders(lastFrame)
  const finalBook = {
    ...structuredClone(planStore.get()),
    advice: structuredClone(latestAdvice),
  }
  const finalPortfolio = computePortfolio(
    finalBook.holding,
    lastFrame?.quoteMap || {},
    finalBook.account,
  )
  const sameDayProbe = report.orders.find(
    (order) => order.id === 'same-day-sell-probe',
  )
  const buyTransactions = finalBook.closed.filter(
    (item) => item.type === 'BUY',
  )
  const sellTransactions = finalBook.closed.filter(
    (item) => item.type === 'SELL',
  )
  const tTransactions = finalBook.closed.filter(
    (item) => item.type === 'T',
  )
  report.transactions = finalBook.closed
    .map((item) => ({
      id: item.id,
      type: item.type,
      code: item.code,
      name: item.name,
      qty: item.qty,
      price: item.price ?? item.sellPrice ?? item.buyPrice,
      at: item.at ?? item.sellAt ?? item.buyAt,
      fee: item.fee ?? (
        Number(item.buyFee || 0) + Number(item.sellFee || 0)
      ),
      cashFlow: item.cashFlow,
      realizedPnl: item.realizedPnl ?? item.netPnl ?? null,
    }))
    .sort((left, right) => left.at - right.at)
  report.final = {
    cash: finalPortfolio.cash,
    totalAssets: finalPortfolio.totalAssets,
    totalPnl: finalPortfolio.totalPnl,
    totalPnlPct: finalPortfolio.totalPnlPct,
    holdings: finalBook.holding.map((item) => ({
      code: item.code,
      name: item.name,
      qty: item.qty,
      buyPrice: item.buyPrice,
    })),
    transactionCount: report.transactions.length,
    executionPlans: finalBook.executionPlans.length,
    executionAttributions: finalBook.executionAttributions.length,
  }
  report.checks = [
    {
      id: 'continuous-clock',
      passed: report.frames === DATES.length * 48,
      actual: report.frames,
      expected: DATES.length * 48,
    },
    {
      id: 'buy-and-sell-results',
      passed: buyTransactions.length >= 3
        && sellTransactions.length >= 1,
      actual: {
        buys: buyTransactions.length,
        sells: sellTransactions.length,
      },
    },
    {
      id: 't-plus-one',
      passed: sameDayProbe?.reason === 'T_PLUS_ONE_LOCKED',
      actual: sameDayProbe?.reason || null,
    },
    {
      id: 't-cycle',
      passed: tTransactions.length >= 1,
      actual: tTransactions.length,
    },
    {
      id: 'intraday-stale-fund-fails-closed',
      passed: report.decisions
        .filter((item) => item.slot !== '1500')
        .every((item) =>
          item.sourceState === 'EVIDENCE_INCOMPLETE'
          && item.modelVersion == null),
      actual: report.decisions
        .filter((item) => item.slot !== '1500')
        .map((item) => ({
          code: item.code,
          slot: item.slot,
          sourceState: item.sourceState,
          modelVersion: item.modelVersion,
        })),
    },
    {
      id: 'same-day-close-fund-enables-model',
      passed: report.decisions
        .filter((item) => item.slot === '1500')
        .some((item) => item.modelVersion),
      actual: report.decisions
        .filter((item) => item.slot === '1500')
        .map((item) => ({
          code: item.code,
          sourceState: item.sourceState,
          modelVersion: item.modelVersion,
        })),
    },
    {
      id: 'final-account-flat',
      passed: finalBook.holding.length === 0,
      actual: finalBook.holding.map((item) => ({
        code: item.code,
        qty: item.qty,
      })),
    },
    {
      id: 'simulation-learning-isolation',
      passed:
        buildRealOutcomeLearning(finalBook).overall.samples === 0,
      actual:
        buildRealOutcomeLearning(finalBook).overall.samples,
    },
    {
      id: 'cloud-write-isolation',
      passed: report.cloudWrites === 0,
      actual: report.cloudWrites,
    },
  ]
  const initialWatchDecisions = report.decisions.filter(
    (item) =>
      item.phase === 'INITIAL'
      && ['300750', '600519'].includes(item.code),
  )
  if (
    initialWatchDecisions.length
    && initialWatchDecisions.every(
      (item) => !['BUY', 'ADD'].includes(item.action),
    )
  ) {
    report.observations.push({
      id: 'no-system-entry-in-window',
      severity: 'OBSERVATION',
      summary:
        '回放窗口内候选股没有出现系统可执行建仓；买入链路只能用人工场景覆盖。',
      evidence: `${initialWatchDecisions.length}次候选评估，BUY/ADD为0`,
    })
  }
  const staleFundAccepted = report.decisions.some(
    (item) =>
      item.slot !== '1500'
      && item.modelVersion,
  )
  if (staleFundAccepted) {
    report.issues.push({
      id: 'historical-fund-freshness-not-enforced',
      severity: 'HIGH',
      summary:
        '决策输入只要存在主力/小单数值就可通过，未校验资金数据日期是否为当前交易日。',
      evidence:
        '回放明确标记资金来源为前一交易日收盘，系统仍调用并采用生产决策模型。',
    })
  }
  const staleSiblingPlan = report.orders.find(
    (item) =>
      item.source === 'SYSTEM_DECISION'
      && item.reason === '执行计划尚未确认或已结束',
  )
  if (staleSiblingPlan) {
    report.issues.push({
      id: 'cross-stock-plan-invalidated-after-first-fill',
      severity: 'MEDIUM',
      summary:
        '同一时点确认的多股执行计划中，第一只股票成交后会使另一只股票计划失效。',
      evidence:
        `${staleSiblingPlan.tradeDate} ${staleSiblingPlan.slot} `
        + `${staleSiblingPlan.code}已确认卖出计划在另一股票先成交后返回“`
        + `${staleSiblingPlan.reason}”，必须等下一轮重新决策。`,
    })
  }
  const partialFailure = report.orders.find(
    (item) =>
      item.source === 'SYSTEM_DECISION'
      && item.fillable === false
      && /仍有\d+手未记录/.test(String(item.reason || '')),
  )
  if (partialFailure) {
    const partiallyRecorded = finalBook.executionPlans.find(
      (plan) =>
        plan.planId === partialFailure.id.replace(/^system-/, '')
        && plan.filledLots > 0
        && plan.filledLots < plan.targetLots,
    )
    if (partiallyRecorded) {
      report.issues.push({
        id: 'partial-fill-mutates-ledger-but-returns-failure',
        severity: 'CRITICAL',
        summary:
          '执行计划部分成交已改变持仓和现金，但接口整体返回失败，调用方会把真实部分成交误判为未成交。',
        evidence:
          `${partialFailure.code}计划${partiallyRecorded.targetLots}手，`
          + `实际先记录${partiallyRecorded.filledLots}手后返回“`
          + `${partialFailure.reason}”。`,
      })
    }
  }
  const incompleteAttributions = finalBook.executionAttributions.filter(
    (item) =>
      item.status === 'COMPLETED'
      && (
        !(Number(item.plannedRiskAmount) > 0)
        || !Number.isFinite(Number(item.plannedExpectedNetR))
        || !Number.isFinite(Number(item.realizedNetR))
      ),
  )
  if (incompleteAttributions.length) {
    report.issues.push({
      id: 'exit-attribution-misses-risk-and-expected-r',
      severity: 'HIGH',
      summary:
        '已完成退出虽有真实费后盈亏，但缺少计划风险和计划期望，无法计算真实R及预测误差。',
      evidence:
        `${incompleteAttributions.length}条已完成系统退出归因中`
        + 'plannedRiskAmount为0或plannedExpectedNetR/realizedNetR为空。',
    })
  }
  report.passed = report.checks.every((item) => item.passed)
  report.finishedAt = virtualNow
  await fs.writeFile(
    `${OUTPUT}/report.json`,
    JSON.stringify(report, null, 2),
  )
  await fs.writeFile(
    `${OUTPUT}/timeline.json`,
    JSON.stringify(timeline, null, 2),
  )
  await fs.writeFile(
    `${OUTPUT}/final-book.json`,
    JSON.stringify(finalBook, null, 2),
  )
  await fs.writeFile(
    `${OUTPUT}/latest-quotes.json`,
    JSON.stringify(lastFrame?.quotes || [], null, 2),
  )
  console.log(JSON.stringify({
    passed: report.passed,
    frames: report.frames,
    decisions: report.decisions.length,
    orders: report.orders.length,
    transactions: report.transactions.length,
    final: report.final,
    issues: report.issues.length,
    observations: report.observations.length,
    cloudWrites: report.cloudWrites,
    llmCalls: report.llmCalls,
  }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  Date.now = originalDateNow
}
