import {
  LEARNING_EVENT_KIND,
  buildLearningEvent,
} from '../shared/learningEvent.js'
import {
  settleStockPickCandidate,
} from '../shared/learningSettlement.js'
import {
  listAllAccounts,
} from './account.js'
import {
  captureAccountLearningEvents,
} from './_learning_capture.js'
import {
  learningStore,
} from './_learning_store.js'
import {
  fetchResilientKline,
} from './stock_detail.js'

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  const workers = Array.from({
    length: Math.min(concurrency, items.length),
  }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return output
}

export async function settleLearningEvents({
  store = learningStore,
  accounts = listAllAccounts,
  fetchBars = (code) => fetchResilientKline(code, '101', 30),
  now = Date.now(),
  concurrency = 5,
} = {}) {
  const predictions = await store.listEvents({
    kind: LEARNING_EVENT_KIND.STOCK_PICK_PREDICTION,
    limit: 10000,
  })
  const existingOutcomes = await store.listEvents({
    kind: LEARNING_EVENT_KIND.OUTCOME,
    limit: 10000,
  })
  const settledIds = new Set(existingOutcomes
    .filter((event) =>
      event?.payload?.outcomeType === 'STOCK_PICK_T5'
    )
    .map((event) => String(event.sourceId || '')))
  const work = predictions.flatMap((prediction) => {
    if (prediction?.payload?.stage === 'AGENT_SELECTION') return []
    return (prediction?.payload?.candidates || []).map((candidate) => ({
      prediction,
      candidate,
      sourceId: `${prediction.eventId}:${candidate.code}`,
    }))
  }).filter((item) => !settledIds.has(item.sourceId))
  const barsByCode = new Map()
  const codes = [...new Set(work.map((item) => item.candidate.code))]
  await mapLimit(codes, concurrency, async (code) => {
    try {
      barsByCode.set(code, await fetchBars(code))
    } catch {
      barsByCode.set(code, [])
    }
  })

  let matured = 0
  let pending = 0
  for (const item of work) {
    const result = settleStockPickCandidate({
      prediction: item.prediction,
      candidate: item.candidate,
      bars: barsByCode.get(item.candidate.code),
      evaluatedAt: now,
    })
    if (result.maturity !== 'MATURED') {
      pending += 1
      continue
    }
    await store.saveEvent(buildLearningEvent({
      kind: LEARNING_EVENT_KIND.OUTCOME,
      eventId: `stock-pick-outcome:${item.sourceId}`,
      sourceId: item.sourceId,
      tradeDate: item.prediction.tradeDate,
      occurredAt: now,
      payload: {
        outcomeType: 'STOCK_PICK_T5',
        code: item.candidate.code,
        rankingScore: item.candidate.rankingScore,
        pct: item.candidate.pct,
        amount: item.candidate.amount,
        turnover: item.candidate.turnover,
        volumeRatio: item.candidate.volumeRatio,
        mainInflow: item.candidate.mainInflow,
        mainRatio: item.candidate.mainRatio,
        recallScore: item.candidate.recallScore,
        pFill: item.candidate.pFill,
        pWinGivenFill: item.candidate.pWinGivenFill,
        expectedNetR: item.candidate.expectedNetR,
        ...result,
      },
      lineage: {
        predictionEventId: item.prediction.eventId,
        predictionContentHash: item.prediction.contentHash,
      },
    }))
    matured += 1
  }

  let accountCount = 0
  let executions = 0
  let positionOutcomes = 0
  for (const account of await accounts()) {
    const captured = await captureAccountLearningEvents(account, {
      store,
      now,
    })
    accountCount += 1
    executions += captured.executions
    positionOutcomes += captured.outcomes
  }
  return {
    schemaVersion: 'learning-settlement.v1',
    evaluatedAt: now,
    stockPick: {
      predictions: predictions.length,
      candidates: work.length,
      matured,
      pending,
    },
    position: {
      accounts: accountCount,
      executions,
      matured: positionOutcomes,
    },
  }
}
