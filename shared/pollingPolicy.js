import {
  beijingMinutes,
  isContinuousTrading,
  isTradingDayAt,
} from './tradingCalendar.js'

const OPENING_START_MINUTE = 9 * 60 + 30
const OPENING_BURST_END_MINUTE = 9 * 60 + 45
const FINAL_REFRESH_MINUTE = 15 * 60 + 10
const QUIET_POLL_MS = 5 * 60 * 1000

export function tradingPollingIntervals(now = Date.now()) {
  const trading = isContinuousTrading(now)
  if (!trading) {
    const minute = beijingMinutes(now)
    const settled = !isTradingDayAt(now) || minute > FINAL_REFRESH_MINUTE
    return {
      trading: false,
      openingBurst: false,
      settled,
      marketMs: settled ? 0 : QUIET_POLL_MS,
      alertMs: settled ? 0 : QUIET_POLL_MS,
    }
  }

  const minute = beijingMinutes(now)
  const openingBurst = minute >= OPENING_START_MINUTE
    && minute < OPENING_BURST_END_MINUTE
  return {
    trading: true,
    openingBurst,
    settled: false,
    marketMs: openingBurst ? 10_000 : 20_000,
    alertMs: openingBurst ? 5_000 : 10_000,
  }
}
