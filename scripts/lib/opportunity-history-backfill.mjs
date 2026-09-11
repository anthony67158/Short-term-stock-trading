import {
  buildOpportunityRadarLedgerBatch,
} from '../../shared/opportunityRadarLedger.js'
import {
  resolveOpportunityOutcome,
} from '../../shared/opportunityOutcomeResolver.js'
import {
  buildOpportunityScoreInput,
} from '../../shared/opportunityScoreContract.js'
import {
  buildOpportunityReviewFeatureInput,
} from '../../shared/opportunityReviewFeatures.js'

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
  const rows = (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      ...bar,
      at: barTimestamp(bar),
    }))
    .filter((bar) =>
      bar.at != null
      && bar.at >= triggeredAt
      && bar.at <= triggeredAt + 10 * 60 * 1000
    )
    .sort((left, right) => left.at - right.at)
    .slice(0, 2)
  return buildOpportunityReviewFeatureInput({
    code: event.code,
    asOf: rows.at(-1)?.at,
    triggerPrice: outcome.trigger?.price,
    direction:
      event.decision?.route
      || event.decision?.priceType,
    rows,
    initialScore: event.opportunityScore,
  })
}

export function settleHistoricalEvent({
  batch,
  event,
  bars,
  evaluatedAt,
} = {}) {
  const scoreInput = buildOpportunityScoreInput({ event, batch })
  const outcome = resolveOpportunityOutcome({
    event,
    bars,
    evaluatedAt,
  })
  return {
    ...outcome,
    reviewScoreInput: reviewFeatureInput(
      event,
      outcome,
      bars,
    ),
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
      if (!decisionId || outcome?.maturity !== 'MATURED') continue
      unique.set(decisionId, outcome)
    }
  }
  return [...unique.values()].sort((left, right) =>
    String(left.tradeDate).localeCompare(String(right.tradeDate))
    || left.decisionId.localeCompare(right.decisionId)
  )
}
