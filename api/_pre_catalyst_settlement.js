import {
  buildPreCatalystEvaluation,
  resolvePreCatalystOutcome,
} from '../shared/preCatalystEvaluation.js'
import {
  fetchTailPickIndexSeries,
} from './_tail_pick_data.js'
import {
  fetchKlineTx,
} from './stock_detail.js'
import {
  preCatalystStore,
} from './_pre_catalyst_store.js'

function outcomeKey(value = {}) {
  return `${String(value.eventId || '')}:${String(value.code || '')}`
}

function candidateKey(candidate = {}) {
  return `${String(
    candidate.event?.eventId || candidate.eventIds?.[0] || '',
  )}:${String(candidate.code || '')}`
}

function marketBarsFor(code, indexSeries = []) {
  const preferred = /^(6|68|9)/.test(String(code || ''))
    ? '000001'
    : '399001'
  return (indexSeries.find((item) => item?.code === preferred)
    || indexSeries[0]
    || {}).candles || []
}

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        output[index] = await mapper(items[index], index)
      }
    },
  )
  await Promise.all(workers)
  return output
}

export async function settlePreCatalystOutcomes({
  store = preCatalystStore,
  fetchKline = fetchKlineTx,
  fetchIndices = fetchTailPickIndexSeries,
  runLimit = 80,
} = {}) {
  const [runs, existing, indexSeries] = await Promise.all([
    store.listRuns(runLimit),
    store.listOutcomes(5000),
    fetchIndices(),
  ])
  const existingKeys = new Set(existing.map(outcomeKey))
  const candidates = new Map()
  for (const run of [...runs].sort((left, right) =>
    Number(left?.generatedAt || 0) - Number(right?.generatedAt || 0)
  )) {
    for (const candidate of (run?.candidates || [])) {
      const key = candidateKey(candidate)
      if (!key || key === ':' || existingKeys.has(key)) continue
      if (!candidates.has(key)) candidates.set(key, candidate)
    }
  }
  let matured = 0
  let pending = 0
  let failed = 0
  const outcomes = await mapLimit(
    [...candidates.values()].slice(0, 240),
    8,
    async (candidate) => {
      try {
        const stock = await fetchKline(
          candidate.code,
          '101',
          30,
        )
        const outcome = resolvePreCatalystOutcome({
          candidate,
          stockBars: stock?.candles || [],
          marketBars: marketBarsFor(candidate.code, indexSeries),
        })
        if (!outcome.mature) {
          pending += 1
          return null
        }
        await store.saveOutcome(outcome)
        matured += 1
        return outcome
      } catch {
        failed += 1
        return null
      }
    },
  )
  const allOutcomes = [
    ...existing,
    ...outcomes.filter(Boolean),
  ]
  const evaluation = buildPreCatalystEvaluation(allOutcomes)
  await store.saveEvaluation(evaluation)
  return {
    scanned: candidates.size,
    matured,
    pending,
    failed,
    evaluation,
  }
}
