import {
  explicitActionInstruction,
  explicitActionLabel,
} from './userFacingLanguage.js'

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
    .replace(
      /(?:[，,；;。]?\s*(?:本次触发结束|不新增复核价))+[。.]?$/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function identityOf(alert = {}) {
  const code = String(alert.code || '').trim()
  const name = String(alert.name || '').trim()
  if (name && name !== code) return name
  return name || code || '股票预警'
}

function codeOf(alert = {}) {
  const code = String(alert.code || '').trim()
  const name = String(alert.name || '').trim()
  return code && name && name !== code ? code : ''
}

function actionOf(alert = {}) {
  if (alert.reviewOnly) return '复核'
  if (alert.actKind === 'add') return '加仓'
  if (alert.actKind === 'reduce' && /清仓/.test(String(alert.note || ''))) {
    return '清仓'
  }
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

function actionWithQuantity(action, opQty) {
  const quantity = compactText(opQty, 18)
  if (!quantity || /无需|不可卖|0手/.test(quantity)) return action
  if (quantity.includes(action)) return quantity
  const lots = quantity.match(/\d+\s*手/)
  return lots ? `${action}${lots[0].replace(/\s+/g, '')}` : action
}

function compactFact(value, max = 42) {
  return compactText(value, max)
    .replace(/\s*([≥≤])\s*/g, '$1')
    .replace(/^(涨跌幅|量比|换手率?)\s+/, '$1')
}

function factLine(alert, quote, reason, { threshold = true } = {}) {
  const price = priceText(
    quote?.price
    ?? alert.decisionPrice
    ?? alert.watchingPrice
    ?? alert.lastJudgePrice,
  )
  const parts = []
  const code = codeOf(alert)
  if (code) parts.push(code)
  if (price) {
    const target = threshold
      && alert.type === 'price'
      && finite(alert.value) != null
      ? `${OP_LABEL[alert.op] || ''}${priceText(alert.value)}`
      : ''
    parts.push(`现价${price}${target}`)
  } else {
    const fact = compactFact(reason)
    if (fact) parts.push(fact)
  }
  return parts.join('｜')
}

function watchInstruction(action) {
  if (/止损/.test(action)) {
    return '先不卖出，复核中，约20秒后给结论'
  }
  if (/清仓/.test(action)) {
    return '先不清仓，复核中，约60秒后给结论'
  }
  if (/减仓|止盈/.test(action)) {
    return '先不减仓，复核中，约60秒后给结论'
  }
  if (/加仓/.test(action)) {
    return '先不加仓，复核中，约60秒后给结论'
  }
  if (/买入/.test(action)) {
    return '先不买入，复核中，约60秒后给结论'
  }
  return '先不操作，复核中，约60秒后给结论'
}

function waitOutcome(action, holdingMode) {
  return holdingMode || /加仓|减仓|清仓|止盈|止损/.test(action)
    ? '本次不加仓、不减仓'
    : '本次不买入'
}

function terminalReason(reason, holdingMode) {
  return compactText(
    explicitActionInstruction(reason, {
      holdingMode,
      terminal: true,
    })
      .replace(/^结论\s*[：:]\s*/, '')
      .replace(
        /^本次不加仓、不减仓(?:，继续持有现有仓位)?[，,；;:]?\s*/,
        '',
      )
      .replace(/^本次不买入[，,；;:]?\s*/, '')
      .replace(/^本次触发结束[，,；;:]?\s*/, ''),
    34,
  )
}

function invalidOutcome(action) {
  if (/买入/.test(action)) return '取消买入'
  if (/加仓/.test(action)) return '取消加仓'
  if (/清仓/.test(action)) return '取消清仓'
  if (/减仓|止盈/.test(action)) return '取消减仓'
  if (/止损/.test(action)) return '止损条件失效'
  return '取消本次操作'
}

function reviewReachedTitle(alert = {}) {
  const label = compactText(alert.note || '', 12)
    .replace(/复核$/, '')
    .replace(/价$/, '')
  return /回踩|突破|加仓|减仓|止盈|止损/.test(label)
    ? `${label}已到`
    : '观察价已到'
}

function watchReachedTitle(action) {
  if (/清仓/.test(action)) return '清仓观察已到'
  if (/减仓/.test(action)) return '减仓观察已到'
  if (/止盈/.test(action)) return '止盈观察已到'
  if (/止损/.test(action)) return '止损观察已到'
  if (/加仓/.test(action)) return '加仓观察已到'
  if (/买入/.test(action)) return '买入观察已到'
  return '观察价已到'
}

function lifecycleId(alert = {}) {
  return compactText(alert.id || alert.code || 'general', 80)
    .replace(/[^\w.-]/g, '-')
}

function deliveryOf(alert, stage, eventId = '') {
  const lifecycle = lifecycleId(alert)
  const actionable = stage === 'confirm' || stage === 'trigger'
  const quietTerminal = stage === 'wait' || stage === 'invalid'
  return {
    tag: `trade-alert-${lifecycle}`,
    eventId: eventId || `${stage}-${lifecycle}`,
    renotify: actionable,
    silent: quietTerminal,
    urgency: actionable ? 'high' : 'normal',
    ttl: ['watch', 'review'].includes(stage) ? 180 : 300,
  }
}

export function userFacingAlertMessage(alert = {}) {
  const message = String(alert.triggeredMsg || '').trim()
  if (!message) return ''
  const action = actionOf(alert)
  const holdingMode = (
    ['add', 'reduce'].includes(String(alert.actKind || ''))
    || /加仓|减仓|止盈|止损/.test(`${action} ${alert.note || ''}`)
  )
  return explicitActionInstruction(message, {
    holdingMode,
    terminal: /维持持有|维持观望|保持持有|保持观望|维持原计划/.test(
      message,
    ),
  })
}

export function buildAlertNotification({
  alert = {},
  quote = null,
  stage = 'trigger',
  reason = '',
} = {}) {
  const identity = identityOf(alert)
  const action = actionOf(alert)
  const holdingMode = (
    ['add', 'reduce'].includes(String(alert.actKind || ''))
    || /加仓|减仓|止盈|止损/.test(`${action} ${alert.note || ''}`)
  )
  const actionCommand = actionWithQuantity(action, alert.opQty)
  const pendingFacts = factLine(alert, quote, reason)
  const decisionFacts = factLine(alert, quote, reason, {
    threshold: false,
  })
  const conciseReason = terminalReason(reason, holdingMode)
  const title = stage === 'watch'
    ? `${identity}｜${watchReachedTitle(action)}`
    : stage === 'review'
      ? `${identity}｜${reviewReachedTitle(alert)}`
    : stage === 'confirm'
      ? `${identity}｜立即${actionCommand}`
      : stage === 'wait'
        ? `${identity}｜${holdingMode ? '继续持有' : '本次不买入'}`
      : stage === 'invalid'
        ? `${identity}｜${invalidOutcome(action)}`
        : `${identity}｜${{
            limitup: '临近涨停',
            limitdown: '临近跌停',
            pct: '涨跌幅达标',
            vol: '量比达标',
            turnover: '换手率达标',
          }[alert.type] || `${action}到价`}`
  const body = (
    stage === 'watch'
      ? [pendingFacts, watchInstruction(action)]
      : stage === 'review'
        ? [pendingFacts, '复核中，约2分钟内给结论']
        : stage === 'confirm'
          ? [decisionFacts, conciseReason || '信号已确认']
          : stage === 'wait'
            ? [
                decisionFacts,
                holdingMode ? waitOutcome(action, holdingMode) : '',
                conciseReason,
              ]
            : stage === 'invalid'
              ? [decisionFacts, conciseReason || '条件已失效']
              : [pendingFacts]
  ).filter(Boolean).join('｜').slice(0, 72)
  return {
    title: title.slice(0, 40),
    body,
    ...deliveryOf(alert, stage),
  }
}

function reviewActionTitle(outcome, actionPlan) {
  if (/本次不加仓、不减仓/.test(outcome)) return '继续持有'
  if (/本次不买入/.test(outcome)) return '本次不买入'
  const plan = compactText(actionPlan, 80)
  const command = plan.match(
    /(?:立即|现在)?(?:买入|加仓|减仓|清仓|卖出|止损)\s*\d+\s*手/,
  )?.[0]
  return compactText(command || outcome, 22).replace(/\s+/g, '')
}

export function buildTerminalReviewNotification({
  code = '',
  name = '',
  advice = {},
  jobId = '',
  alertId = '',
} = {}) {
  const decision = advice?.reviewDecision
  if (decision?.terminal !== true || !decision.outcome) return null
  const holdingMode = /加仓|减仓|清仓|持有|止损|止盈/.test(
    `${decision.outcome} ${advice.action || ''} ${advice.stance || ''}`,
  )
  const outcome = explicitActionLabel(decision.outcome, {
    holdingMode,
    terminal: true,
  })
  const actionPlan = explicitActionInstruction(
    String(advice.actionPlan || decision.outcome),
    { holdingMode, terminal: true },
  )
  const basis = compactText(
    decision.basis?.[0]?.summary
    || decision.basisSummary
    || advice.reason
    || '',
    44,
  )
  const quiet = /本次不|继续持有|观望|放弃|取消/.test(outcome)
  const id = String(alertId || jobId || code || 'review')
  const facts = [
    name && code && name !== code ? code : '',
    quiet && holdingMode ? '本次不加仓、不减仓' : '',
    basis,
  ].filter(Boolean).join('｜').slice(0, 72)
  return {
    title: `${identityOf({ code, name })}｜${reviewActionTitle(
      outcome,
      actionPlan,
    )}`.slice(0, 40),
    body: facts,
    code,
    name,
    tag: `trade-alert-${lifecycleId({ id, code })}`,
    eventId: `review-terminal-${jobId || code}`,
    url: '/',
    renotify: !quiet,
    silent: quiet,
    urgency: quiet ? 'normal' : 'high',
    ttl: 300,
  }
}
