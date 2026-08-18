import { beijingDayKey } from './tradingCalendar.js'
import { tradeRecordType } from './tradeIntent.js'

export function tradeRecordTimestamp(record) {
  return Number(record?.at || record?.sellAt || record?.buyAt || 0)
}

export function manualTradePairId(leftId, rightId) {
  return `manual-t:${[String(leftId || ''), String(rightId || '')].sort().join(':')}`
}

export function validateManualTradePair(target, counterpart) {
  if (!target || !counterpart || target.id === counterpart.id) {
    return { ok: false, error: '请选择另一条交易记录' }
  }
  const targetType = tradeRecordType(target)
  const counterpartType = tradeRecordType(counterpart)
  if (
    (targetType !== 'BUY' && targetType !== 'SELL')
    || (counterpartType !== 'BUY' && counterpartType !== 'SELL')
    || targetType === counterpartType
  ) {
    return { ok: false, error: '做T配对必须是一条买入和一条卖出记录' }
  }
  if (String(target.code || '') !== String(counterpart.code || '')) {
    return { ok: false, error: '做T配对必须是同一只股票' }
  }
  const targetAt = tradeRecordTimestamp(target)
  const counterpartAt = tradeRecordTimestamp(counterpart)
  if (
    !(targetAt > 0)
    || !(counterpartAt > 0)
    || beijingDayKey(targetAt) !== beijingDayKey(counterpartAt)
  ) {
    return { ok: false, error: '做T配对必须发生在同一交易日' }
  }
  const targetQty = Number(target.qty)
  const counterpartQty = Number(counterpart.qty)
  if (
    !(targetQty > 0)
    || !(counterpartQty > 0)
    || Math.abs(targetQty - counterpartQty) > 1e-9
  ) {
    return { ok: false, error: '手动配对的两条记录手数必须一致' }
  }
  if (
    counterpart.tPairTradeId
    && String(counterpart.tPairTradeId) !== String(target.id)
  ) {
    return { ok: false, error: '所选记录已经与另一条做T记录配对' }
  }
  return { ok: true }
}

export function manualTradePairCandidates(records, target) {
  if (!target) return []
  return (Array.isArray(records) ? records : [])
    .filter((record) => {
      if (!record || record.live || record.id === target.id) return false
      return validateManualTradePair(target, record).ok
    })
    .sort((left, right) =>
      tradeRecordTimestamp(right) - tradeRecordTimestamp(left)
    )
}
