const SELL_ACTIONS = new Set(['REDUCE', 'EXIT', 'T_SELL_FIRST'])

function lots(value) {
  if (value == null || value === '') return 0
  const match = String(value).replaceAll(',', '').match(/\d+(?:\.\d+)?/)
  const number = match ? Number(match[0]) : Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.trunc(number)
    : 0
}

function sellAction(value) {
  const action = String(value || '')
  return SELL_ACTIONS.has(action)
    || /减仓|清仓|卖出|止损|退出|离场/.test(action)
}

export function positionExitEffect({
  action,
  requestedLots,
  holdQty,
  sellableTodayQty,
} = {}) {
  const totalLots = lots(holdQty)
  const sellableLots = Math.min(
    totalLots,
    lots(sellableTodayQty ?? totalLots),
  )
  const executableLots = Math.min(lots(requestedLots), sellableLots)
  const selling = sellAction(action)
  const remainingLots = Math.max(0, totalLots - executableLots)
  const fullExit = selling
    && totalLots > 0
    && executableLots >= totalLots
  return {
    selling,
    totalLots,
    sellableLots,
    executableLots,
    remainingLots,
    fullExit,
    canonicalAction: fullExit
      ? 'EXIT'
      : String(action || ''),
    actionLabel: selling ? (fullExit ? '清仓' : '减仓') : '',
    stopAfterExecution: selling && executableLots > 0 && remainingLots > 0,
  }
}

function fullExitText(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(/减仓/g, '清仓')
    .replace(/卖出\s*(\d+(?:\.\d+)?)\s*手/g, '清仓$1手')
}

export function normalizeFullExitAdvice(
  advice,
  {
    holdQty,
    sellableTodayQty,
  } = {},
) {
  const source = advice && typeof advice === 'object' ? advice : {}
  const requestedLots = source.decisionPlan?.quantity?.lots
    ?? source.exitManagement?.lots
    ?? source.opQty
  const effect = positionExitEffect({
    action: source.decisionPlan?.action
      || source.action
      || source.stance,
    requestedLots,
    holdQty: holdQty
      ?? source.decisionPlan?.quantity?.holdingLots
      ?? source.exitManagement?.totalLots,
    sellableTodayQty: sellableTodayQty
      ?? source.decisionPlan?.quantity?.sellableLots
      ?? source.exitManagement?.sellableLots,
  })
  if (!effect.fullExit) return { advice: source, effect }

  const normalized = { ...source }
  if (source.action != null) normalized.action = '清仓'
  if (source.stance != null) normalized.stance = '清仓'
  normalized.opQty = `清仓${effect.executableLots}手`
  for (const field of [
    'actionPlan',
    'nextAction',
    'reason',
    'positionNote',
    'plain',
  ]) {
    normalized[field] = fullExitText(source[field])
  }
  const stopPrice = Number(source.stopPrice)
  const fallback = Number.isFinite(stopPrice) && stopPrice > 0
    ? `未执行前若先跌至${stopPrice}元，短暂确认非瞬时插针后止损清仓`
    : '未执行前若先触发硬止损，短暂确认非瞬时插针后止损清仓'
  normalized.exitTiming = source.decisionPlan?.activeExitPath === 'stop'
    ? '止损价到达后观察约20秒，确认有效跌破再清仓；快速深破等硬风险立即退出；成交后持仓归零，另一条退出路径自动失效'
    : [
        '反弹清仓位到达后观察约60秒，确认不能站稳且资金未改善再清仓',
        `${fallback}；快速深破等硬风险立即退出；任一路径成交后持仓归零，另一条自动失效`,
      ].join('；')
  if (source.decisionPlan?.schemaVersion === 'decision-plan.v2') {
    const confirmed = source.reviewDecision?.terminal === true
      && /减仓|清仓|锁定利润|止损|退出/.test(String(
        source.reviewDecision?.operation
        || source.reviewDecision?.outcome
        || '',
      ))
    normalized.decisionPlan = {
      ...source.decisionPlan,
      governedAction: 'EXIT',
      action: 'EXIT',
      actionLabel: '清仓',
      actionability: confirmed ? 'READY' : 'CONDITIONAL',
      actionabilityLabel: confirmed ? '可执行' : '到价后观察确认',
      positionEffect: effect,
      quantity: {
        ...source.decisionPlan.quantity,
        lots: effect.executableLots,
        holdingLots: effect.totalLots,
        sellableLots: effect.sellableLots,
        remainingLots: 0,
      },
    }
  }
  return { advice: normalized, effect }
}
