function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? number
    : null
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function quoteDisplayState(quote = {}) {
  const quotedPrice = positive(quote.price)
  const fallbackPrice = positive(quote.prevClose)
  const usedFallback = quotedPrice == null && fallbackPrice != null
  const price = quotedPrice ?? fallbackPrice
  const status = String(
    quote.priceStatus
    || (usedFallback ? 'PREVIOUS_CLOSE' : quotedPrice ? 'LIVE' : 'UNAVAILABLE'),
  )
  const displayOnly = (
    quote.isLivePrice === false
    || [
      'AUCTION',
      'PREVIOUS_CLOSE',
      'LUNCH_CLOSE',
      'CLOSE',
      'LATEST',
      'UNAVAILABLE',
    ].includes(status)
  )
  return {
    price,
    livePrice: !displayOnly ? quotedPrice : null,
    pct: ['PREVIOUS_CLOSE', 'UNAVAILABLE'].includes(status)
      ? null
      : finite(quote.pct),
    label: String(
      quote.priceLabel
      || (usedFallback ? '最近收盘' : ''),
    ),
    status,
  }
}

export function stockDetailHeaderState(quote = {}, candleOverview = {}) {
  const quoteState = quoteDisplayState(quote)
  const candle = candleOverview && typeof candleOverview === 'object'
    ? candleOverview
    : {}
  const candlePrice = positive(
    candle.price ?? candle.close,
  )
  const quoteAvailable = quoteState.price != null
  return {
    price: quoteAvailable ? quoteState.price : candlePrice,
    pct: quoteAvailable
      ? quoteState.pct
      : finite(candle.pct),
    source: quoteAvailable ? 'quote' : 'candle',
    sourceLabel: quoteAvailable
      ? (
          quoteState.label
          || (quoteState.livePrice != null ? '实时行情' : '最新行情')
        )
      : '最新K线',
    live: quoteState.livePrice != null,
    status: quoteAvailable ? quoteState.status : 'KLINE',
  }
}
