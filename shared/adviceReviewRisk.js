import {
  advicePriceLevel,
  sanitizedAdvicePriceContract,
} from './advicePriceContract.js'
import { executionTriggerDirection } from './executionTrigger.js'

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
  const priceContract = sanitizedAdvicePriceContract(advice)
  const contracted = [
    ['stop', '止损位'],
    ['target', '目标位'],
    ['reduce', '减仓位'],
    ['entry', '买入位'],
    ['add', '加仓位'],
    ['watch', '观察价'],
    ['leg1', '第一腿价'],
    ['leg2', '第二腿价'],
  ].map(([key, label]) => {
    const level = advicePriceLevel(advice, key)
    return level ? { ...level, label } : null
  }).filter(Boolean)
  if (priceContract) return contracted

  const trigger = advice.timing
    || advice.actionPlan
    || advice.nextAction
    || advice.futurePlan
    || ''
  const reduceDirection = executionTriggerDirection({
    action: advice.decisionPlan?.action || 'REDUCE',
    trigger,
    triggerDirection: advice.decisionPlan?.triggerDirection,
  })
  const watchDirection = executionTriggerDirection({
    action: 'WATCH',
    trigger,
    triggerDirection: advice.watchDirection,
  })
  return [
    { key: 'stop', label: '止损位', price: finite(advice.stopPrice), direction: 'LTE' },
    {
      key: 'target',
      label: '目标位',
      price: finite(advice.targetPrice),
      direction: 'GTE',
    },
    { key: 'reduce', label: '减仓位', price: finite(advice.reducePrice), direction: reduceDirection },
    {
      key: 'entry',
      label: '买入位',
      price: finite(advice.buyPrice),
      direction: 'LTE',
    },
    { key: 'add', label: '加仓位', price: finite(advice.addPrice), direction: 'LTE' },
    { key: 'watch', label: '观察价', price: finite(advice.watchPrice), direction: watchDirection },
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

  const funds = snapshot?.evidence?.funds || {}
  const mainNet = finite(funds.mainNetYi)
  const retailNet = finite(funds.retailNetYi ?? funds.smallNetYi)
  const fundRelation = String(funds.retailFlow?.relation || '')
  if (
    fundRelation === 'main_out_retail_in'
    || (mainNet != null && mainNet < 0 && retailNet != null && retailNet > 0)
  ) {
    urgent.push('主力流出与小单流入背离')
  } else if (mainNet != null && mainNet > 0 && retailNet != null && retailNet < 0) {
    elevated.push('主力流入与小单流出待确认')
  }

  const opportunity = snapshot?.evidence?.decisionSignals?.sectorOpportunity
  const role = String(opportunity?.stock?.role || '')
  if (
    opportunity?.probeEligible === true
    && opportunity?.sector?.actionability === 'LAYOUT'
    && ['leader', 'core', 'elastic'].includes(role)
    && Number(opportunity?.stock?.mainInflow) > 0
  ) {
    elevated.push('板块前排出现可参与信号')
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
  const hasStrictWatchPrice = !!advicePriceLevel(advice, 'watch')
  const intervalMin = hasStrictWatchPrice
    ? Math.min(configured, 5)
    : risk.level === 'urgent'
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
    const crossedDown = level.direction === 'LTE'
      && previousPrice > level.price
      && currentPrice <= level.price
    const crossedUp = level.direction === 'GTE'
      && previousPrice < level.price
      && currentPrice >= level.price
    if (crossedDown || crossedUp) {
      return {
        changed: true,
        reason: `现价已${crossedDown ? '向下' : '向上'}穿越上一版${level.label}${level.price}`,
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
