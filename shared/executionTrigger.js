export const EXECUTION_TRIGGER_DIRECTIONS = Object.freeze([
  'LTE',
  'GTE',
  'IMMEDIATE',
])

function normalizedDirection(value) {
  const direction = String(value || '').trim().toUpperCase()
  return EXECUTION_TRIGGER_DIRECTIONS.includes(direction)
    ? direction
    : ''
}

export function executionTriggerDirection({
  action = '',
  trigger = '',
  triggerDirection = '',
} = {}) {
  const explicit = normalizedDirection(triggerDirection)
  if (explicit) return explicit

  const actionKey = String(action || '').trim().toUpperCase()
  const text = String(trigger || '').replace(/\s+/g, '')
  if (actionKey === 'EXIT') return 'LTE'
  const downside = (
    /跌破|下破|失守|低于|不高于|回落(?:到|至)|降至/.test(text)
    || /触及.{0,24}(?:不能|无法|未能|没有)收回/.test(text)
  )
  const upside = (
    /反弹(?:到|至)|冲高(?:到|至)|涨至|升至|突破|站上|收复|高于|不低于/
      .test(text)
  )
  const immediate = (
    /立即|马上|现价(?:减仓|卖出|退出)|当前价(?:减仓|卖出|退出)/
      .test(text)
    || /开盘后(?:立即|直接)|先(?:行)?(?:减仓|卖出|退出)|直接(?:减仓|卖出|退出)/
      .test(text)
  )

  if (downside) return 'LTE'
  if (upside) return 'GTE'
  if (immediate) return 'IMMEDIATE'
  if (['BUY', 'ADD', 'T_BUY_FIRST'].includes(actionKey)) {
    return 'LTE'
  }
  if (['REDUCE', 'T_SELL_FIRST'].includes(actionKey)) return 'GTE'
  return ''
}
