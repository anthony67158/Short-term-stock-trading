import { isQualifiedConceptLeader } from './conceptLeadership.js'
import {
  isQualifiedInvestmentCandidate,
} from './investmentSelection.js'
import { isStockPickSession } from './tradingCalendar.js'

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const finite = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export const CANDIDATE_RANKING_VERSION = 'candidate-ranking.v1'

const DEFAULT_RANKING_POLICY = Object.freeze({
  universe: {
    excludeSt: true,
    minimumListingDays: 20,
    minimumAmount: 8e7,
  },
  marketRanking: {
    filters: {
      minPct: -6,
      maxPct: 8.8,
      minTurnover: 0.4,
      maxTurnover: 25,
      minVolRatio: 0.5,
      maxVolRatio: 8,
    },
    factorWeights: {
      fund: 0.3,
      volume: 0.15,
      momentum: 0.15,
      speed: 0.1,
      liquidity: 0.15,
      turnover: 0.15,
    },
    factors: {
      fund: {
        mainRatioFloor: -3,
        mainRatioSpan: 18,
        inflowScaleYi: 7,
      },
      volume: { left: 0.5, ideal: 2.2, right: 8 },
      momentum: { left: -3, ideal: 3.5, right: 8.8 },
      speed: { floor: -0.2, span: 1.6 },
      liquidity: { amountMultiple: 25 },
      turnover: { left: 0.4, ideal: 6, right: 25 },
    },
  },
  score: {
    weights: {
      marketScore: 0.4,
      quantScore: 0.35,
      upProb: 0.15,
      expectedReturn: 0.1,
    },
    bonuses: { highConfidence: 5 },
    normalization: {
      expectedReturnMin: -5,
      expectedReturnMax: 5,
    },
  },
})

export function stockPickSession(now = Date.now()) {
  const trading = isStockPickSession(now)
  return {
    canRun: true,
    trading,
    mode: trading ? 'intraday' : 'next_open',
  }
}

export function stockPickSavedLabel({
  savedDay,
  currentDay,
  savedSession,
  trading,
  timeText,
} = {}) {
  if (!timeText) return ''
  if (savedSession === 'next_open') {
    return `开盘观察池 ${timeText} 生成，供下一交易日开盘参考`
  }
  if (savedDay === currentDay) {
    return trading
      ? `本次选股 ${timeText}，结果已保留`
      : `今日盘中 ${timeText} 选出，供下一交易日开盘参考`
  }
  return `${timeText} 选出(非今日，仅供参考)`
}

export function marketPageNumbers(total, pageSize = 100) {
  const pages = Math.max(1, Math.ceil(Math.max(0, finite(total)) / Math.max(1, finite(pageSize, 100))))
  return Array.from({ length: pages }, (_, index) => index + 1)
}

function peak(value, left, ideal, right) {
  if (value <= left || value >= right) return 0
  if (value <= ideal) return (value - left) / (ideal - left)
  return (right - value) / (right - ideal)
}

function resolvedPolicy(opts = {}) {
  const input = structuredClone(DEFAULT_RANKING_POLICY)
  const legacyFilters = {
    minPct: opts.minPct,
    maxPct: opts.maxPct,
    minTurnover: opts.minTurnover,
    maxTurnover: opts.maxTurnover,
    minVolRatio: opts.minVolRatio,
    maxVolRatio: opts.maxVolRatio,
  }
  if (opts.minAmount != null) {
    input.universe.minimumAmount = Number(opts.minAmount)
  }
  for (const [key, value] of Object.entries(legacyFilters)) {
    if (value != null) input.marketRanking.filters[key] = Number(value)
  }
  return input
}

function scoreOf(stock, policy) {
  const ranking = policy.marketRanking
  const factors = ranking.factors
  const weights = ranking.factorWeights
  const mainRatio = finite(stock.mainRatio)
  const mainInflowYi = finite(stock.mainInflow) / 1e8
  const fund = Math.max(
    clamp(
      (mainRatio - factors.fund.mainRatioFloor)
        / factors.fund.mainRatioSpan
    ),
    clamp(
      Math.log10(Math.max(mainInflowYi, 0) + 1)
        / Math.log10(factors.fund.inflowScaleYi + 1)
    )
  )
  const volume = peak(
    finite(stock.volRatio),
    factors.volume.left,
    factors.volume.ideal,
    factors.volume.right,
  )
  const momentum = peak(
    finite(stock.pct),
    factors.momentum.left,
    factors.momentum.ideal,
    factors.momentum.right,
  )
  const speed = clamp(
    (finite(stock.speed) - factors.speed.floor) / factors.speed.span
  )
  const liquidity = clamp(
    Math.log10(
      Math.max(finite(stock.amount), 1)
        / policy.universe.minimumAmount
    ) / Math.log10(factors.liquidity.amountMultiple)
  )
  const turnover = peak(
    finite(stock.turnover),
    factors.turnover.left,
    factors.turnover.ideal,
    factors.turnover.right,
  )
  const score = (
    fund * weights.fund
    + volume * weights.volume
    + momentum * weights.momentum
    + speed * weights.speed
    + liquidity * weights.liquidity
    + turnover * weights.turnover
  ) * 100
  const reasons = []
  if (fund >= 0.6) reasons.push('主力资金')
  if (volume >= 0.55) reasons.push('量能放大')
  if (momentum >= 0.6) reasons.push('位置适中')
  if (liquidity >= 0.55) reasons.push('流动性好')
  return { score: +clamp(score, 0, 100).toFixed(1), reasons }
}

function isEligible(stock, policy) {
  const filters = policy.marketRanking.filters
  const name = String(stock.name || '')
  const code = String(stock.code || '')
  const price = finite(stock.price)
  const amount = finite(stock.amount)
  const pct = finite(stock.pct)
  const turnover = finite(stock.turnover)
  const volRatio = finite(stock.volRatio)
  if (!/^\d{6}$/.test(code) || !name || /(?:退市|退$)/i.test(name)) return false
  if (policy.universe.excludeSt && /(?:\*?ST)/i.test(name)) return false
  if (!(price > 0) || amount < policy.universe.minimumAmount) return false
  if (
    stock.listingDays != null
    && finite(stock.listingDays) < policy.universe.minimumListingDays
  ) return false
  if (pct < filters.minPct || pct > filters.maxPct) return false
  if (turnover < filters.minTurnover || turnover > filters.maxTurnover) return false
  if (volRatio < filters.minVolRatio || volRatio > filters.maxVolRatio) return false
  return true
}

export function evaluateMarketCandidate(stock, opts = {}) {
  const policy = resolvedPolicy(opts)
  const ranked = scoreOf(stock || {}, policy)
  return {
    ...(stock || {}),
    marketScore: ranked.score,
    reasons: ranked.reasons,
    marketEligible: isEligible(stock || {}, policy),
  }
}

export function rankMarketCandidates(rows, opts = {}) {
  const policy = resolvedPolicy(opts)
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 30))
  const universe = Array.isArray(rows) ? rows : []
  const eligible = universe.filter((stock) => isEligible(stock, policy))
  const list = eligible.map((stock) => {
    const ranked = scoreOf(stock, policy)
    return {
      ...stock,
      marketScore: ranked.score,
      reasons: ranked.reasons,
      marketEligible: true,
    }
  }).sort((a, b) =>
    b.marketScore - a.marketScore ||
    finite(b.amount) - finite(a.amount) ||
    String(a.code).localeCompare(String(b.code))
  ).slice(0, limit)
  return {
    rankingVersion: CANDIDATE_RANKING_VERSION,
    universeCount: universe.length,
    eligibleCount: eligible.length,
    list,
  }
}

function entrySignal(item) {
  const matchedRules = []
  const failedRules = []
  const checks = [
    ['市场分至少55', finite(item.marketScore) >= 55],
    ['量化分至少55', finite(item.quant?.score) >= 55],
    ['涨跌幅位于-6%至8.8%', finite(item.pct) >= -6 && finite(item.pct) <= 8.8],
    ['量比位于0.5至8', finite(item.volRatio) >= 0.5 && finite(item.volRatio) <= 8],
  ]
  for (const [rule, passed] of checks) {
    ;(passed ? matchedRules : failedRules).push(rule)
  }
  return {
    passed: failedRules.length === 0,
    matchedRules,
    failedRules,
  }
}

export function rankCandidateShortlist(candidates, opts = {}) {
  const policy = resolvedPolicy(opts)
  const limit = Math.max(1, Math.min(30, Number(opts.limit) || 12))
  const weights = policy.score.weights
  const normalization = policy.score.normalization
  const range = normalization.expectedReturnMax
    - normalization.expectedReturnMin
  const ranked = (Array.isArray(candidates) ? candidates : []).map((item) => {
    const quant = item.quant || {}
    const marketScore = clamp(finite(item.marketScore), 0, 100)
    const quantScore = clamp(finite(quant.score, 45), 0, 100)
    const upProb = clamp(finite(quant.upProb, 50), 0, 100)
    const expScore = clamp(
      (
        finite(quant.expRet) - normalization.expectedReturnMin
      ) / range * 100,
      0,
      100,
    )
    const highConfidenceBonus = quant.highConfFired
      ? policy.score.bonuses.highConfidence
      : 0
    const combinedScore = clamp(
      marketScore * weights.marketScore +
      quantScore * weights.quantScore +
      upProb * weights.upProb +
      expScore * weights.expectedReturn +
      highConfidenceBonus,
      0,
      100
    )
    const investmentScore = isQualifiedInvestmentCandidate(item)
      ? clamp(
          finite(item.investmentProfile?.investmentScore, 35),
          0,
          100,
        )
      : 35
    const attentionScore = clamp(
      combinedScore * 0.72 + investmentScore * 0.28,
      0,
      100,
    )
    const resolvedEntrySignal = entrySignal(item)
    return {
      ...item,
      combinedScore: +combinedScore.toFixed(1),
      attentionScore: +attentionScore.toFixed(1),
      entrySignal: resolvedEntrySignal,
    }
  }).sort((a, b) =>
    b.attentionScore - a.attentionScore ||
    b.combinedScore - a.combinedScore ||
    finite(b.marketScore) - finite(a.marketScore) ||
    String(a.code).localeCompare(String(b.code))
  )
  const passed = ranked.filter((item) => item.entrySignal.passed)
  const failed = ranked.filter((item) => !item.entrySignal.passed)
  const leadershipReserve = Math.max(
    0,
    Math.min(limit, Number(opts.leadershipReserve) || 0),
  )
  const selected = [...passed, ...failed].slice(0, limit)
  const reservedLeaders = ranked
    .filter(isQualifiedConceptLeader)
    .slice(0, leadershipReserve)
  for (const leader of reservedLeaders) {
    if (selected.some((item) => item.code === leader.code)) continue
    const replaceIndex = selected.findLastIndex(
      (item) => !isQualifiedConceptLeader(item),
    )
    if (replaceIndex < 0) break
    selected[replaceIndex] = leader
  }
  const investmentReserve = Math.max(
    0,
    Math.min(limit, Number(opts.investmentReserve) || 0),
  )
  const reservedInvestments = ranked
    .filter(isQualifiedInvestmentCandidate)
    .slice(0, investmentReserve)
  for (const candidate of reservedInvestments) {
    if (selected.some((item) => item.code === candidate.code)) continue
    const replaceIndex = selected.findLastIndex(
      (item) =>
        !isQualifiedInvestmentCandidate(item)
        && !isQualifiedConceptLeader(item),
    )
    if (replaceIndex < 0) break
    selected[replaceIndex] = candidate
  }
  selected.sort((left, right) =>
    Number(right.entrySignal.passed)
      - Number(left.entrySignal.passed)
    || right.attentionScore - left.attentionScore
    || right.combinedScore - left.combinedScore
    || String(left.code).localeCompare(String(right.code))
  )
  const executable = selected.filter(
    (item) => item.entrySignal.passed,
  )
  const watchlist = selected.filter(
    (item) => !item.entrySignal.passed,
  )
  return {
    rankingVersion: CANDIDATE_RANKING_VERSION,
    signalPassedCount: passed.length,
    leadershipReservedCount: selected.filter(
      isQualifiedConceptLeader,
    ).length,
    investmentReservedCount: selected.filter(
      isQualifiedInvestmentCandidate,
    ).length,
    executable,
    watchlist,
    list: selected,
  }
}

export function rerankQuantCandidates(candidates, opts = {}) {
  return rankCandidateShortlist(candidates, opts).list
}

function price(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function roundedPrice(value) {
  const number = price(value)
  if (number == null) return null
  return +(number < 10 ? number.toFixed(3) : number.toFixed(2))
}

function conditionalFallback(item, index, noTradeReason) {
  const quant = item.quant || {}
  const current = price(item.price)
  const reference = price(quant.buyPrice) || current
  const buyLow = reference != null
    ? roundedPrice(reference * 0.995)
    : null
  const buyHigh = reference != null
    ? roundedPrice(reference * 1.005)
    : null
  const breakout = current != null
    ? roundedPrice(current * 1.015)
    : null
  const target = roundedPrice(
    price(quant.takeProfit)
    || price(quant.targetHigh)
    || (current != null ? current * 1.04 : null)
  )
  const stop = roundedPrice(
    price(quant.stopLoss)
    || (current != null ? current * 0.97 : null)
  )
  const evidence = [
    item.combinedScore != null ? `综合分${item.combinedScore}` : '',
    item.marketScore != null ? `市场分${item.marketScore}` : '',
    quant.score != null ? `量化${quant.score}` : '',
    quant.upProb != null ? `方向概率${quant.upProb}%` : '',
    item.mainInflowYi != null ? `主力净流入${item.mainInflowYi}亿` : '',
    item.investmentProfile?.investmentScore != null
      ? `产业价值${item.investmentProfile.investmentScore}`
      : '',
    ...(item.tags || []).slice(0, 2),
  ].filter(Boolean)
  const buyPoint = buyLow != null && buyHigh != null
    ? `等待回踩${buyLow}~${buyHigh}缩量企稳${breakout != null ? `，或放量突破${breakout}后再评估` : ''}`
    : '等待回踩企稳或放量突破后再评估，不在加速段追入'

  return {
    rank: index + 1,
    code: String(item.code),
    name: item.name || String(item.code),
    conceptLeadership: item.conceptLeadership || null,
    investmentProfile: item.investmentProfile || null,
    quantScore: quant.score ?? null,
    grade: '观察',
    actionability: '等待触发',
    reason: evidence.join(' · ') || '确定性候选池排名靠前',
    buyPoint,
    buyZone: buyLow != null && buyHigh != null ? `${buyLow}~${buyHigh}` : null,
    target,
    stop,
    risk: noTradeReason || '当前确认信号不足，只在触发条件成立后考虑',
  }
}

export function normalizePickDecision(value, allowedCodes = [], fallbackCandidates = []) {
  const result = value && typeof value === 'object' ? { ...value } : {}
  const allowed = new Set((allowedCodes || []).map(String))
  const candidates = new Map(
    (fallbackCandidates || []).map((item) => [String(item?.code || ''), item])
  )
  const picks = (Array.isArray(result.picks) ? result.picks : [])
    .filter((item) => item && allowed.has(String(item.code || '')))
    .slice(0, 3)
    .map((item, index) => {
      const candidate = candidates.get(String(item.code))
      const requested = ['可执行', '等待触发', '观察'].includes(item.actionability)
        ? item.actionability
        : null
      return {
        ...item,
        rank: index + 1,
        conceptLeadership: candidate?.conceptLeadership || null,
        investmentProfile: candidate?.investmentProfile || null,
        actionability: (
          result.noTrade === true
          || candidate?.entrySignal?.passed === false
        )
          ? (requested === '观察' ? '观察' : '等待触发')
          : (requested || '可执行'),
      }
    })
  if (picks.length > 0) {
    const noTrade = result.noTrade === true
      || picks.every((item) => item.actionability !== '可执行')
    return {
      ...result,
      noTrade,
      noTradeReason: noTrade
        ? (
            result.noTradeReason
            || '候选的量价与量化确认不足，仅保留观察'
          )
        : '',
      picks,
    }
  }
  {
    const fallback = (Array.isArray(fallbackCandidates) ? fallbackCandidates : [])
      .filter((item) => item && allowed.has(String(item.code || '')))
      .slice(0, 3)
      .map((item, index) => conditionalFallback(item, index, result.noTradeReason))
    if (fallback.length) {
      return {
        ...result,
        noTrade: true,
        noTradeReason: result.noTradeReason || '当前没有立即买点，以下为条件候选',
        fallback: true,
        fallbackReason: result.noTradeReason || '研判未形成主动出手结论，已展示确定性条件候选',
        picks: fallback,
      }
    }
    return {
      ...result,
      noTrade: true,
      noTradeReason: result.noTradeReason || '候选池中没有同时通过把握与赔率要求的标的',
      picks: [],
    }
  }
}

export function normalizeStoredPickSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.result) return snapshot
  const shortlist = Array.isArray(snapshot.shortlist) ? snapshot.shortlist : []
  if (!shortlist.length) {
    const picks = Array.isArray(snapshot.result.picks) ? snapshot.result.picks : []
    return picks.length
      ? snapshot
      : { ...snapshot, result: null, legacyEmpty: true }
  }
  return {
    ...snapshot,
    result: normalizePickDecision(
      snapshot.result,
      shortlist.map((item) => item?.code).filter(Boolean),
      shortlist,
    ),
  }
}
