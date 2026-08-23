import {
  beijingMinutes,
  isContinuousTrading,
} from './tradingCalendar.js'

const OPENING_START_MINUTE = 9 * 60 + 30
const OPENING_BURST_END_MINUTE = 9 * 60 + 45

export function tradingPollingIntervals(now = Date.now()) {
  const trading = isContinuousTrading(now)
  if (!trading) {
    return {
      trading: false,
      openingBurst: false,
      marketMs: 120_000,
      alertMs: 60_000,
    }
  }

  const minute = beijingMinutes(now)
  const openingBurst = minute >= OPENING_START_MINUTE
    && minute < OPENING_BURST_END_MINUTE
  return {
    trading: true,
    openingBurst,
    marketMs: openingBurst ? 10_000 : 20_000,
    alertMs: openingBurst ? 5_000 : 10_000,
  }
}
