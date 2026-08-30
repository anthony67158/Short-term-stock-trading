import {
  buildUserPrompt,
} from '../../api/_ai_prompts.js'
import {
  judgeConfirmation,
} from '../../api/_confirm.js'
import {
  activatePriceReviewTrigger,
  queueAdviceReviewForVerdict,
} from '../../api/_advice_wakeup.js'
import {
  terminalReviewNotification,
} from '../../api/cron_advice.js'
import {
  buildAdviceReviewMemory,
} from '../../shared/adviceReviewMemory.js'
import {
  projectAdviceAlerts,
} from '../../shared/adviceAlerts.js'
import {
  reconcileAdviceNumbers,
} from '../../shared/adviceValidation.js'
import {
  compileDecisionPlan,
} from '../../shared/decisionPlan.js'
import {
  buildAlertNotification,
} from '../../shared/alertNotification.js'
import {
  t1GateForSide,
} from '../../shared/t1AdvicePolicy.js'
import {
  applyPortfolioRiskPolicy,
} from '../../shared/portfolioRiskPolicy.js'
import {
  buildIntradayOpenSummary,
  buildReviewDecisionPacket,
} from '../../shared/reviewDecisionPacket.js'
import {
  attachShortHorizonSummary,
  buildShortHorizonTactical,
  deriveShortHorizonActionPolicy,
} from '../../shared/shortHorizonTactical.js'
import {
  buildTriggeredReviewFallback,
  enforceTriggeredReviewDecisionPlan,
  normalizeTriggeredReviewDecision,
} from '../../shared/triggeredReviewDecision.js'

const DEFAULT_NOW = Date.parse('2026-08-24T02:10:00.000Z')

function clone(value) {
  return structuredClone(value)
}

function check(
  id,
  dimension,
  passed,
  message,
  options = {},
) {
  return {
    id,
    dimension,
    passed: passed === true,
    message,
    hard: options.hard === true,
    code: options.code,
    details: options.details ?? null,
  }
}

function liveQuote(input = {}, now = DEFAULT_NOW) {
  const date = new Date(now + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
  return {
    price: Number(input.price),
    open: Number(input.open ?? input.price),
    high: Number(input.high ?? input.price),
    low: Number(input.low ?? input.price),
    pct: Number(input.pct) || 0,
    turnover: Number(input.turnover) || 3,
    volRatio: Number(input.volRatio) || 1,
    amount: Number(input.amount) || 200_000_000,
    limitDownPrice: Number(
      input.limitDownPrice
      ?? Number(input.price) * 0.9,
    ),
    limitUpPrice: Number(
      input.limitUpPrice
      ?? Number(input.price) * 1.1,
    ),
    tradeDate: input.tradeDate || date,
    asOf: new Date(now).toISOString(),
    asOfLabel: input.tradeDate || date,
    live: true,
    isLivePrice: true,
    priceStatus: 'LIVE',
    phase: '上午盘中',
  }
}

function baseAdvisorPayload(input = {}, now = DEFAULT_NOW) {
  const source = input.advisorPayload || {}
  const quote = liveQuote(source.todayQuote || {}, now)
  const position = input.position || {}
  return {
    code: input.security?.code || '',
    name: input.security?.name || '',
    marketEnv: {
      schemaVersion: 'market-regime.v1',
      regime: 'TREND_STRONG',
      label: '强势趋势',
      score: 72,
      dataQuality: 'COMPLETE',
      allowRiskIncrease: true,
      hardRiskOff: false,
      riskMultiplier: 1,
      targetPositionPct: { min: 30, max: 60 },
      ...(source.marketEnv || {}),
    },
    sectorOpportunity: {
      matched: true,
      sector: {
        name: '虚构测试板块',
        actionability: '可买',
      },
      stock: {
        roleLabel: '前排',
        score: 66,
      },
      ...(source.sectorOpportunity || {}),
    },
    tech: {
      support: +(quote.price * 0.97).toFixed(3),
      resistance: +(quote.price * 1.03).toFixed(3),
      atr: +(quote.price * 0.025).toFixed(3),
      ma: {
        ma5: +(quote.price * 0.99).toFixed(3),
      },
      ...(source.tech || {}),
    },
    stockFund: {
      source: 'fake-realtime',
      fetchedAt: now,
      mainNetYi: 0.3,
      retailNetYi: -0.15,
      ...(source.stockFund || {}),
    },
    account: {
      cash: 50_000,
      totalAssets: 100_000,
      position: 20,
      stockWeight: Number(position.stockWeight) || 0,
      cashReservePct: 50,
      ...(source.account || {}),
    },
    quant: {
      score: 62,
      forecast: {
        direction: '看涨',
        upProb: 58,
        expRet: 1.8,
      },
      highConfSignal: {
        fired: false,
      },
      ...(source.quant || {}),
    },
    holdQty: Number(position.liveQty) || 0,
    holdCost: Number(position.cost) || null,
    sellableTodayQty:
      Number(position.sellableToday) || 0,
    boughtTodayQty:
      Number(position.boughtToday) || 0,
    ...clone(source),
    todayQuote: quote,
  }
}

function evidenceSnapshot(code, now) {
  return {
    schemaVersion: 'canonical-evidence.v1',
    snapshotId: `ev.fake.${code}`,
    asOf: new Date(now).toISOString(),
    marketTime: {
      phase: '上午盘中',
      isLive: true,
      evidenceState: 'LIVE',
      dataDayLabel: new Date(now + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
    },
    freshness: {
      status: 'LIVE',
      missingSources: [],
      missingRequiredSources: [],
    },
  }
}

function intradayView(summary) {
  if (!summary) return null
  const vsVwap = {
    ABOVE: '现价在均价线上方(日内偏强)',
    BELOW: '现价在均价线下方(日内偏弱)',
    AROUND: '现价围绕均价线',
  }[summary.priceVsVwap] || '均价线位置未知'
  return {
    now: summary.currentPrice,
    vwap: summary.vwap,
    dayHigh: summary.dayHigh,
    dayLow: summary.dayLow,
    vsVwap,
    posInDay: summary.positionInRangePct,
    rhythm: summary.directionFromOpen,
    atDayLow: summary.positionInRangePct <= 10,
    atDayHigh: summary.positionInRangePct >= 90,
  }
}

function preparePayload({
  base = {},
  quote,
  funds,
  trends,
  reviewEvent = null,
  previousAdvice = null,
  now,
  mode,
} = {}) {
  const payload = clone(base)
  payload.todayQuote = liveQuote(
    quote || payload.todayQuote,
    now,
  )
  if (funds) payload.stockFund = clone(funds)
  if (Array.isArray(trends) && trends.length) {
    payload.intradayOpenSummary = buildIntradayOpenSummary(
      trends,
      {
        preClose: quote?.preClose,
        observedAt: now,
      },
    )
    payload.intraday = intradayView(
      payload.intradayOpenSummary,
    )
  }
  if (reviewEvent) payload.reviewEvent = clone(reviewEvent)
  if (previousAdvice) payload.previousAdvice = clone(previousAdvice)
  const tactical = buildShortHorizonTactical(payload, { now })
  payload.shortHorizonTactical = {
    ...tactical,
    actionPolicy: deriveShortHorizonActionPolicy({
      mode,
      tactical,
      reviewEvent: payload.reviewEvent,
    }),
  }
  if (reviewEvent) {
    payload.reviewDecisionPacket = buildReviewDecisionPacket({
      channel: 'FAST_REVIEW',
      code: payload.code,
      name: payload.name,
      priorAdvice: previousAdvice || {},
      event: reviewEvent,
      current: {
        quote: payload.todayQuote,
        funds: payload.stockFund,
        intradayFromOpen: payload.intradayOpenSummary,
        technical: payload.tech,
        tactical: payload.shortHorizonTactical,
        position: {
          liveQty: Number(payload.holdQty) || 0,
          sellableToday:
            Number(payload.sellableTodayQty) || 0,
          boughtToday:
            Number(payload.boughtTodayQty) || 0,
        },
        account: payload.account,
      },
      now,
    })
  }
  return payload
}

function finalizeModelOutput({
  mode,
  payload,
  modelOutput,
  triggered,
  now,
}) {
  let result = clone(modelOutput || {})
  if (triggered) {
    result = normalizeTriggeredReviewDecision({
      mode,
      result,
      payload,
      now,
    })
  }
  const reconciled = reconcileAdviceNumbers({
    mode,
    result,
    payload,
  })
  result = reconciled.result
  if (['buy_advice', 'hold_advice'].includes(mode)) {
    result = applyPortfolioRiskPolicy({
      mode,
      result,
      payload,
    }).result
  }
  result = attachShortHorizonSummary(
    result,
    payload.shortHorizonTactical,
  )
  result.reviewMemory = buildAdviceReviewMemory({
    advice: result,
    payload,
    source: triggered ? 'FAST_REVIEW' : 'ADVISOR',
    now,
  })
  result.decisionPlan = compileDecisionPlan({
    mode,
    advice: result,
    payload,
    evidenceSnapshot: evidenceSnapshot(payload.code, now),
    now,
  })
  const preAlignment = {
    action: result.decisionPlan.action,
    actionability: result.decisionPlan.actionability,
    blockedReasons: result.decisionPlan.blockedReasons || [],
  }
  if (triggered) {
    const aligned = enforceTriggeredReviewDecisionPlan({
      mode,
      result,
    })
    result = aligned.result
    if (aligned.changed) {
      result.decisionPlan = compileDecisionPlan({
        mode,
        advice: result,
        payload,
        evidenceSnapshot: evidenceSnapshot(payload.code, now),
        now,
      })
    }
  }
  result.priceContract = result.decisionPlan.priceContract
  result.continuity = {
    planId: `plan.fake.${payload.code}`,
    revision: triggered ? 2 : 1,
    thesisVersion: 1,
  }
  return {
    result,
    issues: reconciled.issues,
    preAlignment,
  }
}

function accountData(input = {}) {
  const security = input.security || {}
  const position = input.position || {}
  const owned = Number(position.liveQty) > 0
  return {
    account: clone(input.advisorPayload?.account || {}),
    plan: owned
      ? []
      : [{ code: security.code, name: security.name }],
    holding: owned
      ? [{
          id: `holding.fake.${security.code}`,
          code: security.code,
          name: security.name,
          qty: Number(position.liveQty),
          cost: Number(position.cost),
          buyAt: Number(position.buyAt) || 0,
        }]
      : [],
    closed: [],
    alerts: [],
    advice: {},
    settings: {
      aiAutoAlert: true,
    },
  }
}

function alertKind(alert) {
  if (!alert) return 'NONE'
  if (alert.reviewOnly) return 'REVIEW_ONLY'
  if (alert.actKind === 'add') return 'ADD'
  if (alert.actKind === 'reduce') return 'REDUCE'
  if (alert.candCode) return 'BUY'
  return 'OTHER'
}

function selectedAlert(alerts, trigger = {}) {
  const expectedKind = String(trigger.alertKind || '')
  const reviewKey = String(trigger.reviewKey || '')
  return alerts.find((alert) =>
    (!expectedKind || alertKind(alert) === expectedKind)
    && (!reviewKey || alert.reviewKey === reviewKey)
  ) || null
}

function judgeOutcome(alert, decision) {
  if (decision === 'confirm') {
    if (alert?.actKind === 'reduce') return '立即减仓'
    if (alert?.actKind === 'add') return '立即加仓'
    return '立即买入'
  }
  if (decision === 'invalid') {
    return alert?.candCode ? '放弃买入' : '放弃本次操作'
  }
  return alert?.candCode ? '维持观望' : '维持持有'
}

function traceStep(trace, name, details = {}) {
  trace.push({
    step: trace.length + 1,
    name,
    ...details,
  })
}

async function runFastReview({
  input,
  data,
  initialAdvice,
  initialPayload,
  alert,
  calls,
  trace,
  now,
}) {
  const triggerQuote = liveQuote(input.trigger.quote, now)
  const activation = activatePriceReviewTrigger(
    data,
    {
      alertId: alert?.id,
      code: input.security.code,
      quote: triggerQuote,
    },
    now,
  )
  traceStep(trace, 'activate-price-review', {
    activated: activation.ok === true,
    created: activation.created === true,
  })
  let duplicate = null
  if (input.trigger.replay === true) {
    duplicate = activatePriceReviewTrigger(
      data,
      {
        alertId: alert?.id,
        code: input.security.code,
        quote: triggerQuote,
      },
      now + 1,
    )
    traceStep(trace, 'replay-price-review', {
      created: duplicate.created === true,
      already: duplicate.already === true,
    })
  }
  if (!activation.ok || !activation.job?.trigger) {
    return { activation, duplicate, result: null }
  }
  const review = input.review || {}
  const reviewPayload = preparePayload({
    base: initialPayload,
    quote: review.quote || input.trigger.quote,
    funds: review.funds,
    trends: review.trends,
    reviewEvent: activation.job.trigger,
    previousAdvice: initialAdvice,
    now: now + 1000,
    mode: input.mode,
  })
  const prompt = buildUserPrompt(
    input.mode,
    reviewPayload,
  )
  traceStep(trace, 'build-fast-review-packet', {
    schemaVersion:
      reviewPayload.reviewDecisionPacket?.schemaVersion,
    promptLength: prompt.length,
  })
  let finalized
  if (review.modelFailure === true) {
    calls.review += 1
    finalized = {
      result: buildTriggeredReviewFallback({
        mode: input.mode,
        previousAdvice: initialAdvice,
        payload: reviewPayload,
        reason: '测试注入：复核模型超时',
        now: now + 45_000,
      }),
      issues: ['测试注入：复核模型超时'],
    }
    traceStep(trace, 'fast-review-fallback', {
      llmCalled: true,
      timedOut: true,
    })
  } else {
    calls.review += 1
    traceStep(trace, 'review-llm-stub', {
      calls: calls.review,
    })
    finalized = finalizeModelOutput({
      mode: input.mode,
      payload: reviewPayload,
      modelOutput: review.modelOutput,
      triggered: true,
      now: now + 45_000,
    })
  }
  const notification = terminalReviewNotification({
    code: input.security.code,
    name: input.security.name,
    advice: finalized.result,
    jobId: activation.job.id,
  })
  projectAdviceAlerts(
    data,
    input.security.code,
    finalized.result,
    {
      now: now + 45_000,
      idFactory: () => `post-review.${input.security.code}`,
      requirePriceContract: true,
      t1Status: input.position,
    },
  )
  traceStep(trace, 'publish-fast-review', {
    outcome: finalized.result.reviewDecision?.outcome,
    remainingAlerts: data.alerts.length,
  })
  return {
    activation,
    duplicate,
    payload: reviewPayload,
    promptLength: prompt.length,
    result: finalized.result,
    issues: finalized.issues,
    preAlignment: finalized.preAlignment,
    notification,
  }
}

async function runJudge({
  input,
  data,
  initialAdvice,
  alert,
  calls,
  trace,
  now,
}) {
  const judge = input.judge || {}
  const quote = liveQuote(judge.quote || input.trigger.quote, now)
  let packetLength = 0
  const side = alert?.actKind === 'reduce'
    ? 'sell'
    : alert?.actKind === 'add'
      ? 'buy'
      : 'buy'
  const t1Gate = t1GateForSide(
    side,
    input.position,
    '2026-08-25',
  )
  const result = t1Gate.blocked
    ? {
        decision: 'wait',
        confidence: 100,
        reason: t1Gate.reason,
        side,
        source: 't1',
        policy: 't1-blocked',
      }
    : await judgeConfirmation({
    alert: {
      ...alert,
      watchingAt: now - 5 * 60 * 1000,
      watchingPrice: Number(quote.price),
      decisionPrice: Number(quote.price),
    },
    name: input.security.name,
    advice: initialAdvice,
    quote,
    position: input.position,
    providers: {
      now: () => now,
      marketTimeContext: () => ({
        phase: '早盘(盘中)',
        bjNow: `${quote.tradeDate} 10:10`,
        isLive: true,
      }),
      fetchTrendsTx: async () => ({
        trends: clone(judge.trends || []),
        preClose: Number(judge.preClose)
          || Number(quote.price),
      }),
      fetchKlineTx: async () => null,
      fetchStockFund: async () =>
        judge.fundFailure === true
          ? null
          : clone(judge.funds || {}),
      llmJudge: async ({ reviewPacket }) => {
        calls.judge += 1
        packetLength = JSON.stringify(reviewPacket || {}).length
        traceStep(trace, 'judge-llm-stub', {
          packetSchema: reviewPacket?.schemaVersion,
          packetLength,
        })
        return clone(judge.modelOutput)
      },
    },
  })
  const wakeup = queueAdviceReviewForVerdict(
    data,
    alert,
    result,
    now + 1,
  )
  const notification = buildAlertNotification({
    alert,
    quote,
    stage: result.decision,
    reason: result.reason,
  })
  traceStep(trace, 'publish-judge-verdict', {
    decision: result.decision,
    source: result.source,
    reviewQueued: wakeup.queued === true,
  })
  return {
    result,
    wakeup,
    notification,
    promptLength: packetLength,
  }
}

function expectedValue(actual, expected) {
  return expected == null || actual === expected
}

export async function runDecisionLifecycleHarnessCase(testCase) {
  const input = clone(testCase.input || {})
  const expected = testCase.expect || {}
  const now = Number(input.now) || DEFAULT_NOW
  const calls = { advisor: 1, review: 0, judge: 0 }
  const trace = []
  const advisorPayload = baseAdvisorPayload(input, now)
  const initialPayload = preparePayload({
    base: advisorPayload,
    quote: advisorPayload.todayQuote,
    funds: advisorPayload.stockFund,
    trends: input.advisorTrends,
    now,
    mode: input.mode,
  })
  const advisorPrompt = buildUserPrompt(
    input.mode,
    initialPayload,
  )
  traceStep(trace, 'advisor-llm-stub', {
    promptLength: advisorPrompt.length,
  })
  const initial = finalizeModelOutput({
    mode: input.mode,
    payload: initialPayload,
    modelOutput: input.advisorModelOutput,
    triggered: false,
    now,
  })
  const data = accountData(input)
  data.advice[input.security.code] = {
    mode: input.mode,
    advice: initial.result,
  }
  projectAdviceAlerts(
    data,
    input.security.code,
    initial.result,
    {
      now,
      idFactory: (() => {
        let index = 0
        return () =>
          `alert.fake.${input.security.code}.${++index}`
      })(),
      requirePriceContract: true,
      t1Status: input.position,
      nextTradeDay: '2026-08-25',
    },
  )
  traceStep(trace, 'project-advice-alerts', {
    count: data.alerts.length,
    kinds: data.alerts.map(alertKind),
  })

  const initialAlerts = clone(data.alerts)
  const alert = selectedAlert(data.alerts, input.trigger)
  let branch = null
  if (input.path === 'FAST_REVIEW') {
    branch = await runFastReview({
      input,
      data,
      initialAdvice: initial.result,
      initialPayload,
      alert,
      calls,
      trace,
      now,
    })
  } else if (input.path === 'JUDGE') {
    branch = await runJudge({
      input,
      data,
      initialAdvice: initial.result,
      alert,
      calls,
      trace,
      now,
    })
  } else {
    branch = {
      notification: alert
        ? buildAlertNotification({
            alert,
            quote: initialPayload.todayQuote,
            stage: 'watch',
          })
        : null,
    }
    traceStep(trace, 'keep-watching', {
      alertPhase: alert?.phase || null,
    })
  }

  const terminalDecision = branch?.result?.reviewDecision
  const judgeDecision = input.path === 'JUDGE'
    ? branch?.result
    : null
  const finalOutcome = terminalDecision?.outcome
    || (
      judgeDecision
        ? judgeOutcome(alert, judgeDecision.decision)
        : ''
    )
    || (alert?.reviewOnly ? '等待观察' : '')
  const finalOperation = terminalDecision?.operation
    || ''
  const finalLots = Number(
    terminalDecision?.quantity
    ?? initial.result.decisionPlan?.quantity?.lots
    ?? 0,
  )
  const actualAlertKind = alertKind(alert)
  const notificationText = [
    branch?.notification?.title,
    branch?.notification?.body,
  ].filter(Boolean).join(' ')
  const packet = branch?.payload?.reviewDecisionPacket
    || judgeDecision?.signals?.reviewDecisionPacket
    || null
  const callMatch = Object.entries(expected.llmCalls || {})
    .every(([key, value]) => calls[key] === Number(value))
  const maxSteps = Number(
    expected.maxSteps
    ?? testCase.max_acceptable_steps,
  ) || null
  const maxReviewPromptLength = Number(
    expected.maxReviewPromptLength
    ?? (
      input.path === 'FAST_REVIEW'
        ? 8000
        : input.path === 'JUDGE' ? 5000 : 0
    ),
  ) || null
  const maxPositionPct = Number(
    packet?.priorPlan?.maxPositionPct
    ?? initial.result.reviewMemory?.conclusion?.maxPositionPct,
  )
  const generatedAlertPrices = initialAlerts
    .map((item) => Number(item.value))
    .filter(Number.isFinite)
  const contractPrices = (
    initial.result.priceContract?.levels || []
  ).map((item) => Number(item.price))
  const allAlertsGrounded = generatedAlertPrices.every(
    (price) => contractPrices.includes(price),
  )
  const checks = [
    check(
      'lifecycle-contract',
      'contract',
      initial.result.decisionPlan?.schemaVersion
        === 'decision-plan.v2'
        && initial.result.reviewMemory?.schemaVersion
          === 'advice-review-memory.v1'
        && (
          !packet
          || packet.schemaVersion === 'review-decision-packet.v1'
        ),
      '军师、复核或Judge结构化合同缺失',
      { hard: true, code: 'LIFECYCLE_CONTRACT_INVALID' },
    ),
    check(
      'lifecycle-expected-alert',
      'contract',
      expectedValue(actualAlertKind, expected.alertKind)
        && (
          expected.alertCount == null
          || Number(expected.alertCount)
            === Number(trace[1]?.count)
        ),
      '军师建议没有生成预期类型或数量的预警',
      {
        hard: true,
        code: 'LIFECYCLE_ALERT_MISMATCH',
        details: {
          actualAlertKind,
          alertCount: trace[1]?.count,
        },
      },
    ),
    check(
      'lifecycle-initial-action',
      'contract',
      expectedValue(
        initial.result.action || initial.result.stance || '',
        expected.initialAction,
      )
        && expectedValue(
          initial.result.decisionPlan?.action,
          expected.initialDecisionAction,
        ),
      '军师初始结论与预期不一致',
      {
        hard: true,
        code: 'LIFECYCLE_INITIAL_DECISION_MISMATCH',
      },
    ),
    check(
      'lifecycle-grounded-code',
      'groundedness',
      data.alerts.every(
        (item) => item.code === input.security.code,
      )
        && (!packet || packet.security.code === input.security.code),
      '决策链出现不属于当前假股票的代码',
      { hard: true, code: 'LIFECYCLE_CODE_FABRICATION' },
    ),
    check(
      'lifecycle-grounded-price',
      'groundedness',
      allAlertsGrounded
        || terminalDecision?.terminal === true,
      '预警价不在军师已验证价格契约中',
      { hard: true, code: 'LIFECYCLE_PRICE_UNGROUNDED' },
    ),
    check(
      'lifecycle-position-limit',
      'feasibility',
      expected.maxPositionPct == null
        || maxPositionPct <= Number(expected.maxPositionPct),
      '新增仓位超过场景允许上限',
      {
        hard: true,
        code: 'LIFECYCLE_POSITION_LIMIT_EXCEEDED',
        details: { maxPositionPct },
      },
    ),
    check(
      'lifecycle-lot-limit',
      'feasibility',
      expected.maxLots == null
        || finalLots <= Number(expected.maxLots),
      '执行手数超过场景上限',
      {
        hard: true,
        code: 'LIFECYCLE_LOTS_EXCEEDED',
        details: { finalLots },
      },
    ),
    check(
      'lifecycle-exact-lots',
      'feasibility',
      expected.exactLots == null
        || finalLots === Number(expected.exactLots),
      '最终手数没有按账户或原计划约束收敛',
      {
        hard: true,
        code: 'LIFECYCLE_EXACT_LOTS_MISMATCH',
        details: { finalLots },
      },
    ),
    check(
      'lifecycle-t1',
      'feasibility',
      expected.t1Blocked == null
        || (
          alert?.t1Blocked === true
          || judgeDecision?.policy === 't1-blocked'
          || /今日不可卖|T\\+1/.test(
            String(judgeDecision?.reason || ''),
          )
        ) === expected.t1Blocked,
      '减仓链路没有正确执行T+1限制',
      { hard: true, code: 'LIFECYCLE_T1_MISMATCH' },
    ),
    check(
      'lifecycle-outcome',
      'actionability',
      expectedValue(finalOutcome, expected.finalOutcome)
        && expectedValue(finalOperation, expected.finalOperation),
      '终局结论或操作类型与预期不一致',
      {
        hard: true,
        code: 'LIFECYCLE_OUTCOME_MISMATCH',
        details: { finalOutcome, finalOperation },
      },
    ),
    check(
      'lifecycle-notification',
      'actionability',
      (expected.notificationIncludes || []).every(
        (value) => notificationText.includes(String(value)),
      ),
      '预警通知没有明确传达股票、动作或下一步',
      {
        code: 'LIFECYCLE_NOTIFICATION_INCOMPLETE',
        details: notificationText,
      },
    ),
    check(
      'lifecycle-human-confirmation',
      'actionability',
      !terminalDecision
        || terminalDecision.followUpPlan
          ?.manualConfirmationRequired === true,
      '终局交易建议没有保留人工确认',
      { hard: true, code: 'LIFECYCLE_MANUAL_CONFIRMATION_MISSING' },
    ),
    check(
      'lifecycle-review-delta',
      'actionability',
      (expected.deltaIncludes || []).every((value) =>
        (packet?.delta?.summary || []).some((item) =>
          String(item).includes(String(value))
        )
      ),
      '复核输入包没有明确表达前后轮关键变化',
      {
        code: 'LIFECYCLE_DELTA_INCOMPLETE',
        details: packet?.delta?.summary || [],
      },
    ),
    check(
      'lifecycle-llm-routing',
      'consistency',
      callMatch,
      '同一触发调用了错误角色或重复调用LLM',
      {
        hard: true,
        code: 'LIFECYCLE_LLM_ROUTE_MISMATCH',
        details: { actual: calls, expected: expected.llmCalls },
      },
    ),
    check(
      'lifecycle-terminal-alert-cleanup',
      'consistency',
      expected.remainingAlerts == null
        || data.alerts.length === Number(expected.remainingAlerts),
      '终态后仍残留不应继续触发的旧预警',
      {
        hard: true,
        code: 'LIFECYCLE_ALERT_NOT_CLEANED',
        details: { remainingAlerts: data.alerts.length },
      },
    ),
    check(
      'lifecycle-idempotency',
      'consistency',
      expected.duplicateIgnored == null
        || (
          branch?.duplicate?.created !== true
          && branch?.duplicate?.already === true
        ) === expected.duplicateIgnored,
      '重复价格触发创建了第二个复核任务',
      { hard: true, code: 'LIFECYCLE_DUPLICATE_TRIGGER' },
    ),
    check(
      'lifecycle-cost-budget',
      'consistency',
      (
        maxSteps == null
        || trace.length <= maxSteps
      ) && (
        maxReviewPromptLength == null
        || Number(branch?.promptLength || 0)
          <= maxReviewPromptLength
      ),
      '决策链步骤或复核输入长度超过预算',
      {
        hard: true,
        code: 'LIFECYCLE_COST_BUDGET_EXCEEDED',
        details: {
          steps: trace.length,
          reviewPromptLength: Number(branch?.promptLength) || 0,
          maxSteps,
          maxReviewPromptLength,
        },
      },
    ),
  ]

  return {
    output: {
      security: input.security,
      path: input.path,
      initialAction:
        initial.result.action || initial.result.stance || '',
      initialAdviceName: initial.result.name || null,
      ownerName:
        data.holding[0]?.name
        || data.plan[0]?.name
        || null,
      initialDecision: {
        action: initial.result.decisionPlan?.action,
        actionability:
          initial.result.decisionPlan?.actionability,
      },
      alert: alert ? {
        kind: actualAlertKind,
        name: alert.name,
        op: alert.op,
        value: alert.value,
        phase: alert.phase,
        t1Blocked: alert.t1Blocked === true,
      } : null,
      reviewPacket: packet ? {
        schemaVersion: packet.schemaVersion,
        channel: packet.channel,
        delta: packet.delta,
        requestedDecision: packet.requestedDecision,
        currentPolicy:
          packet.current?.tactical?.actionPolicy || null,
      } : null,
      final: {
        outcome: finalOutcome,
        operation: finalOperation,
        lots: finalLots,
        decisionPlan: branch?.result?.decisionPlan
          ? {
              action: branch.result.decisionPlan.action,
              actionability:
                branch.result.decisionPlan.actionability,
              blockedReasons:
                branch.result.decisionPlan.blockedReasons || [],
            }
          : null,
        terminal:
          terminalDecision?.terminal === true
          || ['confirm', 'wait', 'invalid'].includes(
            String(judgeDecision?.decision || ''),
          ),
        followUpPlan:
          terminalDecision?.followUpPlan
          || null,
      },
      notification: branch?.notification || null,
      calls,
      trace,
      issues: [
        ...initial.issues,
        ...(branch?.issues || []),
      ],
      preAlignment: branch?.preAlignment || null,
    },
    checks,
    metrics: {
      advisorPromptLength: advisorPrompt.length,
      reviewPromptLength: Number(branch?.promptLength) || 0,
      steps: trace.length,
      llmCalls: calls.advisor + calls.review + calls.judge,
    },
  }
}
