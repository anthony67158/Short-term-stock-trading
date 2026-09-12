const PERCENT_BLOCKERS = new Set([
  'DAILY_REALIZED_LOSS',
  'DAILY_DRAWDOWN',
  'MAX_POSITION',
  'CASH_RESERVE',
  'INDUSTRY_CONCENTRATION',
  'OPEN_RISK_BUDGET',
])

function metric(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return Number.isInteger(number)
    ? String(number)
    : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

export function formatAccountRiskBlocker(blocker = {}) {
  const message = String(blocker.message || '账户风险条件未通过')
  const value = metric(blocker.value)
  const limit = metric(blocker.limit)
  if (!value || !limit || !(Number(blocker.limit) > 0)) return message
  const unit = PERCENT_BLOCKERS.has(String(blocker.code || ''))
    ? '%'
    : blocker.code === 'CONSECUTIVE_LOSSES' ? '笔' : ''
  return `${message}（当前${value}${unit}，上限${limit}${unit}）`
}
