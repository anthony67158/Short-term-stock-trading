function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function yuanToYi(value) {
  const number = finite(value)
  return number == null ? null : rounded(number / 1e8)
}

function day(value) {
  return String(value || '').slice(0, 10)
}

export function buildStockMarketSnapshot({
  quote = null,
  candles = [],
  fund = null,
} = {}) {
  const daily = (Array.isArray(candles) ? candles : [])
    .filter((item) => item?.date && finite(item.close) != null)
  const recentCandles = daily.slice(-5)
  const latestCandle = recentCandles.at(-1) || null
  const baseline = daily.length > recentCandles.length
    ? daily[daily.length - recentCandles.length - 1]
    : null
  const baseClose = finite(baseline?.close)
  const latestClose = finite(latestCandle?.close)
  const priceChangePct = (
    baseClose != null
    && baseClose > 0
    && latestClose != null
  )
    ? rounded((latestClose - baseClose) / baseClose * 100)
    : null
  const asOfDate = (
    quote?.tradeDate
    || fund?.asOfDate
    || latestCandle?.date
    || null
  )
  const fundAsOfDate = fund?.asOfDate || fund?.historicalAsOfDate || null
  const fundAligned = (
    day(fundAsOfDate)
    && day(fundAsOfDate) === day(asOfDate)
  )
  const fundComplete = (
    fund?.historyComplete === true
    && Number(fund?.historyDayCount) >= 5
    && fundAligned
  )

  return {
    schemaVersion: 'stock-market-snapshot.v1',
    label: quote?.isLivePrice === true ? '盘中快照' : '最近收盘',
    asOfDate,
    isLive: quote?.isLivePrice === true,
    latest: {
      turnover:
        rounded(quote?.turnover)
        ?? rounded(latestCandle?.turnover),
      volumeRatio: rounded(quote?.volRatio),
      mainNetYi: fundAligned
        ? rounded(fund?.mainNetYi) ?? yuanToYi(quote?.mainInflow)
        : yuanToYi(quote?.mainInflow),
      retailNetYi: fundAligned
        ? rounded(fund?.retailNetYi) ?? yuanToYi(quote?.retailInflow)
        : yuanToYi(quote?.retailInflow),
    },
    recent5: {
      dayCount: recentCandles.length,
      priceChangePct,
      mainNetYi: fundComplete ? rounded(fund?.main5dYi) : null,
      retailNetYi: fundComplete ? rounded(fund?.retail5dYi) : null,
      mainInflowDays: fundComplete
        ? Math.max(0, Number(fund?.inflowDays) || 0)
        : null,
      retailInflowDays: fundComplete
        ? Math.max(0, Number(fund?.retailInflowDays) || 0)
        : null,
    },
  }
}
