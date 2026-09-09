import { evaluateHoldingActions } from './holdingActionValue.js'

export const EXIT_MANAGEMENT_VERSION = 'exit-management.v1'

const EXIT_PRIORITY = Object.freeze({
  HARD_STOP: 1,
  STRUCTURAL_EXIT: 2,
  TAKE_PROFIT: 3,
  VALUE_DECAY: 4,
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
  const ledgerStop = finite(payload.holdingStopPrice)
  const policyStop = [
    ledgerStop,
    finite(tactical.prices?.stopReference),
    finite(tactical.prices?.support),
    finite(payload.previousAdvice?.stopPrice),
    finite(result.stopPrice),
  ].find((value) => value > 0)
  const policyTarget = [
    finite(tactical.prices?.targetReference),
    finite(tactical.prices?.quantTargetHigh),
    finite(tactical.prices?.resistance),
    finite(payload.previousAdvice?.targetPrice),
    finite(result.targetPrice),
  ].find((value) => value > 0)
  if (policyStop > 0) result.stopPrice = policyStop
  if (policyTarget > 0) result.targetPrice = policyTarget
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

  const suppliedActionValue = (
    (
      payload.adaptiveAction?.schemaVersion === 'holding-action-value.v2'
      || payload.adaptiveAction?.schemaVersion === 'holding-action-value.v1'
    )
    && ['ADD', 'HOLD', 'REDUCE', 'EXIT'].includes(
      payload.adaptiveAction?.selected?.action,
    )
  ) ? payload.adaptiveAction : null
  const actionValue = {
    ...(suppliedActionValue || evaluateHoldingActions({
      payload: {
        ...payload,
        shortHorizonTactical: tactical,
      },
      advice: {
        ...result,
        stopPrice: policyStop,
        targetPrice: policyTarget,
      },
    })),
    evaluatedAt: now,
  }
  result.adaptiveAction = actionValue
  if (['EXIT', 'REDUCE'].includes(actionValue.selected.action)) {
    const structural = structuralExit(tactical)
    const targetReached = current > 0
      && finite(result.targetPrice) > 0
      && current >= finite(result.targetPrice)
    return applyExitAction(result, {
      kind: structural
        ? 'STRUCTURAL_EXIT'
        : targetReached ? 'TAKE_PROFIT' : 'VALUE_DECAY',
      reason: actionValue.selected.reasons.join('；')
        || '继续持有的预期价值已低于降低风险',
      price: current,
      total,
      sellable,
      full: actionValue.selected.action === 'EXIT',
      nextTradeDay: payload.nextTradeDay,
    })
  }

  if (actionValue.selected.action === 'ADD') {
    const addPrice = finite(
      tactical.prices?.current
      ?? tactical.timing?.pullbackPrice
      ?? result.addPrice,
    )
    const lots = Math.max(
      1,
      Math.trunc(finite(actionValue.selected.quantity) || 1),
    )
    result.action = '加仓'
    result.stance = '加仓'
    result.tone = 'red'
    result.opQty = `加仓${lots}手`
    if (addPrice > 0) result.addPrice = addPrice
    result.actionPlan = [
      addPrice > 0 ? `参考${rounded(addPrice, 3)}元加仓${lots}手` : `加仓${lots}手`,
      actionValue.selected.reasons.join('；'),
    ].filter(Boolean).join('；')
  } else {
    result.action = '持有'
    result.stance = '持有'
    result.opQty = '无需操作'
    result.addPrice = null
    result.actionPlan = actionValue.selected.reasons.join('；')
      || '继续持有现有仓位，等待下一实质事件'
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
    reason: actionValue.selected.reasons.join('；')
      || '继续持有的当前价值仍高于减仓或退出',
    nextReviewTrigger: text(
      result.reviewTrigger
      || tactical.timing?.reviewAfter
      || '五分钟结构变化',
      160,
    ),
    actionValue,
  }
  return result
}
