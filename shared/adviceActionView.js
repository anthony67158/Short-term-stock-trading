const finite = (value) => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

const clean = (value, limit = 240) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

const rounded = (value, digits = 1) =>
  Number(Number(value).toFixed(digits))

const clamp = (value, low = 0, high = 100) =>
  Math.max(low, Math.min(high, value))

function quantityText(value, verb = '') {
  if (value == null || value === '') return ''
  const text = clean(value, 40)
  if (!text || /无需|不操作|不可|观望|持有\s*0|0\s*手/.test(text)) return ''
  const match = text.match(/\d+(?:\.\d+)?/)
  if (!match || !(Number(match[0]) > 0)) return ''
  if (/手/.test(text)) return text
  return `${verb}${Math.trunc(Number(match[0]))}手`
}

function actionKind(advice, mode) {
  const action = clean(advice.action || advice.stance, 80)
  if (/观望|等待|回避|不建议|暂不/.test(action)) return 'wait'
  if (/清仓|卖出|止损|离场/.test(action)) return 'sell'
  if (/减仓|止盈/.test(action)) return 'reduce'
  if (/加仓|补仓|接回|买回/.test(action)) return 'add'
  if (/持有|不动|无需操作/.test(action)) return 'hold'
  if (mode === 'buy_advice' || /买入|建仓|试错|试仓/.test(action)) return 'buy'
  return 'hold'
}

const level = (key, label, price, tone, active) => {
  const value = finite(price)
  return value == null ? null : { key, label, price: value, tone, active }
}

function levelsFor(kind, advice) {
  const entryPrice = advice.buyPrice ?? advice.addPrice
  if (kind === 'wait') {
    return [level('watch', '重新评估', advice.watchPrice, 'neutral', true)]
      .filter(Boolean)
  }
  if (kind === 'buy') {
    return [
      level('entry', '买入执行价', entryPrice, 'buy', true),
      level('target', '卖出参考', advice.targetPrice, 'sell', false),
      level('stop', '止损线', advice.stopPrice, 'risk', false),
    ].filter(Boolean)
  }
  if (kind === 'add') {
    return [
      level('add', '加仓执行价', advice.addPrice ?? advice.buyPrice, 'buy', true),
      level('reduce', '减仓参考', advice.reducePrice ?? advice.targetPrice, 'sell', false),
      level('stop', '止损线', advice.stopPrice, 'risk', false),
    ].filter(Boolean)
  }
  if (kind === 'reduce') {
    return [
      level('reduce', '减仓执行价', advice.reducePrice ?? advice.targetPrice, 'sell', true),
      level('stop', '止损线', advice.stopPrice, 'risk', false),
    ].filter(Boolean)
  }
  if (kind === 'sell') {
    const stop = level('stop', '退出执行价', advice.stopPrice, 'risk', true)
    const reduce = level('reduce', '卖出执行价', advice.reducePrice, 'sell', !stop)
    return [
      stop,
      reduce,
      level('target', '目标参考', advice.targetPrice, 'sell', false),
    ].filter(Boolean)
  }
  return [
    level('add', '回踩观察', advice.addPrice ?? advice.buyPrice, 'buy', false),
    level('reduce', '反弹观察', advice.reducePrice ?? advice.targetPrice, 'sell', false),
    level('stop', '止损线', advice.stopPrice, 'risk', false),
  ].filter(Boolean)
}

function triggerFor(kind, levels) {
  const primary = levels.find((item) => item.active)
  if (kind === 'wait') {
    return {
      direction: 'inactive',
      price: primary?.price ?? null,
      label: '重新评估',
      metricLabel: '暂不下单',
    }
  }
  if (kind === 'buy' || kind === 'add') {
    return primary ? {
      direction: 'lte',
      price: primary.price,
      label: kind === 'add' ? '加仓位' : '买入位',
      metricLabel: kind === 'add' ? '加仓准备' : '买入准备',
    } : null
  }
  if (kind === 'reduce') {
    return primary ? {
      direction: 'gte',
      price: primary.price,
      label: '减仓位',
      metricLabel: '减仓准备',
    } : null
  }
  if (kind === 'sell') {
    return primary ? {
      direction: primary.key === 'stop' ? 'lte' : 'gte',
      price: primary.price,
      label: '退出位',
      metricLabel: '退出准备',
    } : null
  }
  const low = levels.find((item) => item.key === 'add')?.price
    ?? levels.find((item) => item.key === 'stop')?.price
  const high = levels.find((item) => item.key === 'reduce')?.price
  if (low != null && high != null && high > low) {
    return {
      direction: 'range',
      low,
      high,
      label: '观察区间',
      metricLabel: '继续持有',
    }
  }
  return null
}

export function buildAdviceActionView(advice = {}, { mode = '' } = {}) {
  const kind = actionKind(advice, mode)
  const levels = levelsFor(kind, advice)
  const buySide = kind === 'buy'
  const quantity = buySide
    ? quantityText(advice.planQtyNum ?? advice.planQty)
    : quantityText(advice.opQty)
  const action = clean(advice.action || advice.stance, 80)
  const instruction = clean(
    advice.actionPlan
      || advice.nextAction
      || advice.title
      || advice.headline
      || advice.timing
      || advice.reason,
  )
  return {
    kind,
    action: action || ({
      buy: '买入',
      add: '加仓',
      reduce: '减仓',
      sell: '退出',
      hold: '持有',
      wait: '观望',
    }[kind]),
    instruction,
    quantity,
    levels,
    trigger: triggerFor(kind, levels),
  }
}

export function buildActionProgress(trigger, currentPrice) {
  const current = finite(currentPrice)
  if (!trigger || current == null || trigger.direction === 'inactive') return null

  if (trigger.direction === 'range') {
    const low = finite(trigger.low)
    const high = finite(trigger.high)
    if (low == null || high == null || !(high > low)) return null
    if (current < low) {
      const distance = (low - current) / low * 100
      return {
        pct: 0,
        score: 0,
        tone: 'risk',
        label: `低于回踩位 ${distance.toFixed(1)}%`,
        metricLabel: trigger.metricLabel,
        stateLabel: '已到回踩位',
        reached: true,
        currentPrice: current,
      }
    }
    if (current > high) {
      const distance = (current - high) / high * 100
      return {
        pct: 100,
        score: 100,
        tone: 'sell',
        label: `高于反弹位 ${distance.toFixed(1)}%`,
        metricLabel: trigger.metricLabel,
        stateLabel: '已到反弹位',
        reached: true,
        currentPrice: current,
      }
    }
    const position = clamp((current - low) / (high - low) * 100)
    return {
      pct: rounded(position),
      score: rounded(position),
      tone: 'range',
      label: position < 34
        ? '现价靠近回踩位'
        : position > 66
          ? '现价靠近反弹位'
          : '现价位于区间中部',
      metricLabel: trigger.metricLabel,
      stateLabel: '区间内持有',
      reached: false,
      currentPrice: current,
    }
  }

  const target = finite(trigger.price)
  if (target == null) return null
  const distance = trigger.direction === 'gte'
    ? (target - current) / target * 100
    : (current - target) / target * 100

  if (distance > 0) {
    const score = clamp(100 - distance / 8 * 100)
    return {
      pct: rounded(score),
      score: rounded(score),
      tone: trigger.direction === 'gte' ? 'sell' : 'buy',
      label: `距${trigger.label} ${distance.toFixed(1)}%`,
      metricLabel: trigger.metricLabel,
      stateLabel: score >= 75
        ? `接近${trigger.label}`
        : trigger.direction === 'gte'
          ? '等待反弹'
          : '等待回踩',
      reached: false,
      currentPrice: current,
    }
  }

  const crossed = Math.abs(distance)
  if (trigger.direction === 'lte' && crossed > 5) {
    const score = clamp(60 - (crossed - 5) * 10)
    return {
      pct: rounded(score),
      score: rounded(score),
      tone: 'risk',
      label: `跌穿${trigger.label} ${crossed.toFixed(1)}% · 需复核`,
      metricLabel: trigger.metricLabel,
      stateLabel: `已跌破${trigger.label}`,
      reached: true,
      currentPrice: current,
    }
  }
  return {
    pct: 100,
    score: 100,
    tone: trigger.direction === 'gte' ? 'sell' : 'buy',
    label: `已到${trigger.label} · 等确认`,
    metricLabel: trigger.metricLabel,
    stateLabel: `已到${trigger.label}`,
    reached: true,
    currentPrice: current,
  }
}
