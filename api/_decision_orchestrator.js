import { fetchQuotes } from './quote.js'
import { fetchResilientKline, fetchTrendsTx } from './stock_detail.js'
import { fetchResilientStockFund } from './_stock_fund.js'
import { loadSectorOpportunity } from './_sector_opportunity.js'
import { fetchDecisionScores } from './_action_value_client.js'
import { internalApiOrigin } from './_internal_origin.js'
import { accountFrom, buildHoldPayload, computePortfolio } from './_portfolio.js'
import { buildAccountRiskContext, accountRiskCodes } from '../shared/accountRiskBudget.js'
import { buildAdaptivePricePlans } from '../shared/adaptivePricePlans.js'
import { buildMarketOpportunityContext } from '../shared/marketOpportunityContext.js'
import { scoreOpportunityPlaybooks } from '../shared/opportunityPlaybooks.js'
import { buildOpportunityShadowFeatures } from '../shared/opportunityShadowFeatures.js'
import { buildOpportunityReviewFeatureInput } from '../shared/opportunityReviewFeatures.js'
import { buildOpportunityScoreInput, unavailableOpportunityScore } from '../shared/opportunityScoreContract.js'
import { summarizeStrategyPatterns } from '../shared/strategyPatternFeatures.js'
import {
  resolveStrategyPatternCapabilities,
  strategyPatternAnalysisEnabled,
} from '../shared/strategyPatternCapabilities.js'
import { buildDecisionAction } from '../shared/decisionEnginePolicy.js'
import { compileDecisionPlan, applyCompiledDecisionPlan } from '../shared/decisionPlan.js'
import { compileExecutionPlan } from '../shared/executionPlan.js'
import {
  buildDecisionRationale,
} from '../shared/decisionRationale.js'
import { buildNextSessionPlan } from '../shared/nextSessionPlan.js'
import { deriveMarketRegime } from '../shared/marketRegime.js'
import { buildStockFundNote } from '../shared/retailFundFlow.js'
import { beijingDayKey, beijingMinutes, isContinuousTrading } from '../shared/tradingCalendar.js'
import { attachMonitoringPlan } from '../shared/monitoringPlan.js'
import { isTriggeredReviewEvent } from '../shared/triggeredReviewDecision.js'
import { allocationMarketFrom } from '../shared/targetPositionModel.js'

async function bounded(promise, fallback, milliseconds = 7000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), milliseconds) }),
    ])
  } catch { return fallback }
  finally { clearTimeout(timer) }
}

async function readMarket(req) {
  const response = await fetch(`${internalApiOrigin(req)}/api/market`, {
    signal: AbortSignal.timeout(6000),
  })
  if (!response.ok) return null
  return response.json()
}

function beijingMinuteOfDay(value) {
  const timestamp = Number(value)
  if (!(timestamp > 0)) return null
  const iso = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString()
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
}

function trendMinuteOfDay(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

function postTriggerRows(trends, triggeredAt) {
  const minute = beijingMinuteOfDay(triggeredAt)
  if (minute == null) return []
  return trends.filter((item) => {
    const current = trendMinuteOfDay(item?.time)
    return current != null && current >= minute
  }).slice(0, 12)
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizedTradeDate(value) {
  const digits = String(value || '').replace(/\D/g, '')
  return /^\d{8}$/.test(digits) ? digits : ''
}

function currentFundEvidence(fund, tradeDate) {
  const expectedDate = normalizedTradeDate(tradeDate)
  const actualDate = normalizedTradeDate(fund?.asOfDate)
  const valuesPresent = (
    fund?.mainNetYi != null
    && fund?.retailNetYi != null
  )
  const current = (
    valuesPresent
    && (!expectedDate || actualDate === expectedDate)
  )
  return {
    ...(fund || {}),
    mainNetYi: current ? fund.mainNetYi : null,
    retailNetYi: current ? fund.retailNetYi : null,
    currentValuesValid: current,
    expectedTradeDate: expectedDate || null,
  }
}

function evidenceTrend(values) {
  return (Array.isArray(values) ? values : [])
    .slice(-5)
    .map((value) => finite(value))
}

function buildDecisionEvidence({
  now,
  quote,
  market,
  sector,
  fund,
  shadowFeatures,
  missingEvidence,
  strategyPatternDisplayEnabled = false,
}) {
  const strategyPattern = strategyPatternDisplayEnabled
    ? summarizeStrategyPatterns({
        ...shadowFeatures,
        ret5dPct: shadowFeatures.ret5dPct,
      }).patterns.find((item) => item.matched) || null
    : null
  const availability = {
    dailyTechnical: shadowFeatures.dailyTechnicalAvailable === 1,
    intradayTechnical: shadowFeatures.intradayTechnicalAvailable === 1,
    currentFund: shadowFeatures.fundCurrentAvailable === 1,
    fundHistory: shadowFeatures.fundHistoryAvailable === 1,
    completeFundHistory: shadowFeatures.fundHistoryComplete === 1,
    sectorContext: shadowFeatures.sectorContextAvailable === 1,
    marketBreadth: (
      finite(market?.breadth?.up) != null
      && finite(market?.breadth?.down) != null
    ),
  }
  const knownGaps = [...(missingEvidence || [])]
  if (!availability.completeFundHistory) {
    knownGaps.push(
      `资金逐日历史仅${Math.trunc(
        finite(shadowFeatures.fundHistoryDayCount) || 0,
      )}个交易日，不能判断完整5日连续性`,
    )
  }
  if (!availability.sectorContext) {
    knownGaps.push('未匹配到有效板块上下文')
  }
  if (quote?.live === true && !availability.intradayTechnical) {
    knownGaps.push('当前分时均价线数据缺失')
  }
  const sectorValue = sector?.sector || {}
  const completeHistory = availability.completeFundHistory
  return {
    schemaVersion: 'decision-evidence.v1',
    asOf: now,
    availability,
    technical: {
      quotePct: finite(quote?.pct),
      ret2dPct: finite(shadowFeatures.ret2dPct),
      ret5dPct: finite(shadowFeatures.ret5dPct),
      atrPct: finite(shadowFeatures.atrPct),
      vwapDistancePct: finite(shadowFeatures.vwapDistancePct),
      intradayRangePct: finite(shadowFeatures.intradayRangePct),
      strategyPattern,
    },
    funds: {
      asOfDate: String(fund?.asOfDate || '').slice(0, 10) || null,
      mainNetYi: availability.currentFund
        ? finite(fund?.mainNetYi)
        : null,
      retailNetYi: availability.currentFund
        ? finite(fund?.retailNetYi)
        : null,
      historyDayCount:
        finite(shadowFeatures.fundHistoryDayCount) || 0,
      historyComplete: completeHistory,
      mainTrend5: evidenceTrend(fund?.mainTrend5 ?? fund?.trend5),
      retailTrend5: evidenceTrend(fund?.retailTrend5),
      main5dYi: finite(fund?.main5dYi)
        ?? (completeHistory ? finite(shadowFeatures.main5dYi) : null),
      retail5dYi: finite(fund?.retail5dYi)
        ?? (completeHistory ? finite(shadowFeatures.retail5dYi) : null),
      mainInflowDays5: availability.fundHistory
        ? finite(shadowFeatures.mainInflowDays5)
        : null,
      retailInflowDays5: availability.fundHistory
        ? finite(shadowFeatures.retailInflowDays5)
        : null,
      mainStreak5: availability.fundHistory
        ? finite(shadowFeatures.mainStreak5)
        : null,
      retailStreak5: availability.fundHistory
        ? finite(shadowFeatures.retailStreak5)
        : null,
    },
    sector: {
      matched: availability.sectorContext,
      code: String(sectorValue.code || '').slice(0, 20) || null,
      name: String(sectorValue.name || '').slice(0, 60) || null,
      phase: String(sectorValue.phase || '').slice(0, 40) || null,
      actionability:
        String(sectorValue.actionability || '').slice(0, 40) || null,
      rank: finite(sectorValue.rank),
      mainNetYi: finite(
        sectorValue.mainNetYi
        ?? sectorValue.mainInflow,
      ),
      breadthPct: finite(
        sectorValue.breadthPct
        ?? sectorValue.breadth?.inflowPct
        ?? sectorValue.breadth,
      ),
    },
    market: {
      up: finite(market?.breadth?.up),
      down: finite(market?.breadth?.down),
      flat: finite(market?.breadth?.flat),
    },
    knownGaps: [...new Set(knownGaps.filter(Boolean))],
  }
}

export async function evaluateDecision({
  code, book, quotes, detail, trends, fund, sector, market, now = Date.now(),
  score = (inputs) => fetchDecisionScores(inputs, { timeoutMs: 8000 }),
  reviewEvent = null,
}) {
  const quoteMap = Object.fromEntries(quotes.map((item) => [item.code, item]))
  const rawQuote = quoteMap[code]
  const quote = {
    ...rawQuote,
    volumeRatio: rawQuote?.volumeRatio ?? rawQuote?.volRatio,
    preClose: rawQuote?.preClose ?? rawQuote?.prevClose,
    live: rawQuote?.isLivePrice === true
      && rawQuote?.tradeDate === beijingDayKey(now)
      && isContinuousTrading(now),
  }
  if (!(Number(quote?.price) > 0)) throw new Error('行情不可用，未发布新决策')
  const name = quote.name || code
  const trendRows = Array.isArray(trends)
    ? trends
    : Array.isArray(trends?.trends) ? trends.trends : []
  const holding = (book.holding || []).filter((item) => item.code === code)
  const portfolio = computePortfolio(book.holding || [], quoteMap, book.account)
  const accountRisk = buildAccountRiskContext(book, quoteMap, now)
  const candles = (detail?.candles || []).filter((bar) =>
    [bar.close, bar.high, bar.low].every((value) => Number.isFinite(Number(value)) && Number(value) > 0))
  const evidenceTradeDate = quote.live
    ? quote.tradeDate
    : candles.at(-1)?.date || quote.tradeDate
  const validatedFund = currentFundEvidence(
    fund,
    evidenceTradeDate,
  )
  const context = buildMarketOpportunityContext({ market: market || {} })
  const strategyPatternCapabilities =
    resolveStrategyPatternCapabilities(process.env)
  const strategyPatternToolsEnabled =
    strategyPatternAnalysisEnabled(strategyPatternCapabilities)
  const shadowFeatures = buildOpportunityShadowFeatures({
    quote,
    candles,
    trends: trendRows,
    fund: validatedFund,
    sectorOpportunity: sector || {},
    mode: quote.live === true ? 'intraday' : 'close',
  })
  const strategyPattern = strategyPatternCapabilities.display
    ? summarizeStrategyPatterns({
        ...shadowFeatures,
        ret5dPct: shadowFeatures.ret5dPct,
      }).patterns.find((item) => item.matched) || null
    : null
  const candidate = {
    code,
    name,
    quote,
    fund: validatedFund,
    sectorOpportunity: sector,
    ...(strategyPatternToolsEnabled ? { shadowFeatures } : {}),
    strategyPatternCapabilities,
    strategyPatternPolicy: strategyPatternCapabilities.playbookBlend
      ? 'ACTIVE'
      : 'RESEARCH',
  }
  const playbook = scoreOpportunityPlaybooks(candidate, context).selected
  let plans = buildAdaptivePricePlans({
    candidate,
    candles,
    trends: trendRows,
    marketContext: context,
    now,
  })
  const holdPayload = holding.length ? buildHoldPayload(
    book.holding, code, name, portfolio, book.account, book.closed, null, quote, now,
  ) : { code, name, holdQty: 0 }
  const pendingStockWeight = accountRisk.reservedExposures
    .filter((item) => item.code === code)
    .reduce((sum, item) => sum + item.positionPct, 0)
  const industry = quote.industry || ''
  const industryWeight = industry ? [...accountRisk.exposures, ...accountRisk.reservedExposures]
    .filter((item) => item.sectorCode === industry)
    .reduce((sum, item) => sum + item.positionPct, 0) : 0
  const missingEvidence = [
    candles.length < 20 ? '至少20根有效日线' : '',
    !(market?.breadth?.up != null && market?.breadth?.down != null) ? '市场涨跌家数' : '',
    validatedFund.currentValuesValid !== true ? '当日主力与小单资金' : '',
    !holding.length && !accountRisk.complete ? '账户现金或持仓风险' : '',
  ].filter(Boolean)
  const payload = {
    ...holdPayload,
    account: {
      ...accountFrom(portfolio, book.account), ...holdPayload.account,
      pendingStockWeight,
      maxStockWeight: Math.max(0, Math.min(20,
        30 - industryWeight + (holdPayload.account?.stockWeight || 0) + pendingStockWeight)),
    },
    todayQuote: {
      ...quote,
      volumeRatio: quote.volumeRatio ?? quote.volRatio,
      live: quote.isLivePrice === true && quote.tradeDate === beijingDayKey(now) && isContinuousTrading(now),
    },
    market: market || {},
    marketEnv: deriveMarketRegime(market || {}),
    sectorOpportunity: sector || {},
    accountCircuitBreaker: accountRisk.breaker,
    holdingStopPrice: Math.max(0, ...holding.map((item) => Number(item.sl) || 0)) || null,
    stockFund: validatedFund,
    reviewEvent,
    allocationMarket: allocationMarketFrom(candles, quote),
    reservedBuyLots: accountRisk.reservedExposures
      .filter((item) => item.code === code)
      .reduce((sum, item) => sum + (Number(item.lots) || 0), 0),
    missingEvidence,
    evidenceIncomplete: missingEvidence.length > 0,
  }
  if (holding.length && payload.holdingStopPrice > 0) {
    plans = plans
      .map((plan) => {
        const hardStopPrice = Math.max(
          Number(plan.exitPlan.hardStopPrice) || 0,
          payload.holdingStopPrice,
        )
        return {
        ...plan,
        exitPlan: { ...plan.exitPlan, hardStopPrice },
        riskReward: (plan.exitPlan.takeProfitPrice - plan.entryPlan.price)
          / (plan.entryPlan.price - hardStopPrice),
        }
      })
      .filter((plan) => plan.entryPlan.price > plan.exitPlan.hardStopPrice)
  }
  const decisionEvidence = buildDecisionEvidence({
    now,
    quote: payload.todayQuote,
    market,
    sector,
    fund: validatedFund,
    shadowFeatures,
    missingEvidence,
    strategyPatternDisplayEnabled:
      strategyPatternCapabilities.display,
  })
  // One request per route prevents stock-code keyed clients from mixing three prices.
  const evaluated = await Promise.all(plans.map(async (plan) => {
    const input = buildOpportunityScoreInput({
      batch: {
        mode: payload.todayQuote.live ? 'INTRADAY' : 'CLOSE',
        slot: beijingMinutes(now),
        marketGate: {
          allowed: payload.marketEnv.allowRiskIncrease === true,
          riskTier: payload.marketEnv.allowRiskIncrease !== true
            ? 'BLOCKED' : payload.marketEnv.weak === true ? 'CAUTIOUS' : 'STANDARD',
        },
      },
      event: {
        code,
        asOf: now,
        quote: payload.todayQuote,
        shadowFeatures,
        strategyPatternModelFeatures:
          strategyPatternCapabilities.modelFeatures === true,
        decision: {
          formulaId: 'UNKNOWN', priceContractValid: true,
          playbookId: playbook?.key, playbookScore: playbook?.score,
          marketOpportunityFactor: context.opportunityFactor,
          route: plan.route, primaryPrice: plan.entryPlan.price,
          priceType: plan.route === 'BREAKOUT' ? 'BREAKOUT_WATCH' : 'PULLBACK_WATCH',
          stopPrice: plan.exitPlan.hardStopPrice, targetPrice: plan.exitPlan.takeProfitPrice,
          riskReward: plan.riskReward,
        },
        sector: sector?.sector,
      },
    })
    const scores = payload.evidenceIncomplete
      ? new Map()
      : await score([input]).catch(() => new Map())
    return {
      ...plan,
      opportunityScore: {
        ...(scores.get(code) || unavailableOpportunityScore(
          input,
          payload.evidenceIncomplete
            ? 'EVIDENCE_INCOMPLETE'
            : 'MISSING_RESPONSE',
        )),
        serverVerified: true,
        priceContract: {
          entryPrice: plan.entryPlan.price,
          stopPrice: plan.exitPlan.hardStopPrice,
          targetPrice: plan.exitPlan.takeProfitPrice,
          modelPriceRiskPerShare:
            plan.entryPlan.price * input.factors.stopDistancePct / 100,
        },
      },
    }
  }))
  // Budget every path on the same account snapshot before comparing them.
  // These hypothetical compilations are never published as executable plans.
  for (const plan of evaluated) {
    const adding = holding.length > 0
    const full = !adding || Number(plan.opportunityScore?.meanConfidenceLowerBound) > 0
    const hypothetical = compileDecisionPlan({
      mode: adding ? 'hold_advice' : 'buy_advice',
      advice: {
        action: adding ? '加仓' : '立即买入',
        buyPrice: plan.entryPlan.price,
        addPrice: plan.entryPlan.price,
        stopPrice: plan.exitPlan.hardStopPrice,
        targetPrice: plan.exitPlan.takeProfitPrice,
      },
      payload: { ...payload, opportunityScore: plan.opportunityScore, decisionPricePlan: plan },
      now,
      accountCircuitBreaker: accountRisk.breaker,
      deterministicPolicy: {
        quantityModelRequired: true,
        effectiveAction: adding ? 'ADD' : 'BUY',
        riskTier: full ? 'FULL' : 'PROBE',
        executionOpen: false,
        riskMultiplier: context.baseRiskPct / 0.6,
        maxStockWeightPct: full ? 20 : 5,
        maxPortfolioPositionPct: 85,
      },
    })
    plan.targetPosition = hypothetical.targetPosition
  }
  let advice = {
    ...buildDecisionAction({ payload, plans: evaluated, now }),
    fundNote: '',
    strategyPattern,
    strategyPatternCapabilities,
  }
  const reviewScoreInput = isTriggeredReviewEvent(reviewEvent)
    ? buildOpportunityReviewFeatureInput({
        code,
        asOf: now,
        triggerPrice:
          reviewEvent.threshold
          ?? reviewEvent.price,
        direction:
          reviewEvent.direction
          ?? reviewEvent.plannedAction,
        rows: postTriggerRows(trendRows, reviewEvent.at),
        initialScore:
          advice.selectedDecisionPlan?.opportunityScore,
      })
    : null
  if (reviewScoreInput) payload.reviewScoreInput = reviewScoreInput
  if (reviewEvent) {
    advice.pullbackWatchPrice = null
    advice.breakoutWatchPrice = null
    advice.holdingAddPlan = null
    advice.reviewDecision = {
      schemaVersion: 'triggered-review-decision.v1',
      terminal: true,
      outcome: advice.action,
      operation: advice.action,
      quantity: Number(advice.opQty.match(/\d+/)?.[0]) || 0,
    }
  }
  payload.opportunityScore =
    advice.selectedDecisionPlan?.opportunityScore || null
  payload.decisionPricePlan = advice.selectedDecisionPlan
  const action = {
    清仓: 'EXIT',
    减仓: 'REDUCE',
    持有: 'HOLD',
    加仓: 'ADD',
    立即买入: 'BUY',
    观望: 'WATCH',
  }[advice.action]
  const mode = holding.length ? 'hold_advice' : 'buy_advice'
  advice.fundNote = buildStockFundNote(validatedFund)
    || '资金数据暂缺，未据此推断资金方向'
  const plannedReviewAction = String(
    reviewEvent?.plannedAction || '',
  ).toUpperCase()
  const fullAddReview = (
    action === 'ADD'
    && plannedReviewAction === 'ADD'
    && reviewEvent?.directionApproved === true
  )
  const conditionalAdd = (
    action === 'HOLD'
    && advice.holdingAddPlan?.schemaVersion === 'holding-add-plan.v1'
  )
  const addRiskTier = (
    action === 'ADD' || conditionalAdd
  ) ? (
      fullAddReview
      || advice.holdingAddPlan?.plannedAction === 'ADD'
        ? 'FULL'
        : 'PROBE'
    ) : null
  const requestedAddPositionPct = finite(
    reviewEvent?.maxPositionPct
    ?? advice.holdingAddPlan?.maxPositionPct,
  )
  const maxStockWeightPct = addRiskTier === 'PROBE'
    ? Math.min(5, requestedAddPositionPct || 5)
    : Math.min(20, requestedAddPositionPct || 20)
  const decisionPlan = compileDecisionPlan({
    mode, advice, payload, now, accountCircuitBreaker: accountRisk.breaker,
    deterministicPolicy: {
      quantityModelRequired: true,
      effectiveAction: action,
      riskTier: !holding.length && advice.selectedDecisionPlan
        ? 'FULL' : addRiskTier || 'NONE',
      executionOpen: payload.todayQuote.live,
      hardProtection: advice.decisionSource.hardProtection,
      exitConfirmed: (
        ['EXIT', 'REDUCE'].includes(action)
        && isTriggeredReviewEvent(reviewEvent)
      ),
      riskMultiplier: context.baseRiskPct / 0.6,
      maxStockWeightPct,
      maxPortfolioPositionPct: 85,
    },
  })
  const sourceInstruction = advice.actionPlan
  advice = applyCompiledDecisionPlan({ ...advice, decisionPlan })
  if (
    advice.holdingAddPlan
    && decisionPlan.entryBudget?.state !== 'ESTIMATED'
  ) {
    advice = {
      ...advice,
      holdingAddPlan: null,
      pullbackWatchPrice: null,
      breakoutWatchPrice: null,
    }
  }
  const decisionRationale = buildDecisionRationale({
    advice,
    decisionPlan,
  })
  advice = {
    ...advice,
    decisionRationale,
    quantNote: decisionRationale.summary || advice.quantNote,
  }
  if (mode === 'hold_advice' && payload.todayQuote.live !== true) {
    advice.closePositionPlan = buildNextSessionPlan({
      advice,
      closePrice: payload.todayQuote.price,
      holdingLots: payload.holdQty,
      sellableLots: payload.holdQty,
      now,
    })
  }
  if (!['BUY', 'ADD'].includes(decisionPlan.action) && !decisionPlan.blockedReasons?.length) {
    advice.actionPlan = sourceInstruction
    advice.nextAction = sourceInstruction
  }
  const reviewedEntry = (
    reviewEvent?.reviewMode === 'ENTRY_CONFIRMATION'
    || /BUY|ADD/.test(plannedReviewAction)
  )
  const reviewedExit = (
    reviewEvent?.reviewMode === 'EXIT_CONFIRMATION'
    || /REDUCE|EXIT/.test(plannedReviewAction)
  )
  const reviewedQuantity = reviewedEntry
    ? ['BUY', 'ADD'].includes(decisionPlan.action)
      ? decisionPlan.quantity.lots
      : 0
    : reviewedExit
      ? ['REDUCE', 'EXIT'].includes(decisionPlan.action)
        ? decisionPlan.quantity.lots
        : 0
      : decisionPlan.quantity.lots
  advice = {
    ...advice,
    ...(reviewEvent ? {
      reviewDecision: {
        ...advice.reviewDecision,
        outcome: advice.action,
        operation: advice.actionPlan,
        quantity: reviewedQuantity,
      },
    } : {}),
    priceContract: decisionPlan.priceContract,
    executionPlan: compileExecutionPlan({ decisionPlan, code, name, now }),
    decisionEvidence,
    continuity: {
      planId: decisionPlan.decisionId, revision: 1, thesisVersion: 1, changeType: 'initial',
    },
  }
  if (decisionPlan.action === 'HOLD' && payload.holdingStopPrice > 0) {
    advice.executionRules = [{
      id: 'ledger-stop', action: 'EXIT', kind: 'RISK_EXIT',
      lots: Math.max(0, Math.trunc(Number(payload.holdQty) || 0)),
      logic: 'ALL', session: 'CONTINUOUS', sustainSeconds: 0,
      conditions: [{ metric: 'price', op: 'lte', value: payload.holdingStopPrice }],
    }]
    advice = attachMonitoringPlan({ advice, payload, decisionPlan, now })
  }
  return {
    ok: true, mode, result: advice, updatedAt: now,
    model:
      advice.decisionSource.modelVersion
      || 'DECISION_MODEL_UNAVAILABLE',
    meta: {
      todayQuote: payload.todayQuote,
      decisionSource: advice.decisionSource,
      reviewScoreInput,
      llmCalls: 0,
    },
    news: [], truncated: false,
  }
}

export async function runDecision({ req, book, code, onProgress = () => {}, signal, reviewEvent = null }) {
  if (!/^\d{6}$/.test(String(code || ''))) throw new Error('股票代码无效')
  signal?.throwIfAborted()
  onProgress('采集行情、账户与决策特征', 'collect')
  const codes = [...new Set([code, ...accountRiskCodes(book)])]
  const [quotes, detail, trends, fund, sector, market] = await Promise.all([
    bounded(fetchQuotes(codes), []),
    bounded(fetchResilientKline(code, '101', 120), null),
    bounded(fetchTrendsTx(code), []),
    bounded(fetchResilientStockFund(code), null),
    bounded(loadSectorOpportunity(code), null),
    bounded(readMarket(req), null),
  ])
  signal?.throwIfAborted()
  onProgress('评估三条价格路径与账户风险', 'quant')
  const result = await evaluateDecision({ code, book, quotes, detail, trends, fund, sector, market, reviewEvent })
  signal?.throwIfAborted()
  return result
}
