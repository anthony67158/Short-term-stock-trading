const OP_LABEL = { gte: '≥', lte: '≤' }

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function priceText(value) {
  const number = finite(value)
  if (!(number > 0)) return ''
  return String(number < 10 ? +number.toFixed(3) : +number.toFixed(2))
}

function compactText(value, max = 40) {
  const text = String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^(?:确认[^:：]{0,12}|已失效)\s*[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function identityOf(alert = {}) {
  const code = String(alert.code || '').trim()
  const name = String(alert.name || '').trim()
  if (name && code && name !== code) return `${name}(${code})`
  return name || code || '股票预警'
}

function actionOf(alert = {}) {
  if (alert.actKind === 'add') return '加仓'
  if (alert.actKind === 'reduce') return '减仓'
  const note = String(alert.note || '')
  if (/止损/.test(note)) return '止损'
  if (/止盈/.test(note)) return '止盈'
  if (/买点|买入/.test(note)) return '买入'
  if (alert.type === 'limitup') return '涨停'
  if (alert.type === 'limitdown') return '跌停'
  if (alert.type === 'pct') return '涨跌幅'
  if (alert.type === 'vol') return '量比'
  if (alert.type === 'turnover') return '换手'
  return '价格'
}

function factLine(alert, quote) {
  const price = priceText(
    quote?.price
    ?? alert.decisionPrice
    ?? alert.watchingPrice
    ?? alert.lastJudgePrice,
  )
  const parts = []
  if (price) parts.push(`现${price}`)
  if (alert.type === 'price' && finite(alert.value) != null) {
    parts.push(`目标${OP_LABEL[alert.op] || ''}${priceText(alert.value)}`)
  }
  if (alert.opQty && !/无需|不可卖|0手/.test(String(alert.opQty))) {
    parts.push(String(alert.opQty).trim())
  }
  return parts.join('｜')
}

function watchInstruction(action) {
  if (/加仓|买入/.test(action)) return '先不买，等止跌企稳'
  if (/减仓|止盈/.test(action)) return '先不卖，等冲高转弱'
  if (/止损/.test(action)) return '先盯盘，等有效跌破'
  return '先观察，等条件确认'
}

export function buildAlertNotification({
  alert = {},
  quote = null,
  stage = 'trigger',
  reason = '',
} = {}) {
  const identity = identityOf(alert)
  const action = actionOf(alert)
  const facts = factLine(alert, quote) || compactText(reason, 46)
  const instruction = stage === 'watch'
    ? watchInstruction(action)
    : stage === 'confirm'
      ? `执行：${alert.opQty && !/不可卖/.test(String(alert.opQty)) ? alert.opQty : action}`
      : stage === 'invalid'
        ? '动作：暂停，等军师重算'
        : `执行：${alert.opQty || action}`
  const conciseReason = compactText(reason)
  const body = [
    facts,
    stage === 'confirm' && conciseReason
      ? `${instruction}；${conciseReason}`
      : instruction,
  ].filter(Boolean).join('\n').slice(0, 92)
  const title = stage === 'watch'
    ? `${identity}｜${action}待确认`
    : stage === 'confirm'
      ? `${identity}｜现在${action}`
      : stage === 'invalid'
        ? `${identity}｜暂停${action}`
        : `${identity}｜${action}提醒`
  return { title, body }
}
