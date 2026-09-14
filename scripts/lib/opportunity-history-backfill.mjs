import {
  buildOpportunityRadarLedgerBatch,
} from '../../shared/opportunityRadarLedger.js'
import {
  resolveOpportunityOutcome,
} from '../../shared/opportunityOutcomeResolver.js'
import {
  A_SHARE_STANDARD_FEE_POLICY,
  tradeFees,
} from '../../shared/ashareStrategyExecution.js'
import {
  buildOpportunityScoreInput,
} from '../../shared/opportunityScoreContract.js'
import {
  buildOpportunityReviewFeatureInputV2,
  OPPORTUNITY_REVIEW_OBSERVATION_POLICY_VERSION,
} from '../../shared/opportunityReviewFeatures.js'
import { reviewPriceContract } from '../../shared/reviewPriceContract.js'
import { TRAILING_EXIT_VERSION } from '../../shared/trailingExit.js'

const REVIEW_OBSERVATION_MS = 10 * 60 * 1000
const REVIEW_LABEL_CONTRACT_VERSION = 'trigger-review-label.v2'

function routeKey(decision, index) {
  return String(
    decision?.route || decision?.priceType || index + 1,
  ).slice(0, 40)
}

export function buildHistoricalLedgerBatch({
  mode,
  tradeDate,
  slot,
  generatedAt,
  source = 'STOCKDB_CAUSAL_REPLAY',
  scan,
  marketContext,
} = {}) {
  const events = (Array.isArray(scan?.candidateEvents)
    ? scan.candidateEvents
    : [])
    .filter((event) =>
      Array.isArray(event?.counterfactualPlans)
      && event.counterfactualPlans.some(
        (decision) => decision?.priceContractValid === true,
      )
    )
  const batch = buildOpportunityRadarLedgerBatch({
    mode,
    tradeDate,
    slot,
    generatedAt,
    universe: scan?.universe || {},
    marketGate: marketContext?.marketGate || null,
    events,
  })
  return {
    ...batch,
    source: String(source || 'STOCKDB_CAUSAL_REPLAY').slice(0, 60),
  }
}

export function expandHistoricalLedgerBatch(batch = {}) {
  return (Array.isArray(batch.events) ? batch.events : [])
    .flatMap((event) => {
      const plans = event.counterfactualPlans?.length
        ? event.counterfactualPlans
        : [event.decision]
      return plans
        .filter((decision) => decision?.priceContractValid === true)
        .map((decision, index) => {
          const selected = (
            decision.route === event.decision?.route
            && decision.primaryPrice === event.decision?.primaryPrice
          )
          return {
            ...event,
            tradeDate: batch.tradeDate,
            mode: batch.mode,
            parentDecisionId: event.decisionId,
            decisionId:
              `${event.decisionId}:${routeKey(decision, index)}`,
            decision,
            stageReached: selected ? event.stageReached : 'EVIDENCE',
            displayedRank: selected ? event.displayedRank : null,
          }
        })
    })
}

function contextOf(event, batch, scoreInput) {
  return {
    source: String(
      batch?.source || 'STOCKDB_CAUSAL_REPLAY',
    ).slice(0, 60),
    historicalBackfill: true,
    stageReached: String(event.stageReached || 'UNKNOWN'),
    displayedRank: Number(event.displayedRank) || null,
    marketRegimeLabel:
      String(batch.marketGate?.regimeLabel || '') || null,
    ...scoreInput.dimensions,
    patternRecallAdded: event.recall?.patternAdded === true,
    patternId: String(event.recall?.patternId || '') || null,
    patternScore: Number.isFinite(Number(event.recall?.patternScore))
      ? Number(event.recall.patternScore)
      : null,
    amount: Number.isFinite(Number(event.quote?.amount))
      ? Number(event.quote.amount)
      : null,
    turnover: Number.isFinite(Number(event.quote?.turnover))
      ? Number(event.quote.turnover)
      : null,
  }
}

function barTimestamp(value) {
  const text = String(
    value?.tradeTime
    || value?.timestamp
    || '',
  ).trim()
  if (!text) return null
  const normalized = text.includes('T')
    ? text
    : text.replace(' ', 'T')
  const timestamp = Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
      ? normalized
      : `${normalized}+08:00`,
  )
  return Number.isFinite(timestamp) ? timestamp : null
}

function reviewFeatureInput(event, outcome, bars) {
  const triggeredAt = Number(outcome?.trigger?.at)
  if (!(triggeredAt > 0)) return null
  const observationCompleteAt = triggeredAt + REVIEW_OBSERVATION_MS
  const rows = (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      ...bar,
      at: barTimestamp(bar),
    }))
    .filter((bar) =>
      bar.at != null
      && bar.at > triggeredAt
      && bar.at <= observationCompleteAt
    )
    .sort((left, right) => left.at - right.at)
    .slice(0, 2)
  if (rows.at(-1)?.at < observationCompleteAt) return null
  const entryPrice = Number(rows.at(-1)?.price ?? rows.at(-1)?.close)
  const stopPrice = Number(event.decision?.stopPrice)
  const lotSize = /^68[89]/.test(String(event.code || '')) ? 200 : 100
  if (!(entryPrice > stopPrice) || !(stopPrice > 0)) return null
  const entryGross = entryPrice * lotSize
  const exitGross = stopPrice * lotSize
  const feeRateBps = (
    tradeFees('BUY', entryGross, A_SHARE_STANDARD_FEE_POLICY).total
    + tradeFees('SELL', exitGross, A_SHARE_STANDARD_FEE_POLICY).total
  ) / entryGross * 10_000
  const priceInput = {
    entryPrice,
    stopPrice,
    feeRateBps,
    slippageBps: 5,
    lotSize,
    tPlusOne: true,
    exitPolicyVersion:
      event.decision?.trailingStop?.schemaVersion
      || event.decision?.exitPlan?.trailingStop?.schemaVersion
      || TRAILING_EXIT_VERSION,
    observationPolicyVersion:
      OPPORTUNITY_REVIEW_OBSERVATION_POLICY_VERSION,
  }
  const bound = reviewPriceContract(priceInput)
  const features = buildOpportunityReviewFeatureInputV2({
    code: event.code,
    asOf: rows.at(-1)?.at,
    triggerPrice: outcome.trigger?.price,
    direction:
      event.decision?.route
      || event.decision?.priceType,
    rows,
    initialScore: event.opportunityScore,
    priceContract: priceInput,
  })
  return features && bound ? {
    ...features,
    priceContract: bound.canonical,
    priceContractHash: bound.hash,
  } : null
}

function alignReviewRiskBasis(outcome, reviewScoreInput) {
  if (
    outcome?.fillStatus !== 'FILLED'
    || !outcome.metrics
    || !reviewScoreInput?.priceContract
  ) return outcome
  const quantity = Number(outcome.entry?.quantity)
  const netPnl = Number(outcome.metrics.netPnl)
  const riskPerShare = (
    Number(reviewScoreInput.priceContract.priceRiskMilliCny) / 1000
  )
  const riskCash = riskPerShare * quantity
  if (!(quantity > 0) || !(riskCash > 0) || !Number.isFinite(netPnl)) {
    return outcome
  }
  return {
    ...outcome,
    metrics: {
      ...outcome.metrics,
      netR: +(netPnl / riskCash).toFixed(3),
      initialRiskCash: +riskCash.toFixed(2),
      riskBasis: 'REVIEW_PRICE_CONTRACT_V2',
    },
  }
}

export function settleHistoricalEvent({
  batch,
  event,
  bars,
  evaluatedAt,
  expectedEntryDate,
} = {}) {
  const scoreInput = buildOpportunityScoreInput({ event, batch })
  const lotSize = /^68[89]/.test(String(event.code || '')) ? 200 : 100
  const resolved = resolveOpportunityOutcome({
    event,
    bars,
    evaluatedAt,
    quantity: lotSize,
    lotSize,
    postTriggerObservationMs: REVIEW_OBSERVATION_MS,
    expectedEntryDate,
  })
  const reviewScoreInput = reviewFeatureInput(event, resolved, bars)
  const outcome = alignReviewRiskBasis(resolved, reviewScoreInput)
  return {
    ...outcome,
    reviewScoreInput,
    labelSource: 'HISTORICAL_SIMULATION',
    labelContractVersion: REVIEW_LABEL_CONTRACT_VERSION,
    exitContractVersion:
      event.decision?.trailingStop?.schemaVersion
      || event.decision?.exitPlan?.trailingStop?.schemaVersion
      || TRAILING_EXIT_VERSION,
    runId: String(batch.runId || ''),
    tradeDate: String(batch.tradeDate || ''),
    mode: String(batch.mode || '').toUpperCase(),
    slot: String(batch.slot || 'manual'),
    ledgerSchemaVersion: String(batch.schemaVersion || ''),
    ruleVersion: String(event.ruleVersion || ''),
    parentDecisionId: String(event.parentDecisionId || ''),
    playbookId: String(event.decision?.playbookId || ''),
    route: String(event.decision?.route || ''),
    context: contextOf(event, batch, scoreInput),
    scoreInput,
  }
}

export function mergeHistoricalOutcomes(...groups) {
  const unique = new Map()
  for (const group of groups) {
    const values = Array.isArray(group)
      ? group
      : Array.isArray(group?.outcomes) ? group.outcomes : []
    for (const outcome of values) {
      const decisionId = String(outcome?.decisionId || '')
      if (!decisionId) continue
      unique.set(decisionId, outcome)
    }
  }
  return [...unique.values()].sort((left, right) =>
    String(left.tradeDate).localeCompare(String(right.tradeDate))
    || left.decisionId.localeCompare(right.decisionId)
  )
}
