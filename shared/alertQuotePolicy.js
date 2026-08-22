import { beijingDayKey } from './tradingCalendar.js'

export function isFreshAlertQuote(quote, now = Date.now()) {
  const price = Number(quote?.price)
  const tradeDate = String(quote?.tradeDate || '').slice(0, 10)
  return Number.isFinite(price)
    && price > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(tradeDate)
    && tradeDate === beijingDayKey(now)
}
