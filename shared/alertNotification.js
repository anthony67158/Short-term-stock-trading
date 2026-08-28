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
  if (alert.reviewOnly) return '复核'
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
    const label = alert.reviewOnly
      ? compactText(alert.note || '观察价', 12).replace(/复核$/, '')
      : '目标'
    parts.push(`${label}${OP_LABEL[alert.op] || ''}${priceText(alert.value)}`)
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

function waitOutcome(action) {
  return /加仓|减仓|止盈|止损/.test(action)
    ? '维持持有'
    : '维持观望'
}

function invalidOutcome(action) {
  if (/买入/.test(action)) return '放弃买入'
  if (/加仓/.test(action)) return '放弃加仓'
  if (/减仓|止盈/.test(action)) return '放弃本次减仓'
  if (/止损/.test(action)) return '原止损条件失效'
  return '放弃本次操作'
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
    : stage === 'review'
      ? '正在核对原军师计划、分时、量能和资金，2分钟内给出明确结论'
    : stage === 'confirm'
      ? `执行：${alert.opQty && !/不可卖/.test(String(alert.opQty)) ? alert.opQty : action}`
      : stage === 'wait'
        ? `结论：${waitOutcome(action)}；本次触发结束`
      : stage === 'invalid'
        ? `结论：${invalidOutcome(action)}；本次触发结束`
        : `执行：${alert.opQty || action}`
  const conciseReason = compactText(reason)
  const body = [
    facts,
    ['confirm', 'wait', 'invalid'].includes(stage) && conciseReason
      ? `${instruction}；${conciseReason}`
      : instruction,
  ].filter(Boolean).join('\n').slice(0, 92)
  const title = stage === 'watch'
    ? `${identity}｜${action}待确认`
    : stage === 'review'
      ? `${identity}｜观察条件已到`
    : stage === 'confirm'
      ? `${identity}｜现在${action}`
      : stage === 'wait'
        ? `${identity}｜${waitOutcome(action)}`
      : stage === 'invalid'
        ? `${identity}｜${invalidOutcome(action)}`
        : `${identity}｜${action}提醒`
  return { title, body }
}
