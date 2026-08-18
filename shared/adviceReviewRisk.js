function finite(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function quotePrice(snapshot = {}) {
  return finite(snapshot?.evidence?.quote?.price)
}

function atrValue(snapshot = {}) {
  const atr = snapshot?.evidence?.technical?.indicators?.atr
  return finite(atr?.atr ?? atr)
}

function executionLevels(advice = {}) {
  return [
    { key: 'stop', label: '止损位', price: finite(advice.stopPrice) },
    {
      key: 'target',
      label: advice.reducePrice != null ? '减仓位' : '目标位',
      price: finite(advice.reducePrice ?? advice.targetPrice),
    },
    {
      key: 'entry',
      label: advice.addPrice != null ? '加仓位' : '买入位',
      price: finite(advice.addPrice ?? advice.buyPrice),
    },
  ].filter((item) => item.price != null)
}

function distancePct(price, level) {
  if (!(price > 0) || !(level > 0)) return Infinity
  return Math.abs(price / level - 1) * 100
}

export function adviceReviewRisk({
  snapshot,
  advice,
} = {}) {
  const price = quotePrice(snapshot)
  if (!(price > 0) || !advice) {
    return { level: 'normal', reasons: [], price, atrPct: null }
  }
  const atr = atrValue(snapshot)
  const atrPct = atr != null && price > 0 ? atr / price * 100 : null
  const urgentDistancePct = clamp((atrPct ?? 1.2) * 0.35, 0.35, 0.8)
  const elevatedDistancePct = clamp((atrPct ?? 1.2) * 0.75, 0.8, 1.5)
  const urgent = []
  const elevated = []

  for (const level of executionLevels(advice)) {
    const distance = distancePct(price, level.price)
    if (level.key === 'stop' && price <= level.price) {
      urgent.push(`现价已触及${level.label}${level.price}`)
    } else if (level.key === 'target' && price >= level.price) {
      urgent.push(`现价已触及${level.label}${level.price}`)
    } else if (distance <= urgentDistancePct) {
      urgent.push(`现价距离${level.label}${distance.toFixed(2)}%`)
    } else if (distance <= elevatedDistancePct) {
      elevated.push(`现价接近${level.label}`)
    }
  }

  const quotePct = Math.abs(finite(snapshot?.evidence?.quote?.pct) ?? 0)
  if (quotePct >= 7) urgent.push(`当日波动${quotePct.toFixed(1)}%`)
  else if (quotePct >= 4) elevated.push(`当日波动${quotePct.toFixed(1)}%`)

  const resonance = snapshot?.evidence?.decisionSignals?.resonance || {}
  if (resonance.hasNegNews === true && finite(resonance.score) <= 1) {
    urgent.push('利空与低共振同时出现')
  }

  if (urgent.length) {
    return { level: 'urgent', reasons: urgent.slice(0, 4), price, atrPct }
  }
  if (elevated.length) {
    return { level: 'elevated', reasons: elevated.slice(0, 4), price, atrPct }
  }
  return { level: 'normal', reasons: [], price, atrPct }
}

export function adaptiveAdviceReviewInterval({
  mode = 'buy_advice',
  configuredIntervalMin,
  snapshot,
  advice,
} = {}) {
  const fallback = mode === 'hold_advice' ? 15 : 30
  const parsed = finite(configuredIntervalMin)
  const configured = clamp(
    parsed == null ? fallback : Math.trunc(parsed),
    5,
    240,
  )
  const risk = adviceReviewRisk({ snapshot, advice })
  const intervalMin = risk.level === 'urgent'
    ? Math.min(configured, 5)
    : risk.level === 'elevated'
      ? Math.min(configured, mode === 'hold_advice' ? 10 : 15)
      : configured
  return {
    configuredIntervalMin: configured,
    intervalMin,
    riskLevel: risk.level,
    riskReasons: risk.reasons,
  }
}

export function reviewPriceMateriality({
  previous,
  current,
  previousAdvice,
} = {}) {
  const previousPrice = finite(previous?.quote?.price)
  const currentPrice = finite(current?.quote?.price)
  if (!(previousPrice > 0) || !(currentPrice > 0)) {
    return { changed: false, reason: '' }
  }

  for (const level of executionLevels(previousAdvice)) {
    if (
      level.key === 'stop'
      && previousPrice > level.price
      && currentPrice <= level.price
    ) {
      return {
        changed: true,
        reason: `现价已跌破上一版止损位${level.price}`,
      }
    }
    if (
      level.key === 'target'
      && previousPrice < level.price
      && currentPrice >= level.price
    ) {
      return {
        changed: true,
        reason: `现价已触及上一版${level.label}${level.price}`,
      }
    }
  }

  const atr = finite(current?.technical?.atr)
    ?? finite(previous?.technical?.atr)
  const atrRatio = atr != null ? atr / currentPrice : null
  const priceThreshold = clamp((atrRatio ?? 0.012) * 0.35, 0.0025, 0.008)
  const priceMove = Math.abs(currentPrice / previousPrice - 1)
  if (priceMove >= priceThreshold) {
    return {
      changed: true,
      reason: `价格变化${(priceMove * 100).toFixed(2)}%，达到动态波动门槛`,
    }
  }

  const previousPct = finite(previous?.quote?.pct)
  const currentPct = finite(current?.quote?.pct)
  const pctThreshold = clamp(priceThreshold * 100, 0.3, 0.8)
  if (
    previousPct != null
    && currentPct != null
    && Math.abs(currentPct - previousPct) >= pctThreshold
  ) {
    return {
      changed: true,
      reason: `涨跌幅变化达到动态门槛${pctThreshold.toFixed(1)}个百分点`,
    }
  }
  return { changed: false, reason: '' }
}
