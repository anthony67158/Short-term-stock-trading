const DEFAULT_MINIMUM_SAMPLES = 8

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function actionKind(action) {
  const text = String(action || '')
  if (/清仓|卖出|止损|离场/.test(text)) return 'exit'
  if (/减仓|高抛/.test(text)) return 'reduce'
  if (/加仓|补仓|接回|买回/.test(text)) return 'add'
  if (/买入|建仓|低吸|试错|回调再买/.test(text)) return 'buy'
  if (/持有|持股/.test(text)) return 'hold'
  return 'other'
}

function rounded(value, digits = 2) {
  const scale = 10 ** digits
  return Math.round((Number(value) || 0) * scale) / scale
}

function summarize(records, minimumSamples) {
  const pnls = records.map((record) => record.netPnl)
  const wins = pnls.filter((pnl) => pnl > 0)
  const losses = pnls.filter((pnl) => pnl < 0)
  const grossProfit = wins.reduce((sum, pnl) => sum + pnl, 0)
  const grossLoss = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0))
  const netPnl = pnls.reduce((sum, pnl) => sum + pnl, 0)
  const samples = records.length
  const sampleQualified = samples >= minimumSamples
  const posteriorWinRate = (wins.length + 2) / (samples + 4) * 100
  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0 ? null : 0
  let calibration = 'insufficient'
  let riskScale = 1
  if (sampleQualified) {
    if (
      netPnl < 0
      || (profitFactor != null && profitFactor < 1)
      || posteriorWinRate < 48
    ) {
      calibration = 'defensive'
      riskScale = 0.6
    } else if (
      netPnl > 0
      && (profitFactor == null || profitFactor >= 1.3)
      && posteriorWinRate >= 55
    ) {
      calibration = 'constructive'
      riskScale = 1.1
    } else {
      calibration = 'neutral'
    }
  }
  return {
    samples,
    wins: wins.length,
    losses: losses.length,
    flat: samples - wins.length - losses.length,
    winRate: samples ? rounded(wins.length / samples * 100, 1) : null,
    posteriorWinRate: rounded(posteriorWinRate, 1),
    netPnl: rounded(netPnl),
    averageNetPnl: samples ? rounded(netPnl / samples) : null,
    grossProfit: rounded(grossProfit),
    grossLoss: rounded(grossLoss),
    profitFactor: profitFactor == null ? null : rounded(profitFactor),
    expectancy: samples ? rounded(netPnl / samples) : null,
    sampleQualified,
    calibration,
    riskScale,
  }
}

function grouped(records, keyOf, minimumSamples) {
  const groups = new Map()
  for (const record of records) {
    const key = String(keyOf(record) || 'unknown')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      ...summarize(items, minimumSamples),
    }))
    .sort((left, right) =>
      right.samples - left.samples || left.key.localeCompare(right.key)
    )
}

function latestExecutions(events) {
  const latest = new Map()
  for (const event of events) {
    if (event?.kind !== 'execution') continue
    const key = event.transactionId
      ? `transaction:${event.transactionId}`
      : event.id ? `event:${event.id}` : ''
    if (!key) continue
    const current = latest.get(key)
    if (!current || Number(event.at || 0) >= Number(current.at || 0)) {
      latest.set(key, event)
    }
  }
  return [...latest.values()]
}

export function buildRealOutcomeLearning(
  data = {},
  { minimumSamples = DEFAULT_MINIMUM_SAMPLES } = {},
) {
  const threshold = Math.max(1, Math.trunc(Number(minimumSamples) || 0))
  const events = Array.isArray(data.decisionLog) ? data.decisionLog : []
  const recommendations = new Map(events
    .filter((event) => event?.kind === 'recommendation' && event.id)
    .map((event) => [String(event.id), event]))
  const executions = latestExecutions(events)
  const linkedRecommendationIds = new Set(executions
    .map((event) => String(event.linkedRecommendationId || ''))
    .filter(Boolean))
  const excluded = {
    unexecutedAdviceOutcomes: (Array.isArray(data.adviceLog) ? data.adviceLog : [])
      .filter((record) =>
        record?.verified
        && !linkedRecommendationIds.has(String(record.id || ''))
      ).length,
    incompleteExecutions: 0,
    unlinkedExecutions: 0,
    nonExitExecutions: 0,
    tradeIntentT: 0,
    missingTransactionId: 0,
    missingNetPnl: 0,
  }
  const records = []
  for (const execution of executions) {
    if (execution.side !== 'sell') {
      excluded.nonExitExecutions++
      continue
    }
    if (execution.tradeIntent === 't') {
      excluded.tradeIntentT++
      continue
    }
    const recommendation = recommendations.get(
      String(execution.linkedRecommendationId || ''),
    )
    if (!recommendation) {
      excluded.unlinkedExecutions++
      continue
    }
    if (!execution.transactionId) {
      excluded.missingTransactionId++
      continue
    }
    if (execution.outcome?.validationComplete !== true) {
      excluded.incompleteExecutions++
      continue
    }
    const netPnl = finite(
      execution.outcome?.netPnl ?? execution.outcome?.pnl,
    )
    if (netPnl == null) {
      excluded.missingNetPnl++
      continue
    }
    records.push({
      transactionId: String(execution.transactionId || execution.id),
      recommendationId: String(recommendation.id),
      code: String(execution.code || recommendation.code || ''),
      at: Number(execution.at) || 0,
      netPnl,
      mode: String(recommendation.mode || 'unknown'),
      actionKind: actionKind(recommendation.action),
      strategyId: String(recommendation.strategyId || 'unknown'),
      marketRegime: String(
        recommendation.marketRegime
        || recommendation.marketEnv?.level
        || 'unknown',
      ),
      specVersion: String(
        recommendation.specVersion
        || recommendation.strategySpecVersion
        || 'unknown',
      ),
      attribution: String(
        execution.knowledgeActionReview?.attribution || 'unknown',
      ),
    })
  }
  return {
    schemaVersion: 'real-outcome-learning.v1',
    policy: {
      outcome: 'LINKED_VALIDATED_REALIZED_NET_PNL',
      feeAdjusted: true,
      minimumSamples: threshold,
      winRatePrior: 'BETA_2_2',
      unexecutedAdviceExcluded: true,
      unrealizedPnlExcluded: true,
    },
    generatedAt: Date.now(),
    eligibleExecutions: records.length,
    overall: summarize(records, threshold),
    groups: {
      modes: grouped(records, (record) => record.mode, threshold),
      actions: grouped(records, (record) => record.actionKind, threshold),
      strategies: grouped(records, (record) => record.strategyId, threshold),
      marketRegimes: grouped(
        records,
        (record) => record.marketRegime,
        threshold,
      ),
      modeMarkets: grouped(
        records,
        (record) => `${record.mode}|${record.marketRegime}`,
        threshold,
      ),
      specVersions: grouped(
        records,
        (record) => record.specVersion,
        threshold,
      ),
      attributions: grouped(
        records,
        (record) => record.attribution,
        threshold,
      ),
    },
    excluded,
  }
}

export function realOutcomeContext(
  profile,
  { mode, marketRegime } = {},
) {
  const minimumSamples = Math.max(
    1,
    Number(profile?.policy?.minimumSamples) || DEFAULT_MINIMUM_SAMPLES,
  )
  const modeText = String(mode || '')
  const regimeText = String(marketRegime || '')
  let selected = null
  let scope = 'none'
  if (modeText && regimeText) {
    selected = (profile?.groups?.modeMarkets || []).find(
      (item) => item.key === `${modeText}|${regimeText}`,
    ) || null
    scope = 'mode_market'
  } else if (modeText) {
    selected = (profile?.groups?.modes || []).find(
      (item) => item.key === modeText,
    ) || null
    scope = 'mode'
  }
  const qualified = !!(
    selected
    && selected.samples >= minimumSamples
    && selected.sampleQualified
  )
  return {
    schemaVersion: 'real-outcome-context.v1',
    scope,
    key: selected?.key || null,
    samples: selected?.samples || 0,
    sampleQualified: qualified,
    posteriorWinRate: qualified ? selected.posteriorWinRate : null,
    profitFactor: qualified ? selected.profitFactor : null,
    expectancy: qualified ? selected.expectancy : null,
    calibration: qualified ? selected.calibration : 'insufficient',
    riskScale: qualified ? selected.riskScale : 1,
    rule: '仅调节风险预算，不改变当前证据方向或绕过硬风控',
  }
}
