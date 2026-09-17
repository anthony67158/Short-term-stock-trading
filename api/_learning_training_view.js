import {
  LEARNING_EVENT_KIND,
  learningContentHash,
} from '../shared/learningEvent.js'
import {
  beijingDayKey,
} from '../shared/tradingCalendar.js'
import {
  learningStore,
} from './_learning_store.js'

function sortRows(rows) {
  return rows.sort((left, right) =>
    String(left.sampleId).localeCompare(String(right.sampleId))
  )
}

export async function publishLearningTrainingView({
  store = learningStore,
  now = Date.now(),
} = {}) {
  const [
    stockPickPredictions,
    positionPredictions,
    executions,
    outcomes,
  ] = await Promise.all([
    store.listEvents({
      kind: LEARNING_EVENT_KIND.STOCK_PICK_PREDICTION,
      limit: 10000,
    }),
    store.listEvents({
      kind: LEARNING_EVENT_KIND.POSITION_PREDICTION,
      limit: 10000,
    }),
    store.listEvents({
      kind: LEARNING_EVENT_KIND.EXECUTION,
      limit: 10000,
    }),
    store.listEvents({
      kind: LEARNING_EVENT_KIND.OUTCOME,
      limit: 10000,
    }),
  ])
  const predictionsById = new Map(stockPickPredictions.map((event) => [
    String(event.eventId),
    event,
  ]))
  const positionPredictionsByDecision = new Map(
    positionPredictions.map((event) => [
      String(event.sourceId || ''),
      event,
    ]),
  )

  const stockPickRows = []
  const positionRows = []
  for (const outcome of outcomes) {
    if (outcome.payload?.outcomeType === 'STOCK_PICK_T5') {
      if (outcome.payload?.feeAdjusted !== true) continue
      const prediction = predictionsById.get(
        String(outcome.lineage?.predictionEventId || ''),
      )
      stockPickRows.push({
        sampleId: outcome.eventId,
        tradeDate: prediction?.tradeDate || outcome.tradeDate,
        code: outcome.payload.code,
        modelVersion: prediction?.payload?.modelVersion || '',
        rankingScore: outcome.payload.rankingScore,
        pct: outcome.payload.pct,
        amount: outcome.payload.amount,
        turnover: outcome.payload.turnover,
        volumeRatio: outcome.payload.volumeRatio,
        mainInflow: outcome.payload.mainInflow,
        mainRatio: outcome.payload.mainRatio,
        recallScore: outcome.payload.recallScore,
        pFill: outcome.payload.pFill,
        pWinGivenFill: outcome.payload.pWinGivenFill,
        expectedNetR: outcome.payload.expectedNetR,
        labelVersion: outcome.payload.labelVersion,
        feeAdjusted: true,
        feePolicyId: outcome.payload.feePolicyId,
        assumedQuantity: outcome.payload.quantity,
        totalFees: outcome.payload.totalFees,
        grossReturnPctT5: outcome.payload.grossReturnPct,
        returnPctT5: outcome.payload.returnPct,
        mfePctT5: outcome.payload.mfePct,
        maePctT5: outcome.payload.maePct,
        directionHit: outcome.payload.directionHit,
        positive2PctHit: outcome.payload.positive2PctHit,
        targetDate: outcome.payload.targetDate,
      })
      continue
    }
    if (outcome.payload?.outcomeType !== 'POSITION_ACTUAL') continue
    const prediction = positionPredictionsByDecision.get(
      String(outcome.payload.decisionId || ''),
    )
    if (!prediction) continue
    positionRows.push({
      sampleId: outcome.eventId,
      tradeDate: outcome.tradeDate,
      accountHash: outcome.accountHash,
      code: outcome.payload.code,
      action: prediction.payload.action,
      side: outcome.payload.side,
      mode: prediction.payload.mode,
      referencePrice: prediction.payload.referencePrice,
      entryPrice: prediction.payload.entryPrice,
      stopLoss: prediction.payload.stopLoss,
      takeProfit: prediction.payload.takeProfit,
      pFill: prediction.payload.pFill,
      pWinGivenFill: prediction.payload.pWinGivenFill,
      expectedNetR: prediction.payload.expectedNetR,
      modelVersion: prediction.payload.modelVersion,
      netPnl: outcome.payload.netPnl,
      realizedNetR: outcome.payload.realizedNetR,
      expectancyErrorR: outcome.payload.expectancyErrorR,
      holdingDurationMinutes: outcome.payload.holdingDurationMinutes,
      mfePct: outcome.payload.mfePct,
      maePct: outcome.payload.maePct,
      profitCapturePct: outcome.payload.profitCapturePct,
    })
  }

  const generatedAt = Number(now)
  const date = beijingDayKey(generatedAt)
  const view = {
    schemaVersion: 'learning-training-view.v1',
    generatedAt,
    date,
    stockPick: sortRows(stockPickRows),
    position: sortRows(positionRows),
  }
  const viewHash = learningContentHash(view)
  const viewPath = `learning/v1/views/${date}/${viewHash}.json`
  const saved = await store.saveArtifact(viewPath, view)
  const manifest = await store.saveArtifact(
    `learning/v1/manifests/${date}/${viewHash}.json`,
    {
      schemaVersion: 'learning-manifest.v1',
      generatedAt,
      date,
      viewPath,
      viewHash: saved.contentHash,
      samples: {
        stockPick: stockPickRows.length,
        position: positionRows.length,
        total: stockPickRows.length + positionRows.length,
      },
      sourceEvents: {
        predictions:
          stockPickPredictions.length + positionPredictions.length,
        executions: executions.length,
        outcomes: outcomes.length,
      },
    },
  )
  return { view: saved, manifest }
}
