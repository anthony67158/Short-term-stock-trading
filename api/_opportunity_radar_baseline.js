import {
  buildOpportunityRadarBaseline,
} from '../shared/opportunityRadarBaseline.js'
import {
  beijingDayKey,
} from '../shared/tradingCalendar.js'
import {
  opportunityRadarBaselineStore,
} from './_opportunity_radar_baseline_store.js'
import {
  opportunityRadarOutcomeStore,
} from './_opportunity_radar_outcome_store.js'

function dayOffset(day, offset) {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export async function refreshOpportunityRadarBaseline({
  outcomeStore = opportunityRadarOutcomeStore,
  baselineStore = opportunityRadarBaselineStore,
  now = Date.now(),
  lookbackDays = 180,
} = {}) {
  const generatedAt = Number(now)
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) {
    throw new Error('机会雷达基线刷新时间无效')
  }
  const to = beijingDayKey(generatedAt)
  const from = dayOffset(
    to,
    -Math.max(1, Math.min(365, Number(lookbackDays) || 180)),
  )
  const outcomes = await outcomeStore.listOutcomeRange({ from, to })
  const baseline = buildOpportunityRadarBaseline(outcomes, {
    generatedAt,
    from,
    to,
  })
  await baselineStore.saveBaseline(baseline)
  return baseline
}
