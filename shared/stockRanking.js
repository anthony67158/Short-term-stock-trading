const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const finite = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function stockPickSession(now = Date.now()) {
  const beijing = new Date(Number(now) + 8 * 3600000)
  const weekday = beijing.getUTCDay()
  const minute = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  const trading = weekday >= 1 && weekday <= 5 && minute >= 555 && minute <= 901
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

function scoreOf(stock) {
  const mainRatio = finite(stock.mainRatio)
  const mainInflowYi = finite(stock.mainInflow) / 1e8
  const fund = Math.max(
    clamp((mainRatio + 3) / 18),
    clamp(Math.log10(Math.max(mainInflowYi, 0) + 1) / Math.log10(8))
  )
  const volume = peak(finite(stock.volRatio), 0.5, 2.2, 8)
  const momentum = peak(finite(stock.pct), -3, 3.5, 8.8)
  const speed = clamp((finite(stock.speed) + 0.2) / 1.6)
  const liquidity = clamp(
    Math.log10(Math.max(finite(stock.amount), 1) / 8e7) / Math.log10(25)
  )
  const turnover = peak(finite(stock.turnover), 0.4, 6, 25)
  const score = fund * 30 + volume * 15 + momentum * 15 +
    speed * 10 + liquidity * 15 + turnover * 15
  const reasons = []
  if (fund >= 0.6) reasons.push('主力资金')
  if (volume >= 0.55) reasons.push('量能放大')
  if (momentum >= 0.6) reasons.push('位置适中')
  if (liquidity >= 0.55) reasons.push('流动性好')
  return { score: +clamp(score, 0, 100).toFixed(1), reasons }
}

function isEligible(stock, options) {
  const name = String(stock.name || '')
  const code = String(stock.code || '')
  const price = finite(stock.price)
  const amount = finite(stock.amount)
  const pct = finite(stock.pct)
  const turnover = finite(stock.turnover)
  const volRatio = finite(stock.volRatio)
  if (!/^\d{6}$/.test(code) || !name || /(?:\*?ST|退市|退$)/i.test(name)) return false
  if (!(price > 0) || amount < options.minAmount) return false
  if (pct < options.minPct || pct > options.maxPct) return false
  if (turnover < options.minTurnover || turnover > options.maxTurnover) return false
  if (volRatio < options.minVolRatio || volRatio > options.maxVolRatio) return false
  return true
}

export function rankMarketCandidates(rows, opts = {}) {
  const options = {
    limit: Math.max(1, Math.min(50, Number(opts.limit) || 30)),
    minAmount: Number(opts.minAmount) || 8e7,
    minPct: opts.minPct == null ? -6 : Number(opts.minPct),
    maxPct: opts.maxPct == null ? 8.8 : Number(opts.maxPct),
    minTurnover: opts.minTurnover == null ? 0.4 : Number(opts.minTurnover),
    maxTurnover: opts.maxTurnover == null ? 25 : Number(opts.maxTurnover),
    minVolRatio: opts.minVolRatio == null ? 0.5 : Number(opts.minVolRatio),
    maxVolRatio: opts.maxVolRatio == null ? 8 : Number(opts.maxVolRatio),
  }
  const universe = Array.isArray(rows) ? rows : []
  const eligible = universe.filter((stock) => isEligible(stock, options))
  const list = eligible.map((stock) => {
    const ranked = scoreOf(stock)
    return { ...stock, marketScore: ranked.score, reasons: ranked.reasons }
  }).sort((a, b) =>
    b.marketScore - a.marketScore ||
    finite(b.amount) - finite(a.amount) ||
    String(a.code).localeCompare(String(b.code))
  ).slice(0, options.limit)
  return { universeCount: universe.length, eligibleCount: eligible.length, list }
}

export function rerankQuantCandidates(candidates, opts = {}) {
  const limit = Math.max(1, Math.min(30, Number(opts.limit) || 12))
  return (Array.isArray(candidates) ? candidates : []).map((item) => {
    const quant = item.quant || {}
    const marketScore = clamp(finite(item.marketScore), 0, 100)
    const quantScore = clamp(finite(quant.score, 45), 0, 100)
    const upProb = clamp(finite(quant.upProb, 50), 0, 100)
    const expScore = clamp((finite(quant.expRet) + 5) * 10, 0, 100)
    const highConfidenceBonus = quant.highConfFired ? 5 : 0
    const combinedScore = clamp(
      marketScore * 0.4 +
      quantScore * 0.35 +
      upProb * 0.15 +
      expScore * 0.1 +
      highConfidenceBonus,
      0,
      100
    )
    return { ...item, combinedScore: +combinedScore.toFixed(1) }
  }).sort((a, b) =>
    b.combinedScore - a.combinedScore ||
    finite(b.marketScore) - finite(a.marketScore) ||
    String(a.code).localeCompare(String(b.code))
  ).slice(0, limit)
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
    ...(item.tags || []).slice(0, 2),
  ].filter(Boolean)
  const buyPoint = buyLow != null && buyHigh != null
    ? `等待回踩${buyLow}~${buyHigh}缩量企稳${breakout != null ? `，或放量突破${breakout}后再评估` : ''}`
    : '等待回踩企稳或放量突破后再评估，不在加速段追入'

  return {
    rank: index + 1,
    code: String(item.code),
    name: item.name || String(item.code),
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
  const picks = (Array.isArray(result.picks) ? result.picks : [])
    .filter((item) => item && allowed.has(String(item.code || '')))
    .slice(0, 3)
    .map((item, index) => {
      const requested = ['可执行', '等待触发', '观察'].includes(item.actionability)
        ? item.actionability
        : null
      return {
        ...item,
        rank: index + 1,
        actionability: result.noTrade === true
          ? (requested === '观察' ? '观察' : '等待触发')
          : (requested || '可执行'),
      }
    })
  if (picks.length > 0) {
    return {
      ...result,
      noTrade: result.noTrade === true,
      noTradeReason: result.noTrade === true ? (result.noTradeReason || '当前没有立即买点') : '',
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
        fallbackReason: result.noTradeReason || 'AI未形成主动出手结论，已展示确定性条件候选',
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
