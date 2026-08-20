import { beijingDate, beijingDayKey, isTradingDay } from './tradingCalendar.js'
import {
  computeTFlows,
  positionCostBasis,
  tradeActivityContext,
} from './portfolioAccounting.js'
import { tradeIntentOf, tradeRecordType } from './tradeIntent.js'

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
    const basis = positionCostBasis(holding)
    const shares = basis.liveQty * 100
    const cost = basis.costValue
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

export function computeTodayOperationPnl({
  holdings = [],
  trades = [],
  now = Date.now(),
} = {}) {
  const todayKey = beijingDayKey(now)
  let positionPnl = 0
  let tPnl = 0
  let positionCount = 0
  let tCount = 0

  for (const record of trades || []) {
    const type = tradeRecordType(record)
    const realizedAt = record?.sellAt ?? record?.at ?? record?.buyAt
    if (!realizedAt || beijingDayKey(realizedAt) !== todayKey) continue
    const pnl = record?.realizedPnl ?? record?.netPnl
    if (pnl == null || !Number.isFinite(Number(pnl))) continue

    if (type === 'T') {
      tPnl += Number(pnl)
      tCount++
      continue
    }
    if (
      (type === 'SELL' || type === 'CLOSE')
      && tradeIntentOf(record) !== 't'
    ) {
      positionPnl += Number(pnl)
      positionCount++
    }
  }

  const classifiedT = tradeActivityContext(trades).t.pairRecords
    .filter((record) =>
      record.at
      && beijingDayKey(record.at) === todayKey
    )
  tPnl += classifiedT.reduce(
    (sum, record) => sum + finite(record.realizedPnl),
    0,
  )
  tCount += classifiedT.length

  for (const holding of holdings || []) {
    const todayFlows = (holding.tFlows || []).filter((flow) =>
      flow.at
      && beijingDayKey(flow.at) === todayKey
    )
    if (!todayFlows.length) continue
    const pairs = computeTFlows(todayFlows).pairList
    tPnl += pairs.reduce(
      (sum, pair) => sum + finite(pair.netPnl),
      0,
    )
    tCount += pairs.length
  }

  positionPnl = round2(positionPnl)
  tPnl = round2(tPnl)
  return {
    total: round2(positionPnl + tPnl),
    positionPnl,
    tPnl,
    positionCount,
    tCount,
    realizedCount: positionCount + tCount,
  }
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

export function computeDailyAttribution({
  holdings = [],
  trades = [],
  quoteMap = {},
  now = Date.now(),
} = {}) {
  const todayKey = beijingDayKey(now)
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
  const names = new Map(
    [...holdings, ...trades]
      .filter((item) => item?.code)
      .map((item) => [String(item.code), item.name || String(item.code)]),
  )
  const quantities = new Map()
  for (const holding of holdings || []) {
    quantities.set(
      String(holding.code),
      finite(quantities.get(String(holding.code))) + finite(holding.qty),
    )
    for (const flow of holding.tFlows || []) {
      quantities.set(
        String(holding.code),
        finite(quantities.get(String(holding.code)))
          + (flow.side === 'buy' ? 1 : -1) * finite(flow.qty),
      )
    }
  }

  const codes = new Set([...quantities.keys(), ...todayLegs.map((leg) => String(leg.code))])
  const rows = []
  let overnightPnl = 0
  let newBuyPnl = 0
  let sellExecutionPnl = 0
  for (const code of codes) {
    const quote = quoteMap?.[code] || {}
    const price = finite(quote.price)
    const previousClose = finite(quote.prevClose)
    if (!(price > 0 && previousClose > 0) || quote.tradeDate !== todayKey) continue
    const legs = todayLegs.filter((leg) => String(leg.code) === code)
    const bought = legs
      .filter((leg) => leg.side === 'buy')
      .reduce((sum, leg) => sum + finite(leg.qty), 0)
    const sold = legs
      .filter((leg) => leg.side === 'sell')
      .reduce((sum, leg) => sum + finite(leg.qty), 0)
    const currentQty = Math.max(0, finite(quantities.get(code)))
    const carriedQty = Math.max(0, currentQty - bought)
    const overnight = (price - previousClose) * carriedQty * 100
    const newBuy = legs
      .filter((leg) => leg.side === 'buy')
      .reduce((sum, leg) =>
        sum + (price - finite(leg.price)) * finite(leg.qty) * 100 - finite(leg.fee),
      0)
    const sellExecution = legs
      .filter((leg) => leg.side === 'sell')
      .reduce((sum, leg) =>
        sum + (finite(leg.price) - previousClose) * finite(leg.qty) * 100 - finite(leg.fee),
      0)
    const total = round2(overnight + newBuy + sellExecution)
    overnightPnl += overnight
    newBuyPnl += newBuy
    sellExecutionPnl += sellExecution
    rows.push({
      code,
      name: names.get(code) || code,
      overnightPnl: round2(overnight),
      newBuyPnl: round2(newBuy),
      sellExecutionPnl: round2(sellExecution),
      total,
    })
  }

  return {
    overnightPnl: round2(overnightPnl),
    newBuyPnl: round2(newBuyPnl),
    sellExecutionPnl: round2(sellExecutionPnl),
    total: round2(overnightPnl + newBuyPnl + sellExecutionPnl),
    topLosses: rows
      .filter((row) => row.total < 0)
      .sort((left, right) => left.total - right.total)
      .slice(0, 5),
    topGains: rows
      .filter((row) => row.total > 0)
      .sort((left, right) => right.total - left.total)
      .slice(0, 5),
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
