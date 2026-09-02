export const EXIT_MANAGEMENT_VERSION = 'exit-management.v1'

const EXIT_PRIORITY = Object.freeze({
  HARD_STOP: 1,
  STRUCTURAL_EXIT: 2,
  TAKE_PROFIT: 3,
  TRAILING_PROTECT: 4,
  OPPORTUNITY_REVIEW: 5,
  HOLD: 9,
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function text(value, maximum = 240) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function holdings(payload = {}) {
  const total = Math.max(
    0,
    Math.trunc(finite(payload.holdQty) || 0),
  )
  const sellable = Math.max(
    0,
    Math.min(
      total,
      Math.trunc(
        finite(payload.sellableTodayQty) ?? total,
      ),
    ),
  )
  return { total, sellable, locked: Math.max(0, total - sellable) }
}

function confirmedHardStop(payload, advice) {
  const price = finite(
    payload.todayQuote?.price
    ?? payload.intraday?.now
    ?? payload.currentPrice,
  )
  const stop = finite(advice.stopPrice)
  if (!(price > 0 && stop > 0 && price <= stop)) return false
  return (
    payload.todayQuote?.live === false
    || price <= stop * 0.985
    || payload.intraday?.atDayLow === true
    || /跳水|回落|弱|破位/.test(
      String(payload.intraday?.rhythm || ''),
    )
  )
}

function structuralExit(tactical = {}) {
  const distribution =
    tactical.flow?.relation === 'DISTRIBUTION'
  const sectorWeak = tactical.sector?.state === 'WEAKENING'
    || tactical.sector?.stockRole === 'LAGGARD'
  const negativeCatalyst =
    tactical.catalyst?.risk === 'NEGATIVE'
  const relativeStrength = finite(
    tactical.stock?.relativeStrength,
  )
  return (
    (distribution && sectorWeak)
    || (
      negativeCatalyst
      && relativeStrength != null
      && relativeStrength < 45
    )
  )
}

function trailingProtection(payload, advice) {
  const current = finite(
    payload.todayQuote?.price
    ?? payload.intraday?.now
    ?? payload.currentPrice,
  )
  const cost = finite(payload.holdCost)
  const peak = finite(
    payload.holdingPeakPrice
    ?? payload.todayQuote?.high
    ?? payload.intraday?.dayHigh,
  )
  if (!(current > cost && peak > current && peak > cost)) return null
  const profitPct = (current / cost - 1) * 100
  const drawdownPct = (peak - current) / peak * 100
  const atr = finite(payload.tech?.atr?.atr ?? payload.tech?.atr)
  const atrPct = atr != null && current > 0
    ? atr / current * 100
    : null
  const thresholdPct = Math.max(
    1,
    Math.min(3, (atrPct ?? 1.5) * 0.75),
  )
  const weakening = (
    /回落|走弱|跳水|破位/.test(
      String(payload.intraday?.rhythm || ''),
    )
    || Number(payload.intraday?.vsVwap) < 0
    || /跌破/.test(String(payload.history?.vsMa5 || ''))
  )
  if (
    profitPct < 2
    || drawdownPct < thresholdPct
    || !weakening
  ) return null
  return {
    current,
    peak,
    profitPct: rounded(profitPct),
    drawdownPct: rounded(drawdownPct),
    thresholdPct: rounded(thresholdPct),
    stopReference: finite(advice.stopPrice),
  }
}

function expiredOpportunityReview(payload, now) {
  const previous = payload.previousAdvice || {}
  const validUntil = Date.parse(
    previous.decisionPlan?.validUntil || '',
  )
  const opportunity = payload.shortHorizonTactical?.opportunityCost
  if (
    !Number.isFinite(validUntil)
    || now <= validUntil
    || !opportunity?.targetCode
  ) return null
  const edgeScore = finite(opportunity.edgeScore)
  if (!(edgeScore >= 5)) return null
  return {
    targetCode: text(opportunity.targetCode, 12),
    targetName: text(opportunity.targetName, 40),
    edgeScore: rounded(edgeScore, 1),
  }
}

function exitQuantity(total, sellable, full = false) {
  if (sellable <= 0) return 0
  if (full) return sellable
  return Math.max(1, Math.min(sellable, Math.ceil(total / 2)))
}

function applyExitAction(
  input,
  {
    kind,
    reason,
    price,
    total,
    sellable,
    full = false,
    nextTradeDay = '下一交易日',
  },
) {
  const result = { ...input }
  const lots = exitQuantity(total, sellable, full)
  const blockedByT1 = lots <= 0
  const clearsPosition = !blockedByT1
    && lots >= total
    && sellable >= total
  const action = blockedByT1
    ? '持有'
    : clearsPosition ? '清仓' : '减仓'
  result.action = action
  result.stance = action
  result.tone = blockedByT1 ? 'muted' : 'green'
  result.opQty = blockedByT1
    ? '今日不可卖'
    : `${action}${lots}手`
  result.opAmount = blockedByT1 || !(price > 0)
    ? 0
    : Math.round(price * lots * 100)
  if (price > 0) result.reducePrice = price
  result.actionPlan = blockedByT1
    ? `${reason}，但今日仓位受T+1限制；${nextTradeDay}优先退出`
    : `${reason}，按纪律${result.opQty}`
  result.exitTiming = blockedByT1
    ? `${nextTradeDay}开盘后优先核验可卖数量并执行退出`
    : clearsPosition
      ? kind === 'HARD_STOP'
        ? '触及止损后观察约20秒确认非瞬时插针；快速深破立即退出，不等待模型再次生成；清仓成交后其他止损、止盈和减仓条件自动失效'
        : '反弹退出价到达后观察约60秒确认转弱；清仓成交后持仓归零，其他止损、止盈和减仓条件自动失效'
    : kind === 'HARD_STOP'
      ? '破位已确认，不等待模型再次生成；人工确认后立即按可卖数量退出'
      : '先执行本次风险释放，剩余仓位用短线结构继续保护'
  result.reviewTrigger = blockedByT1
    ? `${nextTradeDay}仓位解锁`
    : '本次人工成交记录完成或五分钟结构再次变化'
  result.exitManagement = {
    schemaVersion: EXIT_MANAGEMENT_VERSION,
    kind,
    priority: EXIT_PRIORITY[kind],
    action,
    lots,
    totalLots: total,
    sellableLots: sellable,
    lockedLots: Math.max(0, total - sellable),
    blockedByT1,
    referencePrice: rounded(price, 3),
    reason: text(reason),
    nextReviewTrigger: result.reviewTrigger,
  }
  return result
}

export function applyShortHorizonExitPolicy({
  mode,
  result: input,
  payload = {},
  now = Date.now(),
} = {}) {
  const result = input && typeof input === 'object' ? { ...input } : {}
  if (!['hold_advice', 'review'].includes(mode)) return result
  const { total, sellable } = holdings(payload)
  if (total <= 0) return result

  const tactical = payload.shortHorizonTactical || {}
  const current = finite(
    payload.todayQuote?.price
    ?? payload.intraday?.now
    ?? payload.currentPrice,
  )
  if (confirmedHardStop(payload, result)) {
    return applyExitAction(result, {
      kind: 'HARD_STOP',
      reason: `现价${current}已确认跌破止损${result.stopPrice}`,
      price: current,
      total,
      sellable,
      full: true,
      nextTradeDay: payload.nextTradeDay,
    })
  }

  if (structuralExit(tactical)) {
    return applyExitAction(result, {
      kind: 'STRUCTURAL_EXIT',
      reason: tactical.flow?.relation === 'DISTRIBUTION'
        ? '主力流出、小单承接且板块或个股地位转弱'
        : '负面催化出现且个股相对强度不足',
      price: current,
      total,
      sellable,
      nextTradeDay: payload.nextTradeDay,
    })
  }

  const target = finite(result.targetPrice)
  if (current > 0 && target > 0 && current >= target) {
    return applyExitAction(result, {
      kind: 'TAKE_PROFIT',
      reason: `现价${current}已达到目标${target}，先分批锁定利润`,
      price: current,
      total,
      sellable,
      nextTradeDay: payload.nextTradeDay,
    })
  }

  const trailing = trailingProtection(payload, result)
  if (trailing) {
    return applyExitAction(result, {
      kind: 'TRAILING_PROTECT',
      reason: `盈利${trailing.profitPct}%后从高点回撤${trailing.drawdownPct}%，且盘中结构转弱`,
      price: trailing.current,
      total,
      sellable,
      nextTradeDay: payload.nextTradeDay,
    })
  }

  const opportunity = expiredOpportunityReview(payload, now)
  if (opportunity) {
    result.reviewTrigger = `原短线窗口到期，${opportunity.targetName}相对优势高${opportunity.edgeScore}分，立即重评是否轮动`
    result.exitManagement = {
      schemaVersion: EXIT_MANAGEMENT_VERSION,
      kind: 'OPPORTUNITY_REVIEW',
      priority: EXIT_PRIORITY.OPPORTUNITY_REVIEW,
      action: '复核',
      lots: 0,
      totalLots: total,
      sellableLots: sellable,
      lockedLots: Math.max(0, total - sellable),
      blockedByT1: false,
      referencePrice: rounded(current, 3),
      reason: result.reviewTrigger,
      nextReviewTrigger: result.reviewTrigger,
      opportunity,
    }
    return result
  }

  result.exitManagement = {
    schemaVersion: EXIT_MANAGEMENT_VERSION,
    kind: 'HOLD',
    priority: EXIT_PRIORITY.HOLD,
    action: '持有',
    lots: 0,
    totalLots: total,
    sellableLots: sellable,
    lockedLots: Math.max(0, total - sellable),
    blockedByT1: false,
    referencePrice: rounded(current, 3),
    reason: '尚未触发退出优先级，继续等待止损、结构、目标或到期事件',
    nextReviewTrigger: text(
      result.reviewTrigger
      || tactical.timing?.reviewAfter
      || '五分钟结构变化',
      160,
    ),
  }
  return result
}
