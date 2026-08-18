export const TRADE_INTENT = Object.freeze({
  POSITION: 'position',
  T: 't',
})

export function tradeRecordType(record) {
  return String(
    record?.type || (record?.kind === 'T' ? 'T' : 'CLOSE'),
  ).toUpperCase()
}

export function tradeIntentOf(record) {
  const type = tradeRecordType(record)
  if (type === 'T') return TRADE_INTENT.T
  if (
    (type === 'BUY' || type === 'SELL')
    && record?.tradeIntent === TRADE_INTENT.T
  ) return TRADE_INTENT.T
  return TRADE_INTENT.POSITION
}

export function editableTradeIntent(record) {
  const type = tradeRecordType(record)
  return type === 'BUY' || type === 'SELL'
}

export function tradeIntentOptions(record) {
  const type = tradeRecordType(record)
  if (type === 'BUY') {
    return [
      { value: TRADE_INTENT.POSITION, label: '建仓 / 加仓' },
      { value: TRADE_INTENT.T, label: '做T买入' },
    ]
  }
  if (type === 'SELL') {
    return [
      { value: TRADE_INTENT.POSITION, label: '减仓 / 清仓' },
      { value: TRADE_INTENT.T, label: '做T卖出' },
    ]
  }
  return []
}

export function tradeIntentLabel(record) {
  const type = tradeRecordType(record)
  if (type === 'T') {
    return record?.tDir === 'reverse' ? '反T' : '正T'
  }
  if (type === 'CLOSE') return '完整平仓'
  if (tradeIntentOf(record) === TRADE_INTENT.T) {
    return type === 'BUY' ? '做T买入' : '做T卖出'
  }
  return type === 'BUY' ? '建仓 / 加仓' : '减仓 / 清仓'
}

export function validateTradeIntent(record, value) {
  const normalized = String(value || '')
  if (!editableTradeIntent(record)) {
    return normalized === tradeIntentOf(record)
      ? { ok: true, value: tradeIntentOf(record) }
      : { ok: false, error: '已配对做T或完整平仓不能修改操作类型' }
  }
  if (
    normalized !== TRADE_INTENT.POSITION
    && normalized !== TRADE_INTENT.T
  ) {
    return { ok: false, error: '操作类型无效' }
  }
  return { ok: true, value: normalized }
}
