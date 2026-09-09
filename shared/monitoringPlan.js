import { beijingMinutes, isContinuousTrading } from './tradingCalendar.js'
import { isFreshAlertQuote } from './alertQuotePolicy.js'

export const MONITORING_PLAN_VERSION = 'monitoring-plan.v2'
const METRICS = new Set([
  'price',
  'pct',
  'mainNetYi',
  'retailNetYi',
  'priceVsVwapPct',
  'openChangePct',
  'volumeRatio',
  'turnover',
  'drawdownFromHighPct',
])
const OPS = new Set(['lte', 'gte'])
const ACTIONS = new Set(['EXIT', 'REDUCE', 'HOLD'])
const ACTION_ALIASES = new Map([
  ['EXIT', 'EXIT'], ['SELL_ALL', 'EXIT'], ['CLEAR', 'EXIT'],
  ['清仓', 'EXIT'], ['全部卖出', 'EXIT'], ['退出', 'EXIT'],
  ['REDUCE', 'REDUCE'], ['SELL', 'REDUCE'], ['减仓', 'REDUCE'], ['卖出', 'REDUCE'],
  ['HOLD', 'HOLD'], ['WAIT', 'HOLD'], ['持有', 'HOLD'], ['继续持有', 'HOLD'], ['观望', 'HOLD'],
])
const KIND_ALIASES = new Map([
  ['RISK_EXIT', 'RISK_EXIT'], ['STOP_LOSS', 'RISK_EXIT'], ['风险退出', 'RISK_EXIT'], ['止损', 'RISK_EXIT'],
  ['PROFIT_EXIT', 'PROFIT_EXIT'], ['TAKE_PROFIT', 'PROFIT_EXIT'], ['利润退出', 'PROFIT_EXIT'], ['止盈', 'PROFIT_EXIT'],
  ['HOLD', 'HOLD'], ['持有', 'HOLD'],
])
const LOGIC_ALIASES = new Map([
  ['ANY', 'ANY'], ['OR', 'ANY'], ['任一', 'ANY'], ['或', 'ANY'],
  ['ALL', 'ALL'], ['AND', 'ALL'], ['全部', 'ALL'], ['且', 'ALL'],
])
const METRIC_ALIASES = new Map([
  ['price', 'price'], ['currentprice', 'price'], ['stockprice', 'price'], ['股价', 'price'], ['现价', 'price'],
  ['mainnetyi', 'mainNetYi'], ['maininflow', 'mainNetYi'], ['mainnetflow', 'mainNetYi'],
  ['主力净额', 'mainNetYi'], ['主力净流入', 'mainNetYi'],
  ['retailnetyi', 'retailNetYi'], ['smallnetyi', 'retailNetYi'],
  ['小单净额', 'retailNetYi'], ['散户净额', 'retailNetYi'],
  ['pricevsvwappct', 'priceVsVwapPct'], ['pricevsvwap', 'priceVsVwapPct'], ['vwap', 'priceVsVwapPct'],
  ['分时均价', 'priceVsVwapPct'], ['均价线', 'priceVsVwapPct'],
  ['openchangepct', 'openChangePct'], ['openpct', 'openChangePct'], ['openchange', 'openChangePct'],
  ['开盘涨跌幅', 'openChangePct'], ['开盘幅度', 'openChangePct'],
  ['pct', 'pct'], ['changepct', 'pct'], ['涨跌幅', 'pct'],
  ['volumeratio', 'volumeRatio'], ['量比', 'volumeRatio'],
  ['turnover', 'turnover'], ['换手率', 'turnover'],
  ['drawdownfromhighpct', 'drawdownFromHighPct'], ['高点回撤', 'drawdownFromHighPct'],
])
const OP_ALIASES = new Map([
  ['lte', 'lte'], ['le', 'lte'], ['<=', 'lte'], ['≤', 'lte'], ['below', 'lte'], ['不高于', 'lte'],
  ['gte', 'gte'], ['ge', 'gte'], ['>=', 'gte'], ['≥', 'gte'], ['above', 'gte'], ['不低于', 'gte'],
])
const finite = (value) => value == null || value === '' ? null
  : Number.isFinite(Number(value)) ? Number(value) : null
const positive = (value) => finite(value) > 0 ? finite(value) : null
const firstPositive = (...values) => {
  for (const value of values) {
    const result = positive(value)
    if (result != null) return result
  }
  return null
}
const round = (value) => Math.round(value * 1000) / 1000
const actionName = (action, lots) => action === 'HOLD' ? '继续持有'
  : `${action === 'EXIT' ? '清仓' : '减仓'}${lots}手`
const actionLabel = (action) => action === 'HOLD' ? '继续持有'
  : action === 'EXIT' ? '清仓' : '减仓'

function normalizedKey(value) {
  return String(value || '').trim().replace(/[\s_-]+/g, '').toLowerCase()
}

function enumValue(value, aliases) {
  const raw = String(value || '').trim()
  return aliases.get(raw)
    || aliases.get(raw.toUpperCase())
    || aliases.get(normalizedKey(raw))
    || null
}

function numericValue(value) {
  const direct = finite(value)
  if (direct != null) return direct
  const matched = String(value || '')
    .trim()
    .replace(/,/g, '')
    .match(/^(-?\d+(?:\.\d+)?)\s*(?:元|亿|亿元|%|％|手)?$/)
  return matched ? finite(matched[1]) : null
}

function parsedJsonValue(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || !['[', '{'].includes(text[0])) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

function normalizeConditions(input = {}) {
  const value = parsedJsonValue(
    input.conditions ?? input.condition ?? input.when,
  )
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return [value]
  return []
}

function executionRuleList(value) {
  const parsed = parsedJsonValue(value)
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed?.rules)) return parsed.rules
  return parsed && typeof parsed === 'object' ? [parsed] : []
}

function normalizeCondition(input = {}) {
  const parsed = parsedJsonValue(input)
  const source = parsed && typeof parsed === 'object' ? parsed : {}
  return {
    metric: enumValue(source.metric ?? source.field, METRIC_ALIASES),
    op: enumValue(source.op ?? source.operator, OP_ALIASES),
    value: numericValue(source.value ?? source.threshold),
  }
}

function normalizedRule(input = {}, total = 0) {
  const parsed = parsedJsonValue(input)
  const source = parsed && typeof parsed === 'object' ? parsed : {}
  const rawConditions = normalizeConditions(source)
  const conditions = rawConditions.map(normalizeCondition)
  const kind = enumValue(source.kind ?? source.type, KIND_ALIASES)
  const action = enumValue(source.action, ACTION_ALIASES)
    || (kind === 'RISK_EXIT' ? 'EXIT' : kind === 'PROFIT_EXIT' ? 'REDUCE' : kind === 'HOLD' ? 'HOLD' : null)
  const logic = enumValue(source.logic, LOGIC_ALIASES)
    || (rawConditions.length === 1 ? 'ANY' : null)
  const requestedLots = numericValue(source.lots ?? source.qty ?? source.quantity)
  const lots = action === 'HOLD'
    ? 0
    : Math.min(
        total,
        Math.max(
          0,
          Math.trunc(
            requestedLots
            ?? (action === 'EXIT' ? total : action === 'REDUCE' ? 1 : 0),
          ),
        ),
      )
  return {
    action,
    kind: action === 'HOLD'
      ? 'HOLD'
      : kind || (
        conditions.some((condition) =>
          (
            condition.op === 'lte'
            && [
              'price',
              'mainNetYi',
              'volumeRatio',
            ].includes(condition.metric)
          )
          || (
            condition.op === 'gte'
            && condition.metric === 'drawdownFromHighPct'
          )
        ) ? 'RISK_EXIT' : 'PROFIT_EXIT'
      ),
    lots,
    logic,
    session: String(source.session || '').trim().toUpperCase() === 'OPENING'
      || /开盘/.test(String(source.session || ''))
      ? 'OPENING'
      : 'CONTINUOUS',
    sustainSeconds: numericValue(source.sustainSeconds ?? source.durationSeconds) ?? 0,
    rawConditions,
    conditions,
  }
}

function priceIsReachable(value, current, atr) {
  return !current
    || Math.abs(value - current) <= Math.max(current * 0.12, (atr || 0) * 5)
}

function strictContractPrice(decisionPlan, keys = []) {
  const levels = Array.isArray(decisionPlan?.priceContract?.levels)
    ? decisionPlan.priceContract.levels
    : []
  return firstPositive(
    ...keys.map((key) =>
      levels.find((level) => level?.key === key && level.strict === true)?.price
    ),
  )
}

function firstUsablePrice(values, predicate) {
  for (const [value, source] of values) {
    const price = positive(value)
    if (price != null && predicate(price)) return { price, source }
  }
  return null
}

function fallbackPriceRules({ advice, payload, decisionPlan, total, current, atr }) {
  const tech = payload.tech || {}
  const techAtr = firstPositive(tech.atr?.atr, tech.atr, atr)
  const stop = firstUsablePrice([
    [strictContractPrice(decisionPlan, ['stop']), 'PRICE_CONTRACT'],
    [decisionPlan?.prices?.stop, 'DECISION_PLAN'],
    [advice.stopPrice, 'ADVICE'],
    [payload.holdingStopPrice, 'HOLDING_PLAN'],
    [payload.previousAdvice?.stopPrice, 'PREVIOUS_ADVICE'],
    [tech.stopLoss ?? tech.priceHints?.stopLoss, 'TECHNICAL'],
    [tech.support ?? tech.sr?.support, 'TECHNICAL'],
    [tech.ma10 ?? tech.ma?.ma10, 'TECHNICAL'],
  ], (price) =>
    (!current || price < current)
    && priceIsReachable(price, current, techAtr)
  )
  const target = firstUsablePrice([
    [strictContractPrice(decisionPlan, ['reduce', 'target']), 'PRICE_CONTRACT'],
    [decisionPlan?.prices?.reduce, 'DECISION_PLAN'],
    [decisionPlan?.prices?.target, 'DECISION_PLAN'],
    [advice.reducePrice, 'ADVICE'],
    [advice.targetPrice, 'ADVICE'],
    [payload.previousAdvice?.reducePrice, 'PREVIOUS_ADVICE'],
    [payload.previousAdvice?.targetPrice, 'PREVIOUS_ADVICE'],
    [tech.takeProfit ?? tech.priceHints?.takeProfit, 'TECHNICAL'],
    [tech.resistance ?? tech.sr?.resistance, 'TECHNICAL'],
  ], (price) =>
    (!current || price > current)
    && priceIsReachable(price, current, techAtr)
  )
  const candidates = []
  if (stop) {
    candidates.push({
      id: 'fallback-stop',
      action: 'EXIT',
      kind: 'RISK_EXIT',
      priority: 1,
      lots: total,
      logic: 'ANY',
      conditions: [{ metric: 'price', op: 'lte', value: round(stop.price) }],
      session: 'CONTINUOUS',
      sustainSeconds: 0,
      source: stop.source,
    })
  }
  if (target) {
    const lots = Math.min(total, Math.max(1, Math.ceil(total / 2)))
    candidates.push({
      id: 'fallback-target',
      action: lots === total ? 'EXIT' : 'REDUCE',
      kind: 'PROFIT_EXIT',
      priority: 2,
      lots,
      logic: 'ANY',
      conditions: [{ metric: 'price', op: 'gte', value: round(target.price) }],
      session: 'CONTINUOUS',
      sustainSeconds: 0,
      source: target.source,
    })
  }
  return candidates
}

export function conditionText(condition) {
  const symbol = condition.op === 'lte' ? '≤' : '≥'
  return ({
    price: `股价${symbol}${condition.value}元`,
    mainNetYi: `主力净额${symbol}${condition.value}亿元`,
    retailNetYi: `小单净额${symbol}${condition.value}亿元`,
    priceVsVwapPct: `股价${condition.op === 'gte' ? '站上' : '跌破'}分时均价线`,
    openChangePct: `开盘涨跌幅${symbol}${condition.value}%`,
    pct: `当日涨跌幅${symbol}${condition.value}%`,
    volumeRatio: `量比${symbol}${condition.value}`,
    turnover: `换手率${symbol}${condition.value}%`,
    drawdownFromHighPct: `较日内高点回撤${symbol}${condition.value}%`,
  })[condition.metric] || '条件不支持'
}

export function ruleText(rule) {
  const conditions = rule.conditions.map(conditionText).join(rule.logic === 'ANY' ? ' 或 ' : ' 且 ')
  return `${rule.session === 'OPENING' ? '开盘30分钟内，' : ''}${conditions}${
    rule.sustainSeconds ? `持续${rule.sustainSeconds}秒` : ''
  } → ${actionName(rule.action, rule.lots)}`
}

export function compileMonitoringPlan({
  advice = {},
  payload = {},
  decisionPlan,
  now = Date.now(),
} = {}) {
  if (!['hold_advice', 'review'].includes(decisionPlan?.mode)) return null
  const total = Math.max(0, Math.trunc(finite(payload.holdQty) || 0))
  if (!total) return null
  const raw = executionRuleList(advice.executionRules)
  const current = positive(payload.todayQuote?.price)
  const atr = positive(payload.tech?.atr)
  const errors = []
  const warnings = []
  const rules = []
  for (const [index, ruleInput] of raw.slice(0, 8).entries()) {
    const id = `rule-${index + 1}`
    const normalized = normalizedRule(ruleInput, total)
    if (!ACTIONS.has(normalized.action) || !['ALL', 'ANY'].includes(normalized.logic)
      || normalized.rawConditions.length > 4) {
      warnings.push(`${id}的动作或条件结构无效，已忽略`)
      continue
    }
    if (!normalized.conditions.length) {
      warnings.push(`${id}为空条件，已忽略`)
      continue
    }
    const conditions = normalized.conditions
    if (conditions.some((condition) =>
      !METRICS.has(condition.metric) || !OPS.has(condition.op) || condition.value == null
      || (condition.metric === 'price' && !(condition.value > 0))
      || (condition.metric === 'priceVsVwapPct' && condition.value !== 0)
      || (condition.metric === 'openChangePct' && Math.abs(condition.value) > 30)
    )) {
      warnings.push(`${id}包含无法监控的指标或阈值，已忽略`)
      continue
    }
    if (current && conditions.some((condition) => condition.metric === 'price'
      && !priceIsReachable(condition.value, current, atr))) {
      warnings.push(`${id}的价格超出近期可达范围，已忽略`)
      continue
    }
    const protective = normalized.kind === 'RISK_EXIT'
    const lots = normalized.lots
    if (normalized.action !== 'HOLD' && !lots) {
      warnings.push(`${id}缺少有效操作手数，已忽略`)
      continue
    }
    const sustainSeconds = Math.min(120, Math.max(0, Math.trunc(normalized.sustainSeconds)))
    rules.push({
      id, action: normalized.action === 'REDUCE' && lots === total ? 'EXIT' : normalized.action,
      kind: normalized.action === 'HOLD' ? 'HOLD' : protective ? 'RISK_EXIT' : 'PROFIT_EXIT',
      priority: normalized.action === 'HOLD' ? 3 : protective ? 1 : 2,
      lots, logic: normalized.logic, conditions,
      session: normalized.session,
      sustainSeconds: conditions.some((item) => item.metric === 'priceVsVwapPct')
        ? Math.max(60, sustainSeconds) : sustainSeconds,
      source: 'MODEL',
    })
  }
  if (raw.length > 8) warnings.push('监控分支超过8条，超出部分已忽略')
  if (!rules.some((rule) => rule.action !== 'HOLD')) {
    const fallback = fallbackPriceRules({
      advice, payload, decisionPlan, total, current, atr,
    })
    if (fallback.length) {
      rules.push(...fallback)
      warnings.push('模型监控规则不可用，已按已校验止损止盈价重建')
    }
  }
  const prioritized = rules.sort((a, b) => a.priority - b.priority)
  if (prioritized.length > 3) {
    prioritized.length = 3
    warnings.push('监控分支超过3条，已保留优先级最高的3条')
  }
  if (!rules.some((rule) => rule.action !== 'HOLD')) {
    errors.push('持仓计划缺少可执行的减仓或清仓规则')
  }
  return {
    schemaVersion: MONITORING_PLAN_VERSION, planId: decisionPlan.decisionId,
    code: payload.code, createdAt: now, validUntil: decisionPlan.validUntil,
    rules: prioritized,
    state: errors.length ? 'INVALID' : 'READY', errors, warnings,
  }
}

export function attachMonitoringPlan({
  advice,
  payload,
  decisionPlan,
  now = Date.now(),
} = {}) {
  const result = advice && typeof advice === 'object' ? { ...advice } : {}
  if (decisionPlan?.action !== 'HOLD') {
    delete result.monitoringPlan
    delete result.monitoringRepair
    return result
  }
  const monitoringPlan = compileMonitoringPlan({
    advice: result,
    payload,
    decisionPlan,
    now,
  })
  if (!monitoringPlan) return result

  result.monitoringPlan = monitoringPlan
  result.monitoringRepair = {
    repaired: monitoringPlan.warnings.length > 0,
    warnings: monitoringPlan.warnings,
    unavailable: monitoringPlan.state !== 'READY',
  }
  if (monitoringPlan.state !== 'READY') return result

  const rules = monitoringPlan.rules.map(ruleText).join('；')
  result.actionPlan = `继续持有${payload.holdQty}手；${rules}`
  result.nextAction = result.actionPlan
  return result
}

export function monitoringMetric(quote, metric) {
  if (metric === 'price') return positive(quote?.price)
  if (metric === 'mainNetYi') return finite(quote?.mainInflow) == null ? null : round(Number(quote.mainInflow) / 1e8)
  if (metric === 'retailNetYi') {
    const value = finite(quote?.retailNetYi ?? quote?.smallNetYi)
    return value == null ? null : round(value)
  }
  if (metric === 'pct') return finite(quote?.pct)
  if (metric === 'volumeRatio') return finite(quote?.volumeRatio ?? quote?.volRatio)
  if (metric === 'turnover') return finite(quote?.turnover)
  if (metric === 'drawdownFromHighPct') {
    const high = positive(quote?.high)
    const price = positive(quote?.price)
    return high && price ? round((high - price) / high * 100) : null
  }
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
  if (![
    MONITORING_PLAN_VERSION,
    'monitoring-plan.v1',
  ].includes(plan?.schemaVersion)) return null
  const currentAction = String(advice?.decisionPlan?.action || '')
    .trim()
    .toUpperCase()
  if (currentAction && currentAction !== 'HOLD') return null
  const currentDecisionId = String(
    advice?.decisionPlan?.decisionId || '',
  ).trim()
  if (
    currentDecisionId
    && String(plan.planId || '').trim() !== currentDecisionId
  ) return null
  return plan
}

export function monitoringAlerts(data, code, advice, now = Date.now()) {
  const plan = monitoringPlanOf(advice)
  const validUntil = Date.parse(plan?.validUntil)
  if (
    !plan
    || plan.state !== 'READY'
    || !Number.isFinite(validUntil)
    || validUntil <= now
  ) return []
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

export function monitoringView(advice, {
  quote,
  alerts = [],
  previousStates = null,
  holdQty = 0,
  sellableTodayQty = 0,
  now = Date.now(),
} = {}) {
  const plan = monitoringPlanOf(advice)
  if (!plan) return null
  const validUntil = Date.parse(plan.validUntil)
  const expired = !Number.isFinite(validUntil) || validUntil <= now
  if (plan.state !== 'READY' || expired) return null
  const tracked = alerts.filter((alert) => alert.monitoringPlanId === plan.planId)
  const triggered = tracked.find((alert) => alert.triggeredAt && alert.phase === 'triggered')
  const current = triggered?.planRule
  const lots = current ? Math.min(current.lots, Math.max(0, sellableTodayQty)) : 0
  const active = tracked.some((alert) => alert.enabled)
  const rules = plan.rules.map((rule) => {
    const alert = tracked.find((item) => item.planRule?.id === rule.id)
    const localState = previousStates instanceof Map
      ? previousStates.get(rule.id)
      : previousStates?.[rule.id]
    const remoteState = alert?.ruleState
    const remoteCheckedAt = Number(remoteState?.checkedAt) || 0
    const localCheckedAt = Number(localState?.checkedAt) || 0
    const previous = remoteCheckedAt >= localCheckedAt
      ? remoteState
      : localState
    const evaluated = evaluateMonitoringRule(rule, quote, { now, previous })
    return {
      id: rule.id,
      text: ruleText(rule),
      state: alert?.triggeredAt ? 'TRIGGERED' : evaluated.state,
      values: evaluated.values || [],
      remainingSeconds: evaluated.remainingSeconds,
      runtimeState: evaluated,
    }
  })
  const observing = rules.some((rule) => rule.state === 'OBSERVING')
  return {
    kind: current && lots > 0 ? 'sell' : 'hold',
    action: current && lots > 0 ? actionLabel(current.action) : '继续持有',
    quantity: current && lots > 0 ? `${lots}手` : `${holdQty}手`,
    instruction: triggered ? `${triggered.triggeredMsg}；请人工确认并记录实际成交`
      : !isContinuousTrading(now) ? '等待连续竞价，开盘后按下列条件跟踪'
        : !active ? '自动跟踪未开启；当前不会发送条件提醒'
          : observing ? '到价观察中；倒计时结束后自动复核'
          : '条件未满足，继续持有；命中后提醒本次操作',
    actionable: !!triggered && lots > 0 && !expired,
    levels: [], displayTone: current ? 'danger' : 'steady',
    monitoring: {
      active, expired, observing, rules,
    },
    trigger: { direction: 'inactive', price: null, label: '条件跟踪', stateLabel: active ? '跟踪中' : '未跟踪' },
  }
}
