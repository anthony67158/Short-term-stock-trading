import {
  fetchTailPickRealtimePool,
  sectorOpportunityFromTags,
} from './_tail_pick_data.js'
import {
  fetchResilientKline,
  fetchKlineTx,
  fetchTrendsTx,
} from './stock_detail.js'
import { fetchResilientStockFund } from './_stock_fund.js'
import { fetchStockTagProfile } from './stock_tags.js'
import { fetchQuotes } from './quote.js'
import { computeTechnicals } from './_ta.js'
import { collectTailPickMarketContext } from './_tail_pick_data.js'
import {
  evaluateFormulaSelection,
  FORMULA_REGISTRY,
} from '../shared/formulaSelection.js'
import {
  buildFormulaPriceDecision,
} from '../shared/formulaPriceEngine.js'
import {
  buildFormulaEvidenceReference,
} from '../shared/formulaEvidencePolicy.js'
import {
  livePositionOf,
  t1StatusOf,
} from '../shared/portfolioAccounting.js'
import {
  beijingDayKey,
  isContinuousTrading,
} from '../shared/tradingCalendar.js'
import {
  buildOpportunityShadowFeatures,
} from '../shared/opportunityShadowFeatures.js'
import {
  buildMarketOpportunityContext,
} from '../shared/marketOpportunityContext.js'
import {
  chooseAdaptivePricePlan,
} from '../shared/adaptivePricePlans.js'

function finite(value) {
  if (value == null || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function validStock(quote = {}, expectedTradeDate = beijingDayKey()) {
  return (
    /^\d{6}$/.test(String(quote.code || ''))
    && !/ST|退/i.test(String(quote.name || ''))
    && quote.tradeDate === expectedTradeDate
    && finite(quote.price) > 0
    && finite(quote.open) > 0
    && finite(quote.high) > 0
    && finite(quote.low) > 0
    && finite(quote.amount) != null
    && finite(quote.turnover) != null
  )
}

export function passesAdaptiveRealtimePrefilter(
  quote = {},
  expectedTradeDate = beijingDayKey(),
) {
  if (!validStock(quote, expectedTradeDate)) return false
  const pct = finite(quote.pct)
  const amount = finite(quote.amount)
  const turnover = finite(quote.turnover)
  return (
    pct >= -19.8
    && pct <= 19.8
    && amount >= 30_000_000
    && turnover >= 0.3
  )
}

export function assertCompleteFormulaUniverse(universe = {}) {
  const total = Math.floor(Number(universe.total) || 0)
  const inspected = Math.floor(Number(universe.inspectedCount) || 0)
  const allList = Array.isArray(universe.allList)
    ? universe.allList
    : []
  const uniqueCodes = new Set(
    allList
      .map((item) => String(item?.code || ''))
      .filter((code) => /^\d{6}$/.test(code)),
  ).size
  const completeCount = Math.min(inspected, allList.length, uniqueCodes)
  if (total <= 0 || completeCount !== total) {
    throw new Error(`全市场快照不完整：${completeCount}/${total}`)
  }
  return allList
}

export function passesFormulaRealtimePrefilter(
  quote = {},
  mode = 'intraday',
  expectedTradeDate = beijingDayKey(),
) {
  if (!validStock(quote, expectedTradeDate)) return false
  const pct = finite(quote.pct)
  const amount = finite(quote.amount)
  const turnover = finite(quote.turnover)
  if (mode === 'close') {
    return (
      pct >= -3
      && pct <= 4
      && amount >= 50_000_000
      && turnover >= 1
    )
  }
  return (
    pct >= 0.5
    && pct <= 5
    && amount >= 50_000_000
    && turnover >= 2
  )
}

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  const workers = Array.from({
    length: Math.min(concurrency, items.length),
  }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return output
}

function cheapRank(quote, mode) {
  const amountScore = Math.min(30, Number(quote.amount || 0) / 100_000_000)
  const flowScore = Math.max(
    -10,
    Math.min(20, Number(quote.mainRatio || 0)),
  )
  const ratioScore = Math.min(10, Number(quote.volumeRatio || 0) * 2)
  const pct = Number(quote.pct || 0)
  const positionScore = mode === 'intraday'
    ? Math.max(0, 10 - Math.abs(pct - 2.5) * 2)
    : Math.max(0, 10 - Math.abs(pct - 1))
  return amountScore + flowScore + ratioScore + positionScore
}

function assignPercentiles(items, key, score) {
  const ranked = items
    .map((item) => ({ item, value: Number(score(item)) || 0 }))
    .sort((left, right) =>
      left.value - right.value
      || String(left.item.quote.code).localeCompare(
        String(right.item.quote.code),
      )
    )
  const denominator = Math.max(1, ranked.length - 1)
  let cursor = 0
  while (cursor < ranked.length) {
    let end = cursor + 1
    while (end < ranked.length && ranked[end].value === ranked[cursor].value) {
      end += 1
    }
    const percentile = ranked.length === 1
      ? 1
      : ((cursor + end - 1) / 2) / denominator
    for (let index = cursor; index < end; index += 1) {
      ranked[index].item.recall[key] = +percentile.toFixed(6)
    }
    cursor = end
  }
}

function withRecallMetadata(items, mode) {
  const values = items.map((item) => ({
    ...item,
    recall: {
      primarySource: 'UNKNOWN',
      sources: [],
      momentumPct: 0,
      accumulationPct: 0,
      reversalPct: 0,
      liquidityPct: 0,
      cheapScorePct: 0,
      exploration: false,
    },
  }))
  assignPercentiles(values, 'momentumPct', (item) =>
    Number(item.quote.pct || 0) * 2
    + Math.log1p(Math.max(0, Number(item.quote.amount || 0))) / 4
  )
  assignPercentiles(values, 'accumulationPct', (item) =>
    Number(item.quote.mainRatio || 0)
    - Math.abs(Number(item.quote.pct || 0)) * 0.8
    + Number(item.quote.volumeRatio || 0)
  )
  assignPercentiles(values, 'reversalPct', (item) =>
    -Number(item.quote.pct || 0) * 2
    + Math.log1p(Math.max(0, Number(item.quote.amount || 0))) / 5
  )
  assignPercentiles(values, 'liquidityPct', (item) =>
    Math.log1p(Math.max(0, Number(item.quote.amount || 0)))
    + Math.min(12, Number(item.quote.turnover || 0)) / 3
  )
  assignPercentiles(values, 'cheapScorePct', (item) =>
    cheapRank(item.quote, mode)
  )
  return values
}

function rankedUnique(groups, limit) {
  const selected = new Map()
  for (const { source, items } of groups) {
    for (const item of items) {
      if (!item.recall.sources.includes(source)) {
        item.recall.sources.push(source)
      }
      if (item.recall.primarySource === 'UNKNOWN') {
        item.recall.primarySource = source
      }
      if (selected.size >= limit) break
      if (!selected.has(item.quote.code)) {
        selected.set(item.quote.code, item)
      }
    }
  }
  return [...selected.values()]
}

function explorationRank(code, seed) {
  let value = (Number(code) ^ seed) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  return (value ^ (value >>> 16)) >>> 0
}

export function selectAdaptiveDeepCandidates(
  quotes = [],
  {
    mode = 'intraday',
    expectedTradeDate = beijingDayKey(),
    limit = 96,
  } = {},
) {
  const eligible = (Array.isArray(quotes) ? quotes : [])
    .filter((quote) =>
      passesAdaptiveRealtimePrefilter(quote, expectedTradeDate)
    )
    .map((quote) => ({
      quote,
      cheapScore: cheapRank(quote, mode),
    }))
  const rankedEligible = withRecallMetadata(eligible, mode)
  const quota = Math.max(1, Math.floor(limit / 4))
  const momentum = rankedEligible.slice().sort((left, right) =>
    Number(right.quote.pct || 0) - Number(left.quote.pct || 0)
    || Number(right.quote.amount || 0) - Number(left.quote.amount || 0)
  ).slice(0, quota)
  const accumulation = rankedEligible.slice().sort((left, right) =>
    Number(right.quote.mainRatio || 0) - Number(left.quote.mainRatio || 0)
    || Math.abs(Number(left.quote.pct || 0))
      - Math.abs(Number(right.quote.pct || 0))
  ).slice(0, quota)
  const reversal = rankedEligible.slice().sort((left, right) =>
    Number(left.quote.pct || 0) - Number(right.quote.pct || 0)
    || Number(right.quote.amount || 0) - Number(left.quote.amount || 0)
  ).slice(0, quota)
  const liquid = rankedEligible.slice().sort((left, right) =>
    Number(right.quote.amount || 0) - Number(left.quote.amount || 0)
    || right.cheapScore - left.cheapScore
  ).slice(0, quota)
  const firstPass = rankedUnique(
    [
      { source: 'MOMENTUM', items: momentum },
      { source: 'ACCUMULATION', items: accumulation },
      { source: 'REVERSAL', items: reversal },
      { source: 'LIQUIDITY', items: liquid },
    ],
    limit,
  )
  if (firstPass.length >= limit) return firstPass
  const selectedCodes = new Set(firstPass.map((item) => item.quote.code))
  const explorationSeed = Number(
    String(expectedTradeDate).replace(/\D/g, ''),
  ) || 0
  const exploration = rankedEligible
    .filter((item) => !selectedCodes.has(item.quote.code))
    .sort((left, right) => {
      const leftHash = explorationRank(left.quote.code, explorationSeed)
      const rightHash = explorationRank(right.quote.code, explorationSeed)
      return leftHash - rightHash
    })
    .map((item) => ({
      ...item,
      recall: {
        ...item.recall,
        primarySource: 'EXPLORATION',
        sources: [...item.recall.sources, 'EXPLORATION'],
        exploration: true,
      },
    }))
  return [...firstPass, ...exploration].slice(0, limit)
}

function uniqueReasons(values = []) {
  return [...new Set(
    values
      .flat()
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )]
}

function candidateEvent(quote, cheapScore, recall = {}) {
  return {
    code: quote.code,
    name: quote.name,
    stageReached: 'PREFILTER',
    quote,
    cheapScore,
    recall,
    formulaEvaluations: [],
    shadowFeatures: {},
    decision: null,
    counterfactualPlans: [],
    sector: null,
    rejectionReasons: [],
  }
}

function adaptiveDecisionFromPlan(code, formula, selectedPlan) {
  const adaptive = selectedPlan.adaptive
  const planningBlockers = (adaptive.hardBlockers || []).filter(
    (item) => item !== 'V3评分不可用，当前不执行',
  )
  return {
    schemaVersion: 'formula-price-decision.v1',
    code: String(code),
    formulaId: formula.matches[0]?.formulaId || 'UNKNOWN',
    playbookId: adaptive.playbook?.key || null,
    playbookScore: finite(adaptive.playbook?.score),
    marketOpportunityFactor: finite(
      adaptive.marketOpportunityFactor,
    ),
    route: selectedPlan.route,
    positionMode: 'UNOWNED',
    action: planningBlockers.length ? 'AVOID' : 'WATCH_BUY',
    primaryPrice: selectedPlan.entryPlan.price,
    priceType: selectedPlan.entryPlan.type === 'BREAKOUT'
      ? 'BREAKOUT_WATCH'
      : selectedPlan.entryPlan.type === 'IMMEDIATE'
        ? 'IMMEDIATE'
        : 'PULLBACK_WATCH',
    stopPrice: selectedPlan.exitPlan.hardStopPrice,
    targetPrice: selectedPlan.exitPlan.takeProfitPrice,
    riskReward: selectedPlan.riskReward,
    validUntil: selectedPlan.entryPlan.validUntil,
    timeStopTradingDays: selectedPlan.exitPlan.timeStopTradingDays,
    priceContractValid: true,
    dataComplete: true,
    dataFresh: true,
    marketAllowsRisk: planningBlockers.length === 0,
    hardStopTriggered: false,
    executionState: planningBlockers.length
      ? 'BLOCKED'
      : 'V3_PENDING',
    sellableQty: null,
    evidence: adaptive.playbook?.evidence || [],
    blockers: planningBlockers,
  }
}

function publicCandidate(item, rank) {
  return {
    code: item.code,
    name: item.name,
    rank,
    score: item.score,
    formulaId: item.decision.formulaId,
    validationState: 'V3_PENDING',
    action: item.decision.action,
    executionState: item.decision.executionState,
    marketAllowsRisk: item.decision.marketAllowsRisk,
    priceContractValid: item.decision.priceContractValid,
    primaryPrice: item.decision.primaryPrice,
    priceType: item.decision.priceType,
    stopPrice: item.decision.stopPrice,
    targetPrice: item.decision.targetPrice,
    riskReward: item.decision.riskReward,
    timeStopTradingDays: item.decision.timeStopTradingDays,
    playbookId: item.decision.playbookId,
    route: item.decision.route,
    validUntil: item.decision.validUntil,
    evidence: item.decision.evidence,
    blockers: item.decision.blockers,
    quote: item.quote,
    fund: item.fund,
    sector: item.sectorOpportunity?.sector || null,
    tags: {
      industry: item.tags?.industry || '',
      concepts: (item.tags?.concepts || []).slice(0, 4),
    },
    adaptive: item.adaptive || null,
    cautions: item.adaptive?.cautions || [],
    shadowFeatures: item.shadowFeatures || {},
    actionAlternatives: item.counterfactualPlans || [],
  }
}

export async function scanFormulaSelectionCandidates({
  mode = 'intraday',
  marketContext,
  fetchUniverse = fetchTailPickRealtimePool,
  fetchKline = fetchKlineTx,
  fetchTrends = fetchTrendsTx,
  fetchFund = fetchResilientStockFund,
  fetchTags = fetchStockTagProfile,
  matchSector = sectorOpportunityFromTags,
  onProgress = null,
  now = Date.now(),
} = {}) {
  const normalizedMode = mode === 'close' ? 'close' : 'intraday'
  const report = async (progress) => {
    if (typeof onProgress === 'function') await onProgress(progress)
  }
  await report({
    stage: 'UNIVERSE',
    percent: 12,
    message: '正在读取完整A股行情',
  })
  const universe = await fetchUniverse({ now })
  const allQuotes = assertCompleteFormulaUniverse(universe)
  const latestQuoteDate = allQuotes
    .map((item) => String(item?.tradeDate || ''))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort()
    .at(-1)
  const expectedDate = normalizedMode === 'close'
    ? latestQuoteDate || beijingDayKey(now)
    : beijingDayKey(now)
  const eligibleQuotes = allQuotes.filter((quote) =>
    passesAdaptiveRealtimePrefilter(quote, expectedDate)
  )
  const eligibleWithRecall = withRecallMetadata(
    eligibleQuotes.map((quote) => ({
      quote,
      cheapScore: cheapRank(quote, normalizedMode),
    })),
    normalizedMode,
  )
  const prefiltered = selectAdaptiveDeepCandidates(allQuotes, {
    mode: normalizedMode,
    expectedTradeDate: expectedDate,
    limit: 96,
  })
  const candidateEvents = new Map(
    eligibleWithRecall.map((item) => [
      String(item.quote.code),
      candidateEvent(item.quote, item.cheapScore, item.recall),
    ]),
  )
  for (const item of prefiltered) {
    const event = candidateEvents.get(String(item.quote.code))
    if (event) event.recall = item.recall
  }
  const selectedCodes = new Set(
    prefiltered.map((item) => String(item.quote.code)),
  )
  for (const event of candidateEvents.values()) {
    if (!selectedCodes.has(String(event.code))) {
      event.rejectionReasons = ['本轮未进入深度特征预算，保留为反事实样本']
    }
  }
  await report({
    stage: 'PREFILTER',
    percent: 24,
    message:
      `已读取${universe.inspectedCount || 0}只，`
      + `筛出${prefiltered.length}只进入形态检查`,
    counts: {
      total: universe.total || 0,
      inspected: universe.inspectedCount || 0,
      prefiltered: prefiltered.length,
    },
  })
  await report({
    stage: 'TECHNICAL',
    percent: 28,
    message: `正在检查${prefiltered.length}只股票的日线形态`,
    counts: {
      total: universe.total || 0,
      inspected: universe.inspectedCount || 0,
      prefiltered: prefiltered.length,
      technicalChecked: 0,
      technicalTotal: prefiltered.length,
    },
  })
  let technicalCompleted = 0
  const technicalCandidates = (await mapLimit(
    prefiltered,
    12,
    async ({ quote, cheapScore, recall }) => {
      let candidate = null
      const event = candidateEvents.get(String(quote.code))
      try {
        const kline = await fetchKline(quote.code, '101', 60)
          .catch(() => null)
        if (!kline?.candles?.length) {
          event.rejectionReasons = ['日线数据不可用']
          return null
        }
        const preliminary = evaluateFormulaSelection({
          mode: normalizedMode,
          candles: kline.candles,
          quote,
          trends: [],
          fund: {},
          sectorOpportunity: { matched: false },
        })
        event.stageReached = 'TECHNICAL'
        event.formulaEvaluations = preliminary.evaluations
        event.shadowFeatures = buildOpportunityShadowFeatures({
          quote,
          candles: kline.candles,
        })
        candidate = {
          quote,
          kline,
          preliminary,
          cheapScore,
          recall,
        }
        return candidate
      } finally {
        technicalCompleted += 1
        await report({
          stage: 'TECHNICAL',
          percent: prefiltered.length
            ? 28 + Math.floor(50 * technicalCompleted / prefiltered.length)
            : 78,
          message:
            `正在检查日线形态 ${technicalCompleted}/${prefiltered.length}`,
          counts: {
            total: universe.total || 0,
            inspected: universe.inspectedCount || 0,
            prefiltered: prefiltered.length,
            technicalChecked: technicalCompleted,
            technicalTotal: prefiltered.length,
          },
        })
      }
    },
  )).filter(Boolean)

  await report({
    stage: 'EVIDENCE',
    percent: 80,
    message:
      `${technicalCandidates.length}只进入分时、资金和板块复核`,
    counts: {
      total: universe.total || 0,
      inspected: universe.inspectedCount || 0,
      prefiltered: prefiltered.length,
      technicalCandidates: technicalCandidates.length,
    },
  })
  let evidenceCompleted = 0
  const evaluated = await mapLimit(
    technicalCandidates,
    8,
    async ({ quote, kline, cheapScore, recall }) => {
      const event = candidateEvents.get(String(quote.code))
      try {
        const [trendData, fund, tags] = await Promise.all([
          normalizedMode === 'intraday'
            ? fetchTrends(quote.code).catch(() => null)
            : Promise.resolve(null),
          fetchFund(quote.code, {
            preferRealtime: normalizedMode === 'intraday',
            fetchedAt: now,
          }).catch(() => null),
          fetchTags(quote.code).catch(() => null),
        ])
        event.stageReached = 'EVIDENCE'
        if (!fund || !tags) {
          event.rejectionReasons = [
            !fund ? '资金数据不可用' : null,
            !tags ? '板块标签不可用' : null,
          ].filter(Boolean)
          return null
        }
        const sectorOpportunity = matchSector({
          code: quote.code,
          profile: tags,
          latest: marketContext?.latest,
          intraday: marketContext?.intraday,
          now,
        })
        const formula = evaluateFormulaSelection({
          mode: normalizedMode,
          candles: kline.candles,
          quote,
          trends: trendData?.trends || [],
          fund,
          sectorOpportunity,
        })
        event.formulaEvaluations = formula.evaluations
        event.sector = sectorOpportunity?.sector || null
        event.shadowFeatures = buildOpportunityShadowFeatures({
          quote,
          candles: kline.candles,
          trends: trendData?.trends || [],
          fund,
          sectorOpportunity,
        })
        const shadowFeatures = buildOpportunityShadowFeatures({
          quote,
          candles: kline.candles,
          trends: trendData?.trends || [],
          fund,
          sectorOpportunity,
        })
        const opportunityContext = buildMarketOpportunityContext({
          marketGate: marketContext?.marketGate,
        })
        const planChoice = chooseAdaptivePricePlan({
          candidate: {
            code: quote.code,
            name: quote.name || kline.name || tags.name,
            quote,
            fund,
            sector: sectorOpportunity?.sector || null,
            sectorOpportunity,
            formulaId: formula.matches[0]?.formulaId || 'UNKNOWN',
            shadowFeatures,
          },
          candles: kline.candles,
          trends: trendData?.trends || [],
          marketContext: opportunityContext,
          now,
        })
        if (!planChoice.selected) {
          event.rejectionReasons = ['未形成合法且近期可达的交易路径']
          return null
        }
        const selectedPlan = planChoice.selected
        const adaptive = selectedPlan.adaptive
        const decision = adaptiveDecisionFromPlan(
          quote.code,
          formula,
          selectedPlan,
        )
        event.decision = decision
        event.playbookId = decision.playbookId
        event.counterfactualPlans = [
          selectedPlan,
          ...planChoice.alternatives,
        ].map((item) =>
          adaptiveDecisionFromPlan(quote.code, formula, item)
        )
        event.shadowFeatures = shadowFeatures
        event.rejectionReasons = uniqueReasons(decision.blockers || [])
        return {
          code: quote.code,
          name: quote.name || kline.name || tags.name,
          quote,
          cheapScore,
          recall,
          fund,
          tags,
          sectorOpportunity,
          formula,
          decision,
          adaptive,
          shadowFeatures,
          counterfactualPlans: event.counterfactualPlans,
          score: Number(adaptive.playbook?.score || 0),
        }
      } finally {
        evidenceCompleted += 1
        await report({
          stage: 'EVIDENCE',
          percent: technicalCandidates.length
            ? 80 + Math.floor(
                15 * evidenceCompleted / technicalCandidates.length
              )
            : 95,
          message:
            `正在复核资金与板块 ${evidenceCompleted}`
            + `/${technicalCandidates.length}`,
          counts: {
            total: universe.total || 0,
            inspected: universe.inspectedCount || 0,
            prefiltered: prefiltered.length,
            technicalCandidates: technicalCandidates.length,
            evidenceChecked: evidenceCompleted,
            evidenceTotal: technicalCandidates.length,
          },
        })
      }
    },
  )

  await report({
    stage: 'RANKING',
    percent: 97,
    message: '正在校验价位并生成最终观察顺序',
    counts: {
      total: universe.total || 0,
      inspected: universe.inspectedCount || 0,
      prefiltered: prefiltered.length,
      technicalCandidates: technicalCandidates.length,
    },
  })
  const validEvaluated = evaluated
    .filter(Boolean)
    .sort((left, right) =>
      right.score - left.score
      || Number(right.quote.amount || 0) - Number(left.quote.amount || 0)
      || String(left.code).localeCompare(String(right.code))
    )
  const selected = validEvaluated
    .sort((left, right) =>
      Number(right.adaptive?.utility ?? -Infinity)
        - Number(left.adaptive?.utility ?? -Infinity)
      || Number(right.score || 0) - Number(left.score || 0)
      || String(left.code).localeCompare(String(right.code))
    )
    .slice(0, 12)
  selected.forEach((item, index) => {
    const event = candidateEvents.get(String(item.code))
    event.stageReached = 'DISPLAYED'
    event.displayedRank = index + 1
  })
  const ranked = selected
    .map(publicCandidate)
  return {
    universe: {
      total: universe.total,
      inspectedCount: universe.inspectedCount,
      tradeDate: expectedDate,
      prefilterCount: prefiltered.length,
      technicalCandidateCount: technicalCandidates.length,
      formulaMatchCount: validEvaluated.length,
      displayedCount: ranked.length,
    },
    formulas: FORMULA_REGISTRY
      .filter((item) => item.mode === normalizedMode.toUpperCase())
      .map((item) => ({
        ...item,
        candidateCount: ranked.filter(
          (candidate) => candidate.formulaId === item.formulaId,
        ).length,
      })),
    candidates: ranked,
    candidateEvents: [...candidateEvents.values()],
  }
}

function accountData(account = {}) {
  return account?.data && typeof account.data === 'object'
    ? account.data
    : account
}

function holdingTechnicals(tech, candles) {
  return {
    stopLoss:
      finite(tech?.priceHints?.stopLoss)
      ?? finite(tech?.pricePlan?.stopLoss),
    support: finite(tech?.sr?.support),
    resistance: finite(tech?.sr?.resistance),
    ma10: finite(tech?.ma?.ma10),
    atr: finite(tech?.atr?.atr ?? tech?.atr),
    highestClose: candles.length
      ? Math.max(...candles.slice(-20).map((bar) => Number(bar.close) || 0))
      : null,
  }
}

export async function buildStockFormulaSelection({
  code,
  account,
  now = Date.now(),
  fetchQuote = async (value) => (await fetchQuotes([value]))[0] || null,
  fetchKline = fetchResilientKline,
  fetchTrends = fetchTrendsTx,
  fetchFund = fetchResilientStockFund,
  fetchTags = fetchStockTagProfile,
  collectMarketContext = collectTailPickMarketContext,
  matchSector = sectorOpportunityFromTags,
  computeTech = computeTechnicals,
} = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) {
    throw new Error('股票代码无效')
  }
  const [quote, kline, trendData, fund, tags, marketContext] =
    await Promise.all([
      fetchQuote(code),
      fetchKline(code, '101', 80),
      fetchTrends(code).catch(() => null),
      fetchFund(code, {
        preferRealtime: isContinuousTrading(now),
        fetchedAt: now,
      }).catch(() => null),
      fetchTags(code).catch(() => null),
      collectMarketContext({ now }).catch(() => ({
        marketGate: { allowed: false, blockers: ['市场环境暂缺'] },
        latest: null,
        intraday: null,
      })),
    ])
  if (!quote?.price || !kline?.candles?.length) {
    throw new Error('个股关键行情不完整')
  }
  const data = accountData(account)
  const holding = livePositionOf(data.holding || [], code)
  const t1 = holding
    ? t1StatusOf(data.holding || [], data.closed || [], code, now)
    : null
  const sectorOpportunity = matchSector({
    code,
    profile: tags || {},
    latest: marketContext.latest,
    intraday: marketContext.intraday,
    now,
  })
  const mode = isContinuousTrading(now) ? 'intraday' : 'close'
  const formula = evaluateFormulaSelection({
    mode,
    candles: kline.candles,
    quote,
    trends: trendData?.trends || [],
    fund,
    sectorOpportunity,
  })
  const tech = computeTech(kline.candles)
  const klineStale = kline.stale === true
  const decision = buildFormulaPriceDecision({
    code,
    quote,
    formulaMatches: formula.matches,
    positionMode: holding ? 'HELD' : 'UNOWNED',
    holding,
    t1Status: t1
      ? {
          sellableQty: t1.sellableToday,
          lockedQty: t1.boughtToday,
        }
      : null,
    technicals: holdingTechnicals(tech, kline.candles),
    fund,
    marketAllowsRisk: marketContext.marketGate?.allowed === true,
    marketBlockers: marketContext.marketGate?.blockers || [],
    dataComplete: holding
      ? !!tech
      : !!fund && !!tags && !!tech,
    dataFresh: !klineStale,
    now,
  })
  const advisorReference = buildFormulaEvidenceReference(decision, {
    validationState: 'OBSERVE_ONLY',
    sampleSize: 0,
  })
  return {
    schemaVersion: 'formula-price-decision.v1',
    generatedAt: now,
    dataAsOf: Number(kline.fetchedAt) || now,
    stale: klineStale,
    quote,
    formula,
    decision,
    advisorReference,
  }
}
