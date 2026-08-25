import {
  adviceActionKind,
  adviceNeedsVerification,
  dedupeAdviceEpisodes,
  isAdviceOutcomeCurrent,
} from './adviceOutcome.js'
import {
  humanizeUserFacingText,
  marketRegimeLabel,
} from './userFacingLanguage.js'

const RISK_INCREASING = new Set(['BUY', 'ADD', 'T_BUY_FIRST'])
const RISK_REDUCING = new Set(['REDUCE', 'EXIT', 'T_SELL_FIRST'])

function text(value, maximum = 240) {
  return String(value || '').trim().slice(0, maximum)
}

function rounded(value, digits = 4) {
  const scale = 10 ** digits
  return Math.round((Number(value) || 0) * scale) / scale
}

function strategyFrom(entry = {}) {
  const advice = entry.advice && typeof entry.advice === 'object'
    ? entry.advice
    : {}
  const plan = advice.decisionPlan || {}
  const routed = entry.meta?.strategyRoute?.production
    || entry.meta?.strategyRoute?.research
    || {}
  const strategy = plan.strategy?.strategyId ? plan.strategy : routed
  return {
    advice,
    plan,
    strategy,
  }
}

function normalizedAction(plan = {}, advice = {}) {
  const explicit = text(plan.action, 30).toUpperCase()
  if (explicit) return explicit
  return {
    bull: 'BUY',
    bear: 'REDUCE',
    hold: 'HOLD',
    wait: 'WATCH',
  }[adviceActionKind(advice.action || advice.stance)] || 'WATCH'
}

function actionLabel({
  action,
  actionability,
  scope,
}) {
  if (RISK_REDUCING.has(action)) return '优先降低风险'
  if (action === 'HOLD') return '继续持有'
  if (RISK_INCREASING.has(action)) {
    return ['READY', 'MANUAL_PROBE'].includes(actionability)
      ? scope === 'holding' ? '可以按条件加仓' : '进入买入候选'
      : '等待条件确认'
  }
  return scope === 'holding' ? '暂不调整' : '继续观察'
}

function impactOf(item, scope, entry, governanceMap) {
  const { advice, plan, strategy } = strategyFrom(entry)
  const action = normalizedAction(plan, advice)
  const actionability = text(plan.actionability, 30) || 'WATCH'
  const routedStrategyId = text(strategy.strategyId, 80)
  const governance = governanceMap.get(routedStrategyId)
  const strategyPurpose = text(
    strategy.purpose || governance?.purpose,
    30,
  )
  const incompatibleExit = scope === 'watch'
    && strategyPurpose === 'EXIT'
  const strategyId = incompatibleExit ? '' : routedStrategyId
  const signalPassed = !!strategyId
    && strategy.signalPassed !== false
    && strategy.signalReason !== 'REGIME_MISMATCH'
  const riskIncreasing = RISK_INCREASING.has(action)
  const canIncreaseRisk = riskIncreasing
    && ['READY', 'MANUAL_PROBE'].includes(actionability)
    && (
      actionability === 'MANUAL_PROBE'
      ||
      strategy.routeMode === 'PRODUCTION'
      || strategy.productionEligible === true
    )
  return {
    code: text(item?.code, 12),
    name: text(item?.name || item?.code, 40),
    scope,
    strategyId: strategyId || null,
    strategyName: incompatibleExit
      ? '暂无买入策略'
      : text(strategy.name || governance?.name, 40) || '尚未匹配',
    strategyState: text(
      strategy.governanceState || governance?.state,
      30,
    ) || null,
    action,
    actionability,
    actionLabel: actionLabel({ action, actionability, scope }),
    instruction: humanizeUserFacingText(
      text(
        advice.actionPlan
        || advice.nextAction
        || advice.title,
      ) || '等待下一次军师研判',
    ),
    signalPassed,
    canIncreaseRisk,
    manualOnly: actionability === 'MANUAL_PROBE',
    requiresManualConfirmation: true,
    generatedAt: Number(entry?.at) || null,
  }
}

export function strategyShadowMetrics(
  adviceLog = [],
  {
    strategyId,
    specVersion,
  } = {},
) {
  const relevant = (Array.isArray(adviceLog) ? adviceLog : [])
    .filter((record) =>
      record?.strategyId === strategyId
      && (!specVersion || record?.specVersion === specVersion)
    )
  const settled = dedupeAdviceEpisodes(
    relevant.filter(isAdviceOutcomeCurrent),
  )
  const pending = dedupeAdviceEpisodes(
    relevant.filter(adviceNeedsVerification),
  ).length
  let equity = 1
  let peak = 1
  let maximumDrawdown = 0
  let grossProfit = 0
  let grossLoss = 0
  for (const record of [...settled].sort(
    (left, right) => Number(left.at) - Number(right.at),
  )) {
    const resultPct = Number(record.resultPct) || 0
    equity *= 1 + resultPct / 100
    peak = Math.max(peak, equity)
    maximumDrawdown = Math.min(
      maximumDrawdown,
      peak > 0 ? equity / peak - 1 : 0,
    )
    if (resultPct > 0) grossProfit += resultPct
    if (resultPct < 0) grossLoss += Math.abs(resultPct)
  }
  return {
    samples: settled.length,
    pending,
    netReturn: rounded(equity - 1, 6),
    maximumDrawdown: rounded(maximumDrawdown, 6),
    profitFactor: grossLoss > 0
      ? rounded(grossProfit / grossLoss, 2)
      : grossProfit > 0 ? null : 0,
  }
}

export function buildStrategyRadar({
  holdings = [],
  watchlist = [],
  advice = {},
  governance = {},
} = {}) {
  const governanceRows = Array.isArray(governance.strategies)
    ? governance.strategies
    : []
  const governanceMap = new Map(
    governanceRows.map((record) => [record.strategyId, record]),
  )
  const entries = Object.values(advice || {})
    .filter((entry) => entry && typeof entry === 'object')
    .sort((left, right) => Number(right.at) - Number(left.at))
  const marketRegime = text(
    entries.find((entry) =>
      entry.meta?.marketEnv?.regime
      || entry.meta?.strategyRoute?.marketRegime
    )?.meta?.marketEnv?.regime
    || entries.find((entry) =>
      entry.meta?.strategyRoute?.marketRegime
    )?.meta?.strategyRoute?.marketRegime
    || 'UNKNOWN',
    30,
  )
  const holdingImpacts = (holdings || []).map((item) =>
    impactOf(item, 'holding', advice?.[item.code] || {}, governanceMap)
  )
  const watchImpacts = (watchlist || []).map((item) =>
    impactOf(item, 'watch', advice?.[item.code] || {}, governanceMap)
  )
  const impacts = [...holdingImpacts, ...watchImpacts]
  const strategyCounts = new Map()
  for (const impact of impacts) {
    if (!impact.strategyId || !impact.signalPassed) continue
    const current = strategyCounts.get(impact.strategyId) || {
      strategyId: impact.strategyId,
      name: impact.strategyName,
      holdingMatches: 0,
      watchMatches: 0,
      totalMatches: 0,
    }
    current.totalMatches++
    if (impact.scope === 'holding') current.holdingMatches++
    else current.watchMatches++
    strategyCounts.set(impact.strategyId, current)
  }
  const strategies = [...strategyCounts.values()].sort(
    (left, right) =>
      right.holdingMatches - left.holdingMatches
      || right.totalMatches - left.totalMatches
      || left.strategyId.localeCompare(right.strategyId),
  )
  return {
    schemaVersion: 'strategy-radar.v1',
    generatedAt: Math.max(
      0,
      ...entries.map((entry) => Number(entry.at) || 0),
    ) || null,
    marketRegime,
    marketLabel: marketRegimeLabel(marketRegime),
    primaryStrategy: strategies[0] || null,
    strategies,
    summary: {
      matchedStrategies: strategies.length,
      holdingActions: holdingImpacts.filter(
        (item) => RISK_REDUCING.has(item.action),
      ).length,
      watchCandidates: watchImpacts.filter(
        (item) => RISK_INCREASING.has(item.action) && item.signalPassed,
      ).length,
    },
    holdings: holdingImpacts,
    watchlist: watchImpacts,
    policy: {
      flexibleSelection: true,
      manualExecutionOnly: true,
      hardRiskControls: true,
    },
  }
}
