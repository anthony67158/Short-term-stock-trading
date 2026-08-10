import { beijingDate, beijingDayKey, isTradingDay } from './tradingCalendar.js'

const round2 = (value) => +Number(value || 0).toFixed(2)
const finite = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function recordLegs(record) {
  const type = record?.type || record?.kind
  const qty = finite(record?.qty)
  if (!(qty > 0)) return []
  if (type === 'BUY') {
    return [{
      code: record.code, side: 'buy', qty,
      price: finite(record.price ?? record.buyPrice),
      fee: finite(record.fee ?? record.buyFee),
      at: record.at ?? record.buyAt,
    }]
  }
  if (type === 'SELL') {
    return [{
      code: record.code, side: 'sell', qty,
      price: finite(record.price ?? record.sellPrice),
      fee: finite(record.fee ?? record.sellFee),
      at: record.at ?? record.sellAt,
    }]
  }
  if (type === 'CLOSE' || type === 'T') {
    return [
      {
        code: record.code, side: 'buy', qty,
        price: finite(record.buyPrice), fee: finite(record.buyFee),
        at: record.buyAt ?? record.at,
      },
      {
        code: record.code, side: 'sell', qty,
        price: finite(record.sellPrice), fee: finite(record.sellFee),
        at: record.sellAt ?? record.at,
      },
    ]
  }
  return []
}

function currentPositions(holdings, quoteMap, todayKey) {
  let quoteComplete = true
  let tradeDateComplete = true
  const positions = (holdings || []).map((holding) => {
    let shares = finite(holding.qty) * 100
    let cost = finite(holding.buyPrice) * shares + finite(holding.buyFee)
    const flows = [...(holding.tFlows || [])].sort((a, b) => finite(a.at) - finite(b.at))
    for (const flow of flows) {
      const flowShares = finite(flow.qty) * 100
      if (!(flowShares > 0)) continue
      if (flow.side === 'buy') {
        shares += flowShares
        cost += finite(flow.price) * flowShares + finite(flow.fee)
      } else if (shares > 0) {
        const removed = Math.min(shares, flowShares)
        cost -= cost / shares * removed
        shares -= removed
      }
    }
    const quote = quoteMap?.[holding.code] || {}
    const livePrice = finite(quote.price)
    const previousClose = finite(quote.prevClose)
    if (!(livePrice > 0 || previousClose > 0)) quoteComplete = false
    if (quote.tradeDate !== todayKey) tradeDateComplete = false
    const price = livePrice > 0 ? livePrice : previousClose > 0 ? previousClose : finite(holding.buyPrice)
    return {
      code: holding.code,
      shares,
      cost: Math.max(0, cost),
      price,
      marketValue: price * shares,
    }
  })
  return { positions, quoteComplete, tradeDateComplete }
}

export function computeDailyFinance({
  holdings = [],
  trades = [],
  quoteMap = {},
  now = Date.now(),
} = {}) {
  const todayKey = beijingDayKey(now)
  const nowBj = beijingDate(now)
  const tradingToday = isTradingDay(nowBj)
  const minute = nowBj.getHours() * 60 + nowBj.getMinutes()
  const marketStatus = !tradingToday ? 'closed' : minute < 555 ? 'preopen' : minute <= 900 ? 'active' : 'postclose'
  const marketPriceReady = tradingToday && minute >= 555

  const closedLegs = (trades || []).flatMap(recordLegs)
  const openTLegs = (holdings || []).flatMap((holding) =>
    (holding.tFlows || []).map((flow) => ({
      code: holding.code,
      side: flow.side,
      qty: finite(flow.qty),
      price: finite(flow.price),
      fee: finite(flow.fee),
      at: flow.at,
    }))
  )
  const todayLegs = [...closedLegs, ...openTLegs].filter((leg) =>
    leg.code && leg.at && beijingDayKey(leg.at) === todayKey
  )
  const buyLegs = todayLegs.filter((leg) => leg.side === 'buy')
  const sellLegs = todayLegs.filter((leg) => leg.side === 'sell')
  const legAmount = (leg) => finite(leg.price) * finite(leg.qty) * 100
  const buyOutflow = round2(buyLegs.reduce((sum, leg) => sum + legAmount(leg) + finite(leg.fee), 0))
  const sellInflow = round2(sellLegs.reduce((sum, leg) => sum + legAmount(leg) - finite(leg.fee), 0))

  const positionState = currentPositions(holdings, quoteMap, todayKey)
  const { positions, quoteComplete } = positionState
  let tradeDateComplete = positionState.tradeDateComplete
  const currentMarketValue = positions.reduce((sum, position) => sum + position.marketValue, 0)
  const currentCost = positions.reduce((sum, position) => sum + position.cost, 0)
  const floatPnl = round2(currentMarketValue - currentCost)
  const floatPct = currentCost > 0 ? +((floatPnl / currentCost) * 100).toFixed(2) : null

  const previousShares = new Map(positions.map((position) => [position.code, position.shares]))
  for (const leg of todayLegs) {
    const shares = finite(leg.qty) * 100
    previousShares.set(
      leg.code,
      Math.max(0, finite(previousShares.get(leg.code)) + (leg.side === 'sell' ? shares : -shares))
    )
  }
  let previousCloseValue = 0
  let previousCloseComplete = true
  for (const [code, shares] of previousShares) {
    if (!(shares > 0)) continue
    const previousClose = finite(quoteMap?.[code]?.prevClose)
    if (quoteMap?.[code]?.tradeDate !== todayKey) tradeDateComplete = false
    if (!(previousClose > 0)) {
      previousCloseComplete = false
      continue
    }
    previousCloseValue += previousClose * shares
  }

  const comparisonReady = marketPriceReady && quoteComplete && previousCloseComplete && tradeDateComplete
  const dayChangeAmount = comparisonReady
    ? round2(currentMarketValue + sellInflow - buyOutflow - previousCloseValue)
    : null
  const dayChangePct = dayChangeAmount != null && previousCloseValue > 0
    ? +((dayChangeAmount / previousCloseValue) * 100).toFixed(2)
    : null

  return {
    tradingToday,
    marketStatus,
    buyOutflow,
    sellInflow,
    netCashFlow: round2(sellInflow - buyOutflow),
    buyCount: buyLegs.length,
    sellCount: sellLegs.length,
    floatPnl,
    floatPct,
    currentMarketValue: round2(currentMarketValue),
    previousCloseValue: round2(previousCloseValue),
    dayChangeAmount,
    dayChangePct,
    quoteComplete: quoteComplete && previousCloseComplete,
  }
}

export function todayTradeCodes(trades = [], holdings = [], now = Date.now()) {
  const todayKey = beijingDayKey(now)
  const codes = new Set()
  for (const record of trades || []) {
    for (const leg of recordLegs(record)) {
      if (leg.at && beijingDayKey(leg.at) === todayKey && leg.code) codes.add(leg.code)
    }
  }
  for (const holding of holdings || []) {
    if ((holding.tFlows || []).some((flow) => flow.at && beijingDayKey(flow.at) === todayKey)) {
      codes.add(holding.code)
    }
  }
  return [...codes]
}
