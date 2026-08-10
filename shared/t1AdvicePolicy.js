function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function sideOfAlert(alert) {
  if (alert?.actKind === 'add') return 'buy'
  if (alert?.actKind === 'reduce') return 'sell'
  const note = String(alert?.note || '')
  if (/止损/.test(note)) return 'stop'
  if (/止盈|减仓|卖出/.test(note)) return 'sell'
  return null
}

function capSellText(value, allowed) {
  if (!(allowed > 0)) return '今日不可卖'
  const text = String(value || '')
  const match = text.match(/(\d+(?:\.\d+)?)\s*手/)
  if (!match) return text
  const requested = Math.max(0, Math.trunc(Number(match[1])))
  if (requested <= allowed) return text
  return text
    .replace(/清仓/g, '减仓')
    .replace(/\d+(?:\.\d+)?\s*手/, `${allowed}手`)
}

export function t1GateForSide(side, status = {}, nextTradeDay = '') {
  if (!['sell', 'stop'].includes(side)) {
    return { blocked: false, allowedQty: null, reason: '' }
  }
  const liveQty = Math.max(0, finite(status.liveQty) || 0)
  const boughtToday = Math.max(0, finite(status.boughtToday) || 0)
  const sellable = Math.max(0, Math.min(
    liveQty,
    finite(status.sellableToday) ?? liveQty,
  ))
  return {
    blocked: sellable <= 0,
    allowedQty: sellable,
    boughtToday,
    reason: sellable <= 0
      ? `今日买入${boughtToday}手受T+1锁定，今日不可卖${nextTradeDay ? `，最早${nextTradeDay}处理` : ''}`
      : `今日最多可卖${sellable}手`,
  }
}

export function applyT1ToAlert(alert, status, nextTradeDay = '') {
  if (!alert || !status) return alert
  const side = sideOfAlert(alert)
  const gate = t1GateForSide(side, status, nextTradeDay)
  if (!['sell', 'stop'].includes(side)) return { ...alert }
  return {
    ...alert,
    boughtTodayQty: gate.boughtToday,
    sellableTodayQty: gate.allowedQty,
    t1Blocked: gate.blocked,
    t1Reason: gate.reason,
    ...(nextTradeDay ? { nextTradeDay } : {}),
    ...(alert.actKind === 'reduce' ? { opQty: capSellText(alert.opQty, gate.allowedQty) } : {}),
  }
}
