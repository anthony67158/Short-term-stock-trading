import {
  buildOpportunityRadarBaseline,
} from '../shared/opportunityRadarBaseline.js'
import {
  detectOpportunityDrift,
} from '../shared/opportunityDriftMonitor.js'
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
  driftHistoryLimit = 60,
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
  // 先追加漂移历史并计算漂移信号（只读监控，不改变任何排序或结论），
  // 再把 drift 并入基线快照一起持久化，供机会雷达只读展示。
  let drift = null
  if (typeof baselineStore.appendDriftHistory === 'function') {
    const history = await baselineStore.appendDriftHistory(baseline, {
      limit: driftHistoryLimit,
    })
    drift = detectOpportunityDrift({ history })
  }
  const persisted = { ...baseline, drift }
  await baselineStore.saveBaseline(persisted)
  return persisted
}
