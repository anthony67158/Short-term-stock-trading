const finite = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const clamp = (value, low = 0, high = 100) =>
  Math.min(high, Math.max(low, value))

const rounded = (value, digits = 1) =>
  Number(Number(value).toFixed(digits))

export const WATCHLIST_RANKING_WEIGHTS = Object.freeze({
  quant: 0.55,
  proximity: 0.45,
})

const BUY_ADVICE_PRIORITY = Object.freeze({
  ready_buy: { score: 7, label: '现在买入' },
  ready_probe: { score: 6, label: '小仓试错' },
  now: { score: 5, label: '立即买入' },
  conditional_buy: { score: 5, label: '条件买入' },
  pullback: { score: 4, label: '回调再买' },
  conditional_probe: { score: 4, label: '条件试仓' },
  probe: { score: 3, label: '小仓试错' },
  unknown: { score: 2, label: '尚无建议' },
  wait: { score: 1, label: '观望' },
  avoid: { score: 0, label: '不建议' },
})

// 决策计划（decision-plan.v2）是卡片实际展示的权威动作，排序必须与它一致：
// 能立即买入 > 立即小仓试错 > 条件买入 > 条件试仓 > 尚无建议 > 观望 > 不建议。
function decisionPlanBuyPriority(advice) {
  const plan = advice?.decisionPlan?.schemaVersion === 'decision-plan.v2'
    ? advice.decisionPlan
    : null
  if (!plan) return null
  const ability = String(plan.actionability || '')
  if (ability === 'BLOCKED') return 'avoid'
  const policy = plan.actionPolicy || {}
  const state = String(policy.entryIntent?.state || '')
  if (state === 'READY_BUY') return 'ready_buy'
  if (state === 'READY_PROBE') return 'ready_probe'
  if (state === 'CONDITIONAL_BUY') return 'conditional_buy'
  if (state === 'CONDITIONAL_PROBE') return 'conditional_probe'
  if (state === 'WATCH_ONLY') return 'wait'
  // entryIntent 缺失时退回按可执行性与风险档位判断。
  if (ability === 'READY') {
    return policy.canIncreaseRisk === true ? 'ready_buy' : 'conditional_buy'
  }
  if (ability === 'MANUAL_PROBE') {
    return policy.canIncreaseRisk === true ? 'ready_probe' : 'conditional_probe'
  }
  if (ability === 'WATCH') return 'wait'
  if (ability === 'RESEARCH_ONLY') return 'wait'
  return null
}

export function watchlistAdvicePriority(entry) {
  const advice = entry?.advice || entry
  if (!advice || typeof advice !== 'object') {
    return { key: 'unknown', ...BUY_ADVICE_PRIORITY.unknown }
  }
  const planKey = decisionPlanBuyPriority(advice)
  if (planKey) {
    return { key: planKey, ...BUY_ADVICE_PRIORITY[planKey] }
  }
  const tier = String(advice.tier || '').trim().toLowerCase()
  if (BUY_ADVICE_PRIORITY[tier]) {
    return { key: tier, ...BUY_ADVICE_PRIORITY[tier] }
  }
  const action = String(advice.action || advice.stance || '').trim()
  let key = 'unknown'
  if (/不建议|回避|放弃/.test(action)) key = 'avoid'
  else if (/观望|等待|暂不/.test(action)) key = 'wait'
  else if (/小仓|试错|试仓/.test(action)) key = 'probe'
  else if (/回调|回踩|低吸/.test(action)) key = 'pullback'
  else if (/立即|现在|马上|买入|建仓/.test(action)) key = 'now'
  return { key, ...BUY_ADVICE_PRIORITY[key] }
}

export function watchlistReadiness(candidate = {}, quote = {}) {
  const quantScore = clamp(finite(candidate.qScore) ?? 45)
  const currentPrice = finite(quote.price)
  const entryPrice = finite(
    candidate.targetPrice
      ?? candidate.entryPrice
      ?? candidate.buyPrice,
  )

  if (!(currentPrice > 0) || !(entryPrice > 0)) {
    return {
      score: rounded(quantScore * WATCHLIST_RANKING_WEIGHTS.quant),
      quantScore: rounded(quantScore),
      proximityScore: null,
      distancePct: null,
      entryPrice: entryPrice > 0 ? entryPrice : null,
      status: 'unknown',
      label: '等待买入价',
    }
  }

  const distancePct = ((currentPrice - entryPrice) / entryPrice) * 100
  let proximityScore
  if (distancePct >= 0) {
    proximityScore = clamp(100 - (distancePct / 8) * 100)
  } else {
    const belowPct = Math.abs(distancePct)
    if (belowPct <= 1) proximityScore = 100 - belowPct * 5
    else if (belowPct <= 5) proximityScore = 95 - (belowPct - 1) * 8.75
    else proximityScore = clamp(60 - (belowPct - 5) * 10)
  }

  let status = 'waiting'
  let label = `距买入价 ${distancePct.toFixed(1)}%`
  if (Math.abs(distancePct) <= 0.35) {
    status = 'reached'
    label = '已到买点'
  } else if (distancePct > 0 && distancePct <= 2) {
    status = 'near'
    label = `临近买点 · 高 ${distancePct.toFixed(1)}%`
  } else if (distancePct < -5) {
    status = 'broken'
    label = `跌穿买点 ${Math.abs(distancePct).toFixed(1)}% · 需复核`
  } else if (distancePct < 0) {
    status = 'reached'
    label = `已进入买入区 · 低 ${Math.abs(distancePct).toFixed(1)}%`
  }

  const score = (
    quantScore * WATCHLIST_RANKING_WEIGHTS.quant
    + proximityScore * WATCHLIST_RANKING_WEIGHTS.proximity
  )
  return {
    score: rounded(score),
    quantScore: rounded(quantScore),
    proximityScore: rounded(proximityScore),
    distancePct: rounded(distancePct, 2),
    entryPrice,
    status,
    label,
  }
}

export function rankWatchlistCandidates(
  candidates = [],
  quotes = {},
  adviceByCode = {},
) {
  return candidates.map((candidate, index) => ({
    ...candidate,
    advicePriority: watchlistAdvicePriority(
      adviceByCode[candidate.code],
    ),
    readiness: watchlistReadiness(
      candidate,
      quotes[candidate.code] || {},
    ),
    _rankingIndex: index,
  })).sort((left, right) => {
    if (Boolean(left.star) !== Boolean(right.star)) {
      return left.star ? -1 : 1
    }
    if (left.advicePriority.score !== right.advicePriority.score) {
      return right.advicePriority.score - left.advicePriority.score
    }
    if (left.readiness.score !== right.readiness.score) {
      return right.readiness.score - left.readiness.score
    }
    const leftProximity = left.readiness.proximityScore ?? -1
    const rightProximity = right.readiness.proximityScore ?? -1
    if (leftProximity !== rightProximity) {
      return rightProximity - leftProximity
    }
    if (left.readiness.quantScore !== right.readiness.quantScore) {
      return right.readiness.quantScore - left.readiness.quantScore
    }
    return left._rankingIndex - right._rankingIndex
  }).map(({ _rankingIndex, ...candidate }) => candidate)
}
