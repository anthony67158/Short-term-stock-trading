import {
  resolveOpportunityOutcome,
} from '../shared/opportunityOutcomeResolver.js'
import {
  beijingDayKey,
} from '../shared/tradingCalendar.js'
import {
  opportunityRadarLedgerStore,
} from './_opportunity_radar_ledger_store.js'
import {
  opportunityRadarOutcomeStore,
} from './_opportunity_radar_outcome_store.js'
import {
  fetchFiveMinuteBars,
} from './_v2_quant.js'

export const OPPORTUNITY_RADAR_SETTLEMENT_SCHEMA_VERSION =
  'opportunity-radar-settlement.v1'

function dayOffset(day, offset) {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

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

function eligibleEvents(batch) {
  return (Array.isArray(batch?.events) ? batch.events : [])
    .filter((event) => (
      event?.decision?.priceContractValid === true
      && /^\d{6}$/.test(String(event?.code || ''))
    ))
}

function persistedOutcome(batch, outcome) {
  return {
    ...outcome,
    runId: String(batch.runId || ''),
    tradeDate: String(batch.tradeDate || ''),
    mode: String(batch.mode || '').toUpperCase(),
    slot: String(batch.slot || 'manual'),
    ledgerSchemaVersion: String(batch.schemaVersion || ''),
    ruleVersion: String(
      batch.events?.find(
        (event) => event.decisionId === outcome.decisionId,
      )?.ruleVersion || '',
    ),
  }
}

export async function settleOpportunityRadarOutcomes({
  ledgerStore = opportunityRadarLedgerStore,
  outcomeStore = opportunityRadarOutcomeStore,
  fetchBars = fetchFiveMinuteBars,
  now = Date.now(),
  lookbackDays = 35,
  fetchConcurrency = 5,
} = {}) {
  const evaluatedAt = Number(now)
  if (!Number.isFinite(evaluatedAt) || evaluatedAt <= 0) {
    throw new Error('机会雷达结算时间无效')
  }
  const to = beijingDayKey(evaluatedAt)
  const from = dayOffset(
    to,
    -Math.max(1, Math.min(60, Number(lookbackDays) || 35)),
  )
  const batches = await ledgerStore.listBatches({ from, to })
  const work = []
  let existingCount = 0
  for (const batch of batches) {
    const events = eligibleEvents(batch)
    if (!events.length) continue
    const existing = await outcomeStore.listOutcomes({
      tradeDate: batch.tradeDate,
      mode: batch.mode,
      slot: batch.slot,
    })
    const existingIds = new Set(
      existing.map((item) => String(item?.decisionId || '')),
    )
    existingCount += existingIds.size
    for (const event of events) {
      if (!existingIds.has(String(event.decisionId || ''))) {
        work.push({ batch, event })
      }
    }
  }

  const codes = [...new Set(work.map(({ event }) => event.code))]
  const barsByCode = new Map()
  await mapLimit(codes, fetchConcurrency, async (code) => {
    try {
      const bars = await fetchBars(code, {
        limit: 1200,
        completedWindowOnly: false,
        adjustment: 'raw',
      })
      barsByCode.set(code, Array.isArray(bars) ? bars : [])
    } catch (error) {
      barsByCode.set(code, [])
    }
  })

  const resolved = []
  for (const { batch, event } of work) {
    const result = resolveOpportunityOutcome({
      event,
      bars: barsByCode.get(event.code) || [],
      evaluatedAt,
    })
    const value = persistedOutcome(batch, result)
    if (value.maturity === 'MATURED') {
      resolved.push(await outcomeStore.saveOutcome(value))
    } else {
      resolved.push(value)
    }
  }

  const counts = {}
  for (const item of resolved) {
    const key = String(item.outcome || 'UNKNOWN')
    counts[key] = (counts[key] || 0) + 1
  }
  return {
    schemaVersion: OPPORTUNITY_RADAR_SETTLEMENT_SCHEMA_VERSION,
    evaluatedAt,
    range: { from, to },
    batches: batches.length,
    candidates: existingCount + work.length,
    existing: existingCount,
    evaluated: resolved.length,
    matured: resolved.filter(
      (item) => item.maturity === 'MATURED',
    ).length,
    pending: resolved.filter(
      (item) => item.maturity !== 'MATURED',
    ).length,
    outcomes: counts,
  }
}
