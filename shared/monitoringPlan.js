import { beijingMinutes, isContinuousTrading } from './tradingCalendar.js'
import { isFreshAlertQuote } from './alertQuotePolicy.js'

export const MONITORING_PLAN_VERSION = 'monitoring-plan.v1'
const METRICS = new Set(['price', 'mainNetYi', 'priceVsVwapPct', 'openChangePct'])
const OPS = new Set(['lte', 'gte'])
const ACTIONS = new Set(['EXIT', 'REDUCE', 'HOLD'])
const finite = (value) => value == null || value === '' ? null
  : Number.isFinite(Number(value)) ? Number(value) : null
const positive = (value) => finite(value) > 0 ? finite(value) : null
const round = (value) => Math.round(value * 1000) / 1000
const actionName = (action, lots) => action === 'HOLD' ? '继续持有'
  : `${action === 'EXIT' ? '清仓' : '减仓'}${lots}手`
const actionLabel = (action) => action === 'HOLD' ? '继续持有'
  : action === 'EXIT' ? '清仓' : '减仓'

export function conditionText(condition) {
  const symbol = condition.op === 'lte' ? '≤' : '≥'
  return ({
    price: `股价${symbol}${condition.value}元`,
    mainNetYi: `主力净额${symbol}${condition.value}亿元`,
    priceVsVwapPct: `股价${condition.op === 'gte' ? '站上' : '跌破'}分时均价线`,
    openChangePct: `开盘涨跌幅${symbol}${condition.value}%`,
  })[condition.metric] || '条件不支持'
}

export function ruleText(rule) {
  const conditions = rule.conditions.map(conditionText).join(rule.logic === 'ANY' ? ' 或 ' : ' 且 ')
  return `${rule.session === 'OPENING' ? '开盘30分钟内，' : ''}${conditions}${
    rule.sustainSeconds ? `持续${rule.sustainSeconds}秒` : ''
  } → ${actionName(rule.action, rule.lots)}`
}

export function compileMonitoringPlan({ advice, payload, decisionPlan, now = Date.now() }) {
  if (!['hold_advice', 'review'].includes(decisionPlan?.mode)) return null
  const total = Math.max(0, Math.trunc(finite(payload.holdQty) || 0))
  if (!total) return null
  const raw = advice.executionRules
  if (!Array.isArray(raw) || !raw.length) return null
  const current = positive(payload.todayQuote?.price)
  const atr = positive(payload.tech?.atr)
  const errors = []
  const rules = []
  for (const [index, input] of raw.slice(0, 4).entries()) {
    const id = `rule-${index + 1}`
    if (!ACTIONS.has(input?.action) || !['ALL', 'ANY'].includes(input?.logic)
      || !Array.isArray(input.conditions) || !input.conditions.length || input.conditions.length > 4) {
      errors.push(`${id}的动作或条件结构无效`)
      continue
    }
    const conditions = input.conditions.map((condition) => ({
      metric: condition?.metric, op: condition?.op, value: finite(condition?.value),
    }))
    if (conditions.some((condition) =>
      !METRICS.has(condition.metric) || !OPS.has(condition.op) || condition.value == null
      || (condition.metric === 'price' && !(condition.value > 0))
      || (condition.metric === 'priceVsVwapPct' && condition.value !== 0)
      || (condition.metric === 'openChangePct' && Math.abs(condition.value) > 30)
    )) {
      errors.push(`${id}包含无法监控的指标或阈值`)
      continue
    }
    if (current && conditions.some((condition) => condition.metric === 'price'
      && Math.abs(condition.value - current) > Math.max(current * 0.12, (atr || 0) * 5))) {
      errors.push(`${id}的价格超出近期可达范围`)
      continue
    }
    const protective = input.kind === 'RISK_EXIT'
    const lots = input.action === 'HOLD' ? 0 : Math.min(total, Math.max(0, Math.trunc(finite(input.lots) || 0)))
    if (input.action !== 'HOLD' && !lots) {
      errors.push(`${id}缺少有效操作手数`)
      continue
    }
    const sustainSeconds = Math.min(120, Math.max(0, Math.trunc(finite(input.sustainSeconds) || 0)))
    rules.push({
      id, action: input.action === 'REDUCE' && lots === total ? 'EXIT' : input.action,
      kind: input.action === 'HOLD' ? 'HOLD' : protective ? 'RISK_EXIT' : 'PROFIT_EXIT',
      priority: input.action === 'HOLD' ? 3 : protective ? 1 : 2,
      lots, logic: input.logic, conditions,
      session: input.session === 'OPENING' ? 'OPENING' : 'CONTINUOUS',
      sustainSeconds: conditions.some((item) => item.metric === 'priceVsVwapPct')
        ? Math.max(60, sustainSeconds) : sustainSeconds,
    })
  }
  if (raw.length > 4) errors.push('监控分支超过4条')
  if (!rules.some((rule) => rule.action !== 'HOLD')) {
    errors.push('持仓计划缺少可执行的减仓或清仓规则')
  }
  return {
    schemaVersion: MONITORING_PLAN_VERSION, planId: decisionPlan.decisionId,
    code: payload.code, createdAt: now, validUntil: decisionPlan.validUntil,
    rules: rules.sort((a, b) => a.priority - b.priority),
    state: errors.length ? 'INVALID' : 'READY', errors,
  }
}

export function monitoringMetric(quote, metric) {
  if (metric === 'price') return positive(quote?.price)
  if (metric === 'mainNetYi') return finite(quote?.mainInflow) == null ? null : round(Number(quote.mainInflow) / 1e8)
  if (metric === 'priceVsVwapPct') {
    const vwap = positive(quote?.vwap)
    return vwap && positive(quote?.price) ? round((quote.price / vwap - 1) * 100) : null
  }
  if (metric === 'openChangePct') {
    const previous = positive(quote?.prevClose), open = positive(quote?.open)
    return previous && open ? round((open / previous - 1) * 100) : null
  }
  return null
}

export function evaluateMonitoringRule(rule, quote, { now = Date.now(), previous = {} } = {}) {
  if (!isFreshAlertQuote(quote, now)) return { state: 'WAIT_SESSION', matchedSince: 0, checkedAt: now, matched: false }
  if (rule.session === 'OPENING' && beijingMinutes(now) >= 600) {
    return { state: 'WINDOW_ENDED', matchedSince: 0, checkedAt: now, matched: false }
  }
  const values = rule.conditions.map((condition) => {
    const actual = monitoringMetric(quote, condition.metric)
    return {
      ...condition, actual,
      matched: actual == null ? null : condition.op === 'lte' ? actual <= condition.value : actual >= condition.value,
    }
  })
  const passes = rule.logic === 'ANY' ? values.some((item) => item.matched === true) : values.every((item) => item.matched === true)
  const unknown = values.some((item) => item.matched == null)
  const continuous = previous.matchedSince > 0 && previous.checkedAt <= now && now - previous.checkedAt <= 90000
  const matchedSince = passes ? continuous ? previous.matchedSince : now : 0
  const matched = passes && now - matchedSince >= rule.sustainSeconds * 1000
  return {
    state: matched ? 'MATCHED' : passes ? 'OBSERVING' : unknown ? 'MISSING_DATA' : 'WAITING',
    matched, matchedSince, checkedAt: now, values,
    remainingSeconds: passes ? Math.max(0, rule.sustainSeconds - Math.floor((now - matchedSince) / 1000)) : null,
  }
}

export function monitoringPlanOf(advice) {
  const plan = advice?.monitoringPlan
  return plan?.schemaVersion === MONITORING_PLAN_VERSION ? plan : null
}

export function monitoringAlerts(data, code, advice, now = Date.now()) {
  const plan = monitoringPlanOf(advice)
  if (!plan || plan.state !== 'READY') return []
  return plan.rules.filter((rule) => rule.action !== 'HOLD').map((rule) => {
    const id = `monitor:${plan.planId}:${rule.id}`
    const previous = data.alerts?.find((alert) => alert.id === id)
    return previous || {
      id, code, name: advice.name || data.holding?.find((item) => item.code === code)?.name || code,
      type: 'plan-condition', actCode: code, actKind: 'reduce',
      op: 'gte', value: 0, note: rule.kind === 'RISK_EXIT' ? '风险退出' : '利润退出',
      opQty: actionName(rule.action, rule.lots),
      planRule: rule, monitoringPlanId: plan.planId, validUntil: plan.validUntil,
      enabled: true, phase: 'armed', createdAt: now,
    }
  })
}

export function trackedRuleHit(alert, quote, now = Date.now()) {
  if (alert?.type !== 'plan-condition' || !alert.enabled || !alert.planRule) return null
  if (Date.parse(alert.validUntil) <= now) return null
  const state = evaluateMonitoringRule(alert.planRule, quote, { now, previous: alert.ruleState })
  alert.ruleState = state
  if (!state.matched) return null
  return state.values.filter((item) => item.matched).map((item) =>
    `${conditionText(item)}（当前${item.actual}${item.metric === 'mainNetYi' ? '亿元' : item.metric === 'price' ? '元' : '%'}）`,
  ).join(alert.planRule.logic === 'ANY' ? '；' : '，')
}

export function monitoringView(advice, { quote, alerts = [], holdQty = 0, sellableTodayQty = 0, now = Date.now() } = {}) {
  const plan = monitoringPlanOf(advice)
  if (!plan) return null
  const expired = Date.parse(plan.validUntil) <= now
  const tracked = alerts.filter((alert) => alert.monitoringPlanId === plan.planId)
  const triggered = tracked.find((alert) => alert.triggeredAt && alert.phase === 'triggered')
  const current = triggered?.planRule
  const lots = current ? Math.min(current.lots, Math.max(0, sellableTodayQty)) : 0
  const active = !expired && plan.state === 'READY' && tracked.some((alert) => alert.enabled)
  return {
    kind: current && lots > 0 ? 'sell' : 'hold',
    action: current && lots > 0 ? actionLabel(current.action) : '继续持有',
    quantity: current && lots > 0 ? `${lots}手` : `${holdQty}手`,
    instruction: triggered ? `${triggered.triggeredMsg}；请人工确认并记录实际成交`
      : expired ? '本轮条件已到期，请重新生成'
        : plan.state !== 'READY' ? `条件无法自动跟踪：${plan.errors.join('；')}`
          : !isContinuousTrading(now) ? '等待连续竞价，开盘后按下列条件跟踪'
            : !active ? '自动跟踪未开启；当前不会发送条件提醒'
              : '条件未满足，继续持有；命中后提醒本次操作',
    actionable: !!triggered && lots > 0 && !expired,
    levels: [], displayTone: current ? 'danger' : 'steady',
    monitoring: {
      active, expired, rules: plan.rules.map((rule) => {
        const alert = tracked.find((item) => item.planRule?.id === rule.id)
        const evaluated = evaluateMonitoringRule(rule, quote, { now, previous: alert?.ruleState })
        return { id: rule.id, text: ruleText(rule), state: alert?.triggeredAt ? 'TRIGGERED' : evaluated.state,
          values: evaluated.values || [], remainingSeconds: evaluated.remainingSeconds }
      }),
    },
    trigger: { direction: 'inactive', price: null, label: '条件跟踪', stateLabel: active ? '跟踪中' : '未跟踪' },
  }
}
