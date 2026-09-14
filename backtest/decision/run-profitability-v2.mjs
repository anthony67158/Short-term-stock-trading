import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  ACCOUNT_RISK_PROFILES,
  ACCOUNT_RISK_PROFILE_VERSION,
  resolveAccountRiskProfile,
} from '../../shared/accountRiskProfiles.js'
import { auditDecisionAccount } from './ledgerAudit.mjs'

export const PROFITABILITY_EXPERIMENT_VERSION =
  'decision-profitability-experiment.v2'
export const PROFITABILITY_RESULT_VERSION =
  'decision-profitability-result.v2'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) * fraction)]
}

function dailyReturns(curve, initialCashCents) {
  let previous = initialCashCents
  return curve.map((row) => {
    const value = previous > 0
      ? (row.equityCents / previous - 1) * 100
      : 0
    previous = row.equityCents
    return value
  })
}

function maximumDrawdownPct(curve, initialCashCents) {
  let peak = initialCashCents
  let maximum = 0
  for (const row of curve) {
    peak = Math.max(peak, row.equityCents)
    maximum = Math.max(
      maximum,
      peak > 0 ? (peak - row.equityCents) / peak * 100 : 0,
    )
  }
  return maximum
}

function maximumUnderwaterSessions(curve, initialCashCents) {
  let peak = initialCashCents
  let current = 0
  let maximum = 0
  for (const row of curve) {
    if (row.equityCents >= peak) {
      peak = row.equityCents
      current = 0
    } else {
      current += 1
      maximum = Math.max(maximum, current)
    }
  }
  return maximum
}

function exposureMetrics(curve) {
  if (!curve.length) {
    return {
      averageCapitalUtilizationPct: 0,
      maximumSinglePositionPct: 0,
      maximumPositionPct: 0,
      minimumAvailableCashPct: 100,
    }
  }
  let utilization = 0
  let concentration = 0
  let maximumPosition = 0
  let minimumAvailableCash = 100
  for (const row of curve) {
    const equity = Math.max(1, row.equityCents)
    const positionPct = row.holdingsCents / equity * 100
    utilization += positionPct
    maximumPosition = Math.max(maximumPosition, positionPct)
    minimumAvailableCash = Math.min(
      minimumAvailableCash,
      row.availableCashCents / equity * 100,
    )
    for (const position of Object.values(row.positions || {})) {
      concentration = Math.max(
        concentration,
        position.marketValueCents / equity * 100,
      )
    }
  }
  return {
    averageCapitalUtilizationPct: utilization / curve.length,
    maximumSinglePositionPct: concentration,
    maximumPositionPct: maximumPosition,
    minimumAvailableCashPct: minimumAvailableCash,
  }
}

function round(value, digits = 4) {
  return value == null
    ? null
    : +Number(value).toFixed(digits)
}

export function summarizeProfitabilityAccount(accountState) {
  const audit = auditDecisionAccount(accountState)
  const curve = accountState.curve || []
  const finalEquityCents = curve.at(-1)?.equityCents
    ?? accountState.cashCents
  const returns = dailyReturns(
    curve,
    accountState.initialCashCents,
  )
  const exposure = exposureMetrics(curve)
  const completedSellIds = new Set(
    (accountState.orders || [])
      .filter((order) => (
        order.side === 'SELL'
        && order.status === 'FILLED'
      ))
      .map((order) => order.orderId),
  )
  const realizedByOrder = new Map()
  for (const fill of accountState.fills || []) {
    if (
      fill.side !== 'SELL'
      || !completedSellIds.has(fill.orderId)
    ) continue
    realizedByOrder.set(
      fill.orderId,
      (realizedByOrder.get(fill.orderId) || 0)
        + fill.realizedPnlCents,
    )
  }
  const realizedTrades = [...realizedByOrder.values()]
  const wins = realizedTrades.filter((value) => value > 0).length
  return {
    audit,
    initialEquityCents: accountState.initialCashCents,
    finalEquityCents,
    netPnlCents: finalEquityCents - accountState.initialCashCents,
    returnPct: round(
      (finalEquityCents / accountState.initialCashCents - 1) * 100,
    ),
    maximumDrawdownPct: round(maximumDrawdownPct(
      curve,
      accountState.initialCashCents,
    )),
    dailyReturnQ10Pct: round(percentile(returns, 0.1), 6),
    maximumUnderwaterSessions: maximumUnderwaterSessions(
      curve,
      accountState.initialCashCents,
    ),
    averageCapitalUtilizationPct: round(
      exposure.averageCapitalUtilizationPct,
    ),
    maximumSinglePositionPct: round(
      exposure.maximumSinglePositionPct,
    ),
    maximumPositionPct: round(exposure.maximumPositionPct),
    minimumAvailableCashPct: round(
      exposure.minimumAvailableCashPct,
    ),
    feesCents: accountState.feesCents,
    closedTradeCount: realizedTrades.length,
    winRatePct: realizedTrades.length
      ? round(wins / realizedTrades.length * 100)
      : null,
  }
}

function validateScenarioContract(
  errors,
  profileId,
  scenarioId,
  run,
) {
  if (
    run.riskProfileVersion !== ACCOUNT_RISK_PROFILE_VERSION
    || run.riskProfile !== profileId
  ) {
    errors.push(`${scenarioId}:RISK_PROFILE_MISMATCH`)
  }
  const profile = ACCOUNT_RISK_PROFILES[profileId]
  const singleRisk = finite(
    run.riskEvidence?.maximumSingleTradeRiskPct,
  )
  const openRisk = finite(
    run.riskEvidence?.maximumOpenRiskPct,
  )
  if (
    singleRisk == null
    || openRisk == null
    || singleRisk < 0
    || openRisk < 0
  ) {
    errors.push(`${scenarioId}:RISK_EVIDENCE_REQUIRED`)
  } else {
    if (singleRisk > profile.singleTradeRiskPct) {
      errors.push(`${scenarioId}:SINGLE_TRADE_RISK_EXCEEDED`)
    }
    if (openRisk > profile.maximumOpenRiskPct) {
      errors.push(`${scenarioId}:OPEN_RISK_EXCEEDED`)
    }
  }
  const policy = run.accountState?.policy || {}
  if (scenarioId === 'primary' && policy.slippageBps !== 5) {
    errors.push('primary:BASE_SLIPPAGE_REQUIRED')
  }
  if (
    scenarioId === 'doubleSlippage'
    && policy.slippageBps !== 10
  ) {
    errors.push('doubleSlippage:TEN_BPS_REQUIRED')
  }
  if (
    scenarioId === 'nextOpen'
    && policy.stopExecution !== 'NEXT_OPEN'
  ) {
    errors.push('nextOpen:NEXT_OPEN_REQUIRED')
  }
}

function summarizeRunSet(profileId, runSet) {
  const blockers = []
  const scenarios = {}
  for (const scenarioId of [
    'primary',
    'doubleSlippage',
    'nextOpen',
  ]) {
    const run = runSet?.[scenarioId]
    if (!run?.accountState) {
      blockers.push(`${scenarioId}:ACCOUNT_STATE_REQUIRED`)
      continue
    }
    validateScenarioContract(
      blockers,
      profileId,
      scenarioId,
      run,
    )
    scenarios[scenarioId] = summarizeProfitabilityAccount(
      run.accountState,
    )
    if (!scenarios[scenarioId].audit.ok) {
      blockers.push(`${scenarioId}:LEDGER_AUDIT_FAILED`)
    }
    const profile = ACCOUNT_RISK_PROFILES[profileId]
    if (
      scenarios[scenarioId].maximumSinglePositionPct
      > profile.maximumSinglePositionPct
    ) {
      blockers.push(
        `${scenarioId}:SINGLE_POSITION_LIMIT_EXCEEDED`,
      )
    }
    if (
      scenarios[scenarioId].maximumPositionPct
      > profile.maximumPositionPct
    ) {
      blockers.push(`${scenarioId}:TOTAL_POSITION_LIMIT_EXCEEDED`)
    }
    if (
      scenarios[scenarioId].minimumAvailableCashPct
      < profile.minimumCashReservePct
    ) {
      blockers.push(`${scenarioId}:CASH_RESERVE_VIOLATED`)
    }
  }
  return { scenarios, blockers }
}

function qualifyBaseline(runSet, qualification = {}) {
  const result = summarizeRunSet('BASELINE', runSet)
  const primary = result.scenarios.primary
  const doubleSlippage = result.scenarios.doubleSlippage
  const nextOpen = result.scenarios.nextOpen
  if (runSet?.modelProductionEligible !== true) {
    result.blockers.push('MODEL_NOT_PRODUCTION_ELIGIBLE')
  }
  if (runSet?.confirmationLocked !== true) {
    result.blockers.push('FINAL_CONFIRMATION_NOT_LOCKED')
  }
  if (
    !primary
    || primary.netPnlCents <= (
      finite(qualification.minimumNetPnlCents) ?? 0
    )
  ) {
    result.blockers.push('BASELINE_NET_PROFIT_NOT_POSITIVE')
  }
  if (
    !primary
    || primary.closedTradeCount < (
      finite(qualification.minimumClosedTrades) ?? 30
    )
  ) {
    result.blockers.push('INSUFFICIENT_CLOSED_TRADES')
  }
  if (
    !(finite(runSet?.pairedExcessLower95Pct) > (
      finite(qualification.minimumPairedExcessLower95Pct) ?? 0
    ))
  ) {
    result.blockers.push('PAIRED_EXCESS_LOWER_BOUND_NOT_POSITIVE')
  }
  if (
    !doubleSlippage
    || !nextOpen
    || doubleSlippage.netPnlCents <= 0
    || nextOpen.netPnlCents <= 0
  ) {
    result.blockers.push('EXECUTION_STRESS_REMOVES_ADVANTAGE')
  }
  return {
    status: result.blockers.length
      ? 'BASELINE_REJECTED'
      : 'BASELINE_QUALIFIED',
    blockers: [...new Set(result.blockers)],
    pairedExcessLower95Pct:
      finite(runSet?.pairedExcessLower95Pct),
    scenarios: result.scenarios,
  }
}

function elevatedComparison(runSet, baseline) {
  const result = summarizeRunSet('ELEVATED_RESEARCH', runSet)
  if (result.blockers.length) {
    return {
      status: 'ELEVATED_REJECTED',
      blockers: result.blockers,
      scenarios: result.scenarios,
    }
  }
  const base = baseline.scenarios.primary
  const elevated = result.scenarios.primary
  return {
    status: 'ELEVATED_RESEARCH_COMPLETE',
    blockers: [],
    scenarios: result.scenarios,
    comparison: {
      netPnlDeltaCents:
        elevated.netPnlCents - base.netPnlCents,
      returnDeltaPct: round(
        elevated.returnPct - base.returnPct,
      ),
      maximumDrawdownDeltaPct: round(
        elevated.maximumDrawdownPct
        - base.maximumDrawdownPct,
      ),
      dailyReturnQ10DeltaPct: round(
        elevated.dailyReturnQ10Pct
        - base.dailyReturnQ10Pct,
        6,
      ),
      capitalUtilizationDeltaPct: round(
        elevated.averageCapitalUtilizationPct
        - base.averageCapitalUtilizationPct,
      ),
      modelImprovementClaimed: false,
      interpretation: 'RISK_PROFILE_COMPARISON_ONLY',
    },
  }
}

function missingReplayBlockers(experiment) {
  const required = experiment.requiredInputs || {}
  const blockers = []
  if (!required.decisionEventStream) {
    blockers.push('DECISION_EVENT_STREAM_MISSING')
  }
  if (!required.benchmarkCurve) {
    blockers.push('RISK_MATCHED_BENCHMARK_MISSING')
  }
  if (!required.reviewModelRelease) {
    blockers.push('V2_REVIEW_MODEL_RELEASE_MISSING')
  }
  return blockers
}

export function evaluateProfitabilityExperiment(experiment = {}) {
  if (experiment.schemaVersion !== PROFITABILITY_EXPERIMENT_VERSION) {
    throw new Error('PROFITABILITY_EXPERIMENT_VERSION_MISMATCH')
  }
  const baselineInput = experiment.runs?.BASELINE
  let baseline
  if (!baselineInput) {
    baseline = {
      status: 'BLOCKED_INCOMPLETE_REPLAY_EVIDENCE',
      blockers: missingReplayBlockers(experiment),
      scenarios: {},
      legacyEvidence: experiment.legacyEvidence || null,
    }
  } else {
    baseline = qualifyBaseline(
      baselineInput,
      experiment.qualification,
    )
    const sourceBlockers = missingReplayBlockers(experiment)
    if (sourceBlockers.length) {
      baseline.status = 'BASELINE_REJECTED'
      baseline.blockers = [
        ...new Set([...baseline.blockers, ...sourceBlockers]),
      ]
    }
  }
  const baselineQualified =
    baseline.status === 'BASELINE_QUALIFIED'
  let elevated
  if (!baselineQualified) {
    elevated = {
      status: 'NOT_AUTHORIZED_BASELINE_FAILED',
      blockers: ['BASELINE_NOT_QUALIFIED'],
      suppliedRunIgnored: Boolean(
        experiment.runs?.ELEVATED_RESEARCH,
      ),
    }
  } else if (!experiment.runs?.ELEVATED_RESEARCH) {
    elevated = {
      status: 'NOT_RUN',
      blockers: ['ELEVATED_RUN_REQUIRED'],
    }
  } else {
    resolveAccountRiskProfile('ELEVATED_RESEARCH', {
      purpose: 'RESEARCH',
      baselineQualified: true,
    })
    elevated = elevatedComparison(
      experiment.runs.ELEVATED_RESEARCH,
      baseline,
    )
  }
  const result = {
    schemaVersion: PROFITABILITY_RESULT_VERSION,
    experimentId: String(experiment.experimentId || ''),
    evidenceClass: String(
      experiment.evidenceClass || 'RESEARCH_REGRESSION',
    ),
    productionEligible: false,
    baseline,
    elevated,
    absoluteCap: {
      status: 'HARD_LIMIT_ONLY',
      productionAuthorized: false,
      profile: ACCOUNT_RISK_PROFILES.ABSOLUTE_CAP,
    },
    conclusion: baselineQualified
      ? 'BASELINE_QUALIFIED_ELEVATED_RESEARCH_ALLOWED'
      : 'NO_PROFITABILITY_CLAIM',
  }
  result.resultHash = createHash('sha256')
    .update(JSON.stringify(result))
    .digest('hex')
  return result
}

function parseArguments(argv) {
  const values = {
    input: 'backtest/decision/experiment-v2.json',
    output: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') {
      values.output = argv[++index]
    } else {
      values.input = argv[index]
    }
  }
  return values
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = parseArguments(process.argv.slice(2))
  const experiment = JSON.parse(
    fs.readFileSync(path.resolve(args.input), 'utf8'),
  )
  const result = evaluateProfitabilityExperiment(experiment)
  const encoded = `${JSON.stringify(result, null, 2)}\n`
  if (args.output) {
    const output = path.resolve(args.output)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, encoded)
  }
  process.stdout.write(encoded)
  if (!result.baseline.status.includes('QUALIFIED')) {
    process.exitCode = 2
  }
}
