import {
  LEARNING_EVENT_KIND,
  buildLearningEvent,
} from '../shared/learningEvent.js'
import {
  beijingDayKey,
} from '../shared/tradingCalendar.js'
import {
  learningStore,
} from './_learning_store.js'
import {
  positionOutcomeFromAttribution,
} from '../shared/learningSettlement.js'

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function text(value, maximum = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function eventDate(value, now) {
  const date = String(value || '')
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : beijingDayKey(now)
}

function stockPickCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
    code: text(candidate?.code, 12),
    rank: finite(candidate?.rank),
    rankingSource: text(candidate?.ranking?.source, 20),
    rankingScore: finite(candidate?.ranking?.score),
    pFill: finite(candidate?.model?.pFill),
    pWinGivenFill: finite(candidate?.model?.pWinGivenFill),
    expectedNetR: finite(candidate?.model?.expectedNetR),
    price: finite(candidate?.quote?.price),
    pct: finite(candidate?.quote?.pct),
    amount: finite(candidate?.quote?.amount),
    turnover: finite(candidate?.quote?.turnover),
    volumeRatio: finite(candidate?.quote?.volumeRatio),
    mainInflow: finite(candidate?.quote?.mainInflow),
    mainRatio: finite(candidate?.quote?.mainRatio),
    recallScore: finite(candidate?.recallScore),
    tradeDate: text(candidate?.quote?.tradeDate, 16),
  })).filter((candidate) => /^\d{6}$/.test(candidate.code))
}

export async function captureStockPickPrediction(snapshot, {
  store = learningStore,
  now = snapshot?.generatedAt || Date.now(),
} = {}) {
  if (!snapshot || snapshot.availability !== 'READY') return null
  const tradeDate = eventDate(snapshot.tradeDate, now)
  const sourceId = [
    'stock-pick',
    tradeDate,
    Math.trunc(Number(snapshot.generatedAt) || Number(now)),
  ].join(':')
  return store.saveEvent(buildLearningEvent({
    kind: LEARNING_EVENT_KIND.STOCK_PICK_PREDICTION,
    sourceId,
    tradeDate,
    occurredAt: Number(snapshot.generatedAt) || Number(now),
    payload: {
      availability: snapshot.availability,
      rankingSource: text(snapshot.rankingSource, 20),
      modelVersion: text(snapshot.modelVersion, 120),
      universe: {
        total: finite(snapshot.universe?.total),
        inspected: finite(snapshot.universe?.inspected),
      },
      candidates: stockPickCandidates(snapshot.candidates),
    },
  }))
}

export async function captureStockPickAgentSelection(selection, {
  store = learningStore,
  accountScope = '',
  snapshot = null,
  now = selection?.generatedAt || Date.now(),
} = {}) {
  if (!selection || selection.availability !== 'READY') return null
  const tradeDate = eventDate(
    snapshot?.tradeDate || selection.tradeDate,
    now,
  )
  const sourceId = text(
    selection.agentRunId || selection.runId,
    180,
  )
  if (!sourceId) return null
  return store.saveEvent(buildLearningEvent({
    kind: LEARNING_EVENT_KIND.STOCK_PICK_PREDICTION,
    eventId: `stock-pick-agent:${sourceId}`,
    sourceId,
    tradeDate,
    accountScope,
    occurredAt: Number(selection.generatedAt) || Number(now),
    payload: {
      stage: 'AGENT_SELECTION',
      mode: text(selection.mode, 30),
      conclusion: text(selection.conclusion, 30),
      modelVersion: text(snapshot?.modelVersion, 120),
      agentModel: text(selection.agentModel, 120),
      selections: (selection.selections || []).map((item) => ({
        code: text(item?.code, 12),
        decision: text(item?.decision, 30),
        entryPrice: finite(item?.buyStrategy?.entryPrice),
        positionPctMax: finite(item?.buyStrategy?.positionPctMax),
        invalidation: text(item?.invalidation),
      })).filter((item) => /^\d{6}$/.test(item.code)),
    },
    lineage: {
      recallGeneratedAt: finite(snapshot?.generatedAt),
    },
  }))
}

export async function capturePositionPrediction({
  code,
  mode,
  advice,
  guidance,
  accountScope = '',
  now = Date.now(),
}, {
  store = learningStore,
} = {}) {
  if (
    !/^\d{6}$/.test(String(code || ''))
    || (
      guidance?.availability !== 'READY'
      && advice?.decisionSource?.state !== 'READY'
    )
  ) return null
  const decisionSource = advice?.decisionSource || {}
  const decisionId = text(
    advice?.decisionPlan?.decisionId || guidance?.agentRunId,
    180,
  )
  if (!decisionId) return null
  const pricePlan = advice?.pricePlan || advice?.actionPlan || {}
  return store.saveEvent(buildLearningEvent({
    kind: LEARNING_EVENT_KIND.POSITION_PREDICTION,
    eventId: `position:${decisionId}`,
    sourceId: decisionId,
    tradeDate: eventDate('', now),
    accountScope,
    occurredAt: Number(guidance.generatedAt) || Number(now),
    payload: {
      code: String(code),
      mode: text(mode, 30),
      action: text(
        advice?.action
        || advice?.nextAction
        || advice?.title,
        60,
      ),
      referencePrice: finite(
        advice?.price
        ?? advice?.currentPrice
        ?? advice?.priceAtAdvice,
      ),
      entryPrice: finite(
        pricePlan?.entryPrice
        ?? pricePlan?.buyPrice
        ?? advice?.entryPrice,
      ),
      stopLoss: finite(
        pricePlan?.stopLoss
        ?? pricePlan?.stop
        ?? advice?.stop,
      ),
      takeProfit: finite(
        pricePlan?.takeProfit
        ?? pricePlan?.target
        ?? advice?.target,
      ),
      pFill: finite(decisionSource?.pFill),
      pWinGivenFill: finite(decisionSource?.pWinGivenFill),
      expectedNetR: finite(decisionSource?.expectedNetR),
      modelVersion: text(
        guidance?.modelVersion || decisionSource.modelVersion,
        120,
      ),
      agentModel: text(guidance?.agentModel, 120),
    },
    lineage: {
      agentRunId: text(guidance?.agentRunId, 180),
    },
  }))
}

export async function captureAccountLearningEvents(account, {
  store = learningStore,
  now = Date.now(),
} = {}) {
  const accountScope = account?.nick || ''
  if (!accountScope) return { executions: 0, outcomes: 0 }
  const data = account?.data || {}
  let executions = 0
  let outcomes = 0
  for (const execution of (data.decisionLog || [])) {
    if (
      execution?.kind !== 'execution'
      || execution?.source === 'simulation'
      || !execution?.id
      || !/^\d{6}$/.test(String(execution.code || ''))
    ) continue
    const occurredAt = Number(execution.at) || Number(now)
    await store.saveEvent(buildLearningEvent({
      kind: LEARNING_EVENT_KIND.EXECUTION,
      sourceId: String(execution.id),
      tradeDate: eventDate('', occurredAt),
      accountScope,
      occurredAt,
      payload: {
        code: String(execution.code),
        side: text(execution.side, 10),
        price: finite(execution.price),
        lots: finite(execution.qty ?? execution.lots),
        tradeIntent: text(execution.tradeIntent, 30),
        manuallyRecorded: execution.source === 'manual',
        linkedRecommendationId: text(
          execution.linkedRecommendationId,
          180,
        ),
        transactionId: text(execution.transactionId, 180),
      },
    }))
    executions += 1
  }
  for (const attribution of (data.executionAttributions || [])) {
    const outcome = positionOutcomeFromAttribution(attribution)
    if (!outcome) continue
    const occurredAt = Number(attribution.updatedAt) || Number(now)
    await store.saveEvent(buildLearningEvent({
      kind: LEARNING_EVENT_KIND.OUTCOME,
      eventId: `position-outcome:${outcome.planId}`,
      sourceId: outcome.planId,
      tradeDate: eventDate('', occurredAt),
      accountScope,
      occurredAt,
      payload: {
        outcomeType: 'POSITION_ACTUAL',
        ...outcome,
      },
      lineage: {
        decisionId: outcome.decisionId,
        transactionIds: (attribution.transactionIds || [])
          .map((value) => text(value, 180))
          .filter(Boolean),
      },
    }))
    outcomes += 1
  }
  return { executions, outcomes }
}
