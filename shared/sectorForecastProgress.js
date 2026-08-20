export const SECTOR_FORECAST_PROGRESS_STAGES = Object.freeze([
  'preparing',
  'loading',
  'collecting',
  'scoring',
  'quant',
  'searching',
  'explaining',
  'finalizing',
  'saving',
])

export function normalizeSectorForecastProgress(input = {}, now = Date.now()) {
  const stage = SECTOR_FORECAST_PROGRESS_STAGES.includes(input?.stage)
    ? input.stage
    : 'preparing'
  const rawPercent = Number(input?.percent)
  const percent = Number.isFinite(rawPercent)
    ? Math.max(1, Math.min(99, Math.round(rawPercent)))
    : 1
  return {
    stage,
    percent,
    message: String(input?.message || '正在准备板块前瞻')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80),
    updatedAt: Number(now) || Date.now(),
  }
}
