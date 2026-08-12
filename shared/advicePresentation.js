const clean = (value, limit = 800) => {
  if (value == null) return ''
  const result = String(value).trim().replace(/\s+/g, ' ')
  return result.length > limit
    ? `${result.slice(0, limit - 1)}…`
    : result
}

const first = (...values) =>
  values.map((value) => clean(value)).find(Boolean) || ''

const displayNumber = (value) => {
  if (value == null || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return clean(value, 120)
}

const quantity = (advice) => {
  const direct = first(advice.opQty)
  if (direct) return direct
  const planned = displayNumber(advice.planQty)
  if (!planned || planned === '0') return ''
  return /手/.test(planned) ? planned : `${planned}手`
}

function uniqueItems(items, limit = Infinity) {
  const values = new Set()
  const result = []
  for (const item of items) {
    const value = clean(item?.value ?? item?.text)
    if (!value || values.has(value)) continue
    values.add(value)
    result.push(item.value == null ? { ...item, text: value } : {
      ...item,
      value,
    })
    if (result.length >= limit) break
  }
  return result
}

function priceLevels(advice) {
  const entry = first(advice.buyZone, advice.buyPrice, advice.addPrice)
  const entryLabel = advice.buyZone
    ? '买入区间'
    : advice.buyPrice != null
      ? '建议买入价'
      : '加仓参考'
  return uniqueItems([
    entry && {
      key: 'entry',
      label: entryLabel,
      value: entry,
      tone: 'red',
    },
    advice.watchPrice != null && {
      key: 'watch',
      label: '关注价',
      value: displayNumber(advice.watchPrice),
      tone: 'muted',
    },
    advice.reducePrice != null && {
      key: 'reduce',
      label: '减仓参考',
      value: displayNumber(advice.reducePrice),
      tone: 'green',
    },
    advice.targetPrice != null && {
      key: 'target',
      label: '目标价',
      value: displayNumber(advice.targetPrice),
      tone: 'red',
    },
    advice.stopPrice != null && {
      key: 'stop',
      label: '止损价',
      value: displayNumber(advice.stopPrice),
      tone: 'green',
    },
  ].filter(Boolean), 4)
}

function coreEvidence(advice) {
  return uniqueItems([
    { key: 'quant', label: '量化', text: advice.quantNote },
    { key: 'fund', label: '资金', text: advice.fundNote },
    { key: 'trend', label: '趋势', text: advice.techNote },
    { key: 'news', label: '消息', text: advice.newsNote },
  ], 3)
}

function modelSummary(advice) {
  const context = advice.quantContext
  if (!context || typeof context !== 'object') return null
  const reliability = context.reliability || {}
  const next30m = displayNumber(
    reliability.balancedAccuracyPct?.next30m,
  )
  const sessionClose = displayNumber(
    reliability.balancedAccuracyPct?.sessionClose,
  )
  const threshold = displayNumber(reliability.thresholdPct)
  const reliabilityText = next30m || sessionClose || threshold
    ? `30分钟 ${next30m || '—'}% · 收盘 ${sessionClose || '—'}% · 门槛 ${threshold || '—'}%`
    : ''
  return {
    label: clean(context.modelLabel, 120),
    horizon: clean(context.horizon, 120),
    asOf: clean(context.asOf, 40),
    experimental: context.experimental === true,
    fallback: context.fallback || null,
    reliabilityText,
  }
}

export function buildAdvicePresentation(advice = {}) {
  const contract = advice.knowledgeActionPlan || {}
  return {
    verdict: {
      action: first(advice.action, advice.stance),
      title: first(
        advice.title,
        advice.headline,
        advice.action,
        advice.stance,
      ),
      tone: first(advice.tone, 'muted'),
      confidence: first(advice.confidence),
    },
    execution: {
      instruction: first(
        advice.actionPlan,
        advice.nextAction,
        advice.timing,
        contract.executionPlan,
      ),
      quantity: quantity(advice),
      amount: first(advice.opAmount, advice.planAmount),
      position: first(
        advice.posAfter,
        advice.planWeight,
        advice.positionNote,
        contract.positionRule,
      ),
    },
    levels: priceLevels(advice),
    trigger: {
      condition: first(
        contract.triggerConditions,
        advice.timing,
        advice.nextOpenPlan,
      ),
      confirmation: first(
        advice.exitTiming,
        contract.exitConditions,
      ),
      invalidation: first(
        contract.invalidation,
        advice.invalidation,
      ),
      validationWindow: first(contract.validationWindow),
    },
    evidence: coreEvidence(advice),
    model: modelSummary(advice),
  }
}
