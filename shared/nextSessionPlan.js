import {
  beijingDate,
  nextTradingDayLabel,
} from './tradingCalendar.js'

export const NEXT_SESSION_PLAN_VERSION = 'next-session-plan.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function positive(value) {
  const number = finite(value)
  return number != null && number > 0 ? number : null
}

function lots(value) {
  return Math.max(0, Math.trunc(finite(value) || 0))
}

function money(value) {
  const number = finite(value)
  return number == null ? null : Math.round(number)
}

function price(value) {
  const number = positive(value)
  return number == null ? '--' : number.toFixed(2)
}

function validUntilLabel(value) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const date = beijingDate(timestamp)
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${
    String(date.getDate()).padStart(2, '0')
  } ${String(date.getHours()).padStart(2, '0')}:${
    String(date.getMinutes()).padStart(2, '0')
  }`
}

function actionValue(advice = {}, action = '') {
  const values = Array.isArray(advice.actionValues?.actions)
    ? advice.actionValues.actions
    : []
  return finite(values.find(
    (item) => String(item?.action || '').toUpperCase() === action,
  )?.actionUtilityR)
}

function conclusionOf(action, holdingLots, plannedLots, close, stop, target) {
  if (close <= stop) {
    return {
      action: 'EXIT',
      lots: holdingLots,
      headline: `隔夜风险已触发，次日优先退出${holdingLots}手`,
      detail: `收盘价${price(close)}元已到止损区，不等待普通模型复核。`,
    }
  }
  if (action === 'EXIT') {
    return {
      action,
      lots: holdingLots,
      headline: `隔夜结论：下个交易日优先复核清仓${holdingLots}手`,
      detail: '收盘后不下单；开盘取得有效报价后完成一次退出复核。',
    }
  }
  if (action === 'REDUCE') {
    return {
      action,
      lots: plannedLots,
      headline: `隔夜结论：下个交易日优先复核减仓${plannedLots}手`,
      detail: '收盘后不下单；开盘取得有效报价后完成一次减仓复核。',
    }
  }
  if (close >= target) {
    return {
      action: 'HOLD',
      lots: 0,
      headline: `隔夜结论：继续持有${holdingLots}手，次日优先复核止盈`,
      detail: '收盘价已进入目标区，次日不直接加仓。',
    }
  }
  return {
    action: 'HOLD',
    lots: 0,
    headline: `隔夜结论：继续持有${holdingLots}手，不加仓`,
    detail: '收盘后维持现有仓位，次日按开盘路径处理。',
  }
}

function scenarioInstruction({
  key,
  action,
  holdingLots,
  plannedLots,
}) {
  if (key === 'WEAK') {
    return `触及硬止损，按次日可卖数量优先处理，目标退出${holdingLots}手。`
  }
  if (['EXIT', 'REDUCE'].includes(action)) {
    const label = action === 'EXIT' ? '清仓' : '减仓'
    return `首笔有效报价后观察约60秒；复核仍支持${label}时，卖出${plannedLots}手。`
  }
  if (key === 'STRONG') {
    return '进入目标区域后复核是否止盈；复核前不追涨加仓。'
  }
  return `继续持有${holdingLots}手，不加仓；首笔有效报价后按最新价格和资金重新核定。`
}

export function buildNextSessionPlan({
  advice = {},
  closePrice,
  holdingLots,
  sellableLots,
  now = Date.now(),
} = {}) {
  const decisionPlan = advice.decisionPlan || {}
  const source = advice.decisionSource || {}
  const action = String(decisionPlan.action || '').toUpperCase()
  const close = positive(closePrice ?? decisionPlan.prices?.current)
  const stop = positive(
    decisionPlan.prices?.stop ?? advice.stopPrice,
  )
  const target = positive(
    decisionPlan.prices?.target ?? advice.targetPrice,
  )
  const held = lots(
    holdingLots ?? decisionPlan.quantity?.holdingLots,
  )
  const sellable = lots(
    sellableLots ?? decisionPlan.quantity?.sellableLots,
  )
  const expiresAt = Date.parse(decisionPlan.validUntil)
  const requestedLots = lots(
    decisionPlan.quantity?.requestedLots
    ?? decisionPlan.quantity?.lots,
  )
  const plannedLots = action === 'EXIT'
    ? held
    : action === 'REDUCE'
      ? Math.min(held, requestedLots)
      : 0
  const missing = []
  if (source.state !== 'READY') missing.push('完整决策模型结果')
  if (!decisionPlan.decisionId) missing.push('决策编号')
  if (!['HOLD', 'ADD', 'REDUCE', 'EXIT'].includes(action)) {
    missing.push('持仓动作')
  }
  if (!(close > 0)) missing.push('收盘价')
  if (!(stop > 0)) missing.push('止损价')
  if (!(target > 0)) missing.push('目标价')
  if (held <= 0) missing.push('持仓手数')
  if (
    action === 'REDUCE'
    && plannedLots <= 0
  ) missing.push('减仓手数')
  if (
    !Number.isFinite(expiresAt)
    || expiresAt <= now
  ) missing.push('有效期限')

  const base = {
    schemaVersion: NEXT_SESSION_PLAN_VERSION,
    decisionId: decisionPlan.decisionId || null,
    generatedAt: now,
    nextSessionLabel: nextTradingDayLabel(now),
    closePrice: close,
    stopPrice: stop,
    targetPrice: target,
    holdingLots: held,
    sellableLots: sellable,
    validUntil: decisionPlan.validUntil || null,
    validUntilLabel: validUntilLabel(decisionPlan.validUntil),
  }
  if (missing.length) {
    return {
      ...base,
      state: 'INVALID',
      missing,
      conclusion: {
        action: 'INVALID',
        lots: 0,
        headline: '本轮收盘决策无效',
        detail: '不展示或执行半成品价格与手数。',
      },
      summary: `缺少${[...new Set(missing)].join('、')}，请重新生成完整收盘决策。`,
      scenarios: [],
      risk: null,
      invalidation: '重新生成完整决策后，本无效结果自动替换。',
    }
  }

  const effectiveAction = close <= stop ? 'EXIT' : action
  const effectiveLots = effectiveAction === 'EXIT'
    ? held
    : plannedLots
  const conclusion = conclusionOf(
    action,
    held,
    plannedLots,
    close,
    stop,
    target,
  )
  const scenarios = [
    {
      key: 'WEAK',
      label: '低开 / 走弱',
      condition: `开盘或盘中 ≤ ${price(stop)}元`,
      instruction: scenarioInstruction({
        key: 'WEAK',
        action: effectiveAction,
        holdingLots: held,
        plannedLots: effectiveLots,
      }),
      tone: 'risk',
    },
    {
      key: 'RANGE',
      label: '平开 / 区间',
      condition:
        `${price(stop)}元 < 开盘价 < ${price(target)}元`,
      instruction: scenarioInstruction({
        key: 'RANGE',
        action: effectiveAction,
        holdingLots: held,
        plannedLots: effectiveLots,
      }),
      tone: 'neutral',
    },
    {
      key: 'STRONG',
      label: '高开 / 走强',
      condition: `开盘或盘中 ≥ ${price(target)}元`,
      instruction: scenarioInstruction({
        key: 'STRONG',
        action: effectiveAction,
        holdingLots: held,
        plannedLots: effectiveLots,
      }),
      tone: 'target',
    },
  ]
  const riskPerShare = positive(
    decisionPlan.risk?.modelPriceRiskPerShare,
  ) ?? Math.max(0, close - stop)
  const planRiskAmount = riskPerShare * held * 100
  const selectedActionValueR = actionValue(advice, action)
  return {
    ...base,
    state: 'READY',
    missing: [],
    conclusion,
    summary:
      `${conclusion.detail} ${base.nextSessionLabel}按三种开盘路径执行，不按收盘价直接委托。`,
    scenarios,
    risk: {
      lossToStopAmount: money(
        Math.max(0, close - stop) * held * 100,
      ),
      planRiskAmount: money(planRiskAmount),
      selectedActionValueR,
      actionValueAmount: selectedActionValueR == null
        ? null
        : money(planRiskAmount * selectedActionValueR),
      note: '风险金额按收盘价和计划风险单位估算；跳空、跌停和流动性不足可能扩大实际损失。',
    },
    invalidation:
      decisionPlan.invalidation
      || '开盘越过止损或目标、账户持仓变化、出现重大事件后立即失效并重新计算。',
  }
}
