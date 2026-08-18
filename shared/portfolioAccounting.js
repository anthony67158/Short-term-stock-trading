import { deriveAccountValuation } from './accountValuation.js'
import { beijingDayKey } from './tradingCalendar.js'
import {
  tradeIntentLabel,
  tradeIntentOf,
  tradeRecordType,
} from './tradeIntent.js'

// FIFO 配对做T流水，返回已实现收益、配对明细与未配平净头寸。
export function computeTFlows(flows) {
  const list = [...(flows || [])].sort((a, b) => a.at - b.at)
  let realized = 0
  let pairs = 0
  const pairList = []
  const queue = { buy: [], sell: [] }
  for (const flow of list) {
    const opposite = flow.side === 'buy' ? 'sell' : 'buy'
    let remain = flow.qty
    let feeLeft = flow.fee
    while (remain > 0 && queue[opposite].length) {
      const head = queue[opposite][0]
      const matched = Math.min(remain, head.qty)
      const buyLeg = flow.side === 'buy' ? flow : head
      const sellLeg = flow.side === 'buy' ? head : flow
      const shares = matched * 100
      const gross = (sellLeg.price - buyLeg.price) * shares
      const currentFee = feeLeft * (matched / remain)
      const headFee = head.fee * (matched / head.qty)
      const fee = currentFee + headFee
      const net = +(gross - fee).toFixed(2)
      realized += gross - fee
      pairs++
      const buyAt = buyLeg.at
      const sellAt = sellLeg.at
      pairList.push({
        qty: matched,
        buyPrice: buyLeg.price,
        sellPrice: sellLeg.price,
        buyFee: +((flow.side === 'buy' ? currentFee : headFee)).toFixed(2),
        sellFee: +((flow.side === 'buy' ? headFee : currentFee)).toFixed(2),
        grossPnl: +gross.toFixed(2),
        netPnl: net,
        cashApplied: buyLeg.cashApplied === true && sellLeg.cashApplied === true,
        tDir: buyAt <= sellAt ? 'positive' : 'reverse',
        buyAt,
        sellAt,
        at: Math.max(buyAt, sellAt),
        buyTradeId: buyLeg.id || null,
        sellTradeId: sellLeg.id || null,
        tPairId: buyLeg.tPairId
          && buyLeg.tPairId === sellLeg.tPairId
          ? buyLeg.tPairId
          : null,
      })
      remain -= matched
      feeLeft -= feeLeft * (matched / (remain + matched))
      head.qty -= matched
      head.fee -= head.fee * (matched / (head.qty + matched))
      if (head.qty <= 1e-9) queue[opposite].shift()
    }
    if (remain > 0) {
      queue[flow.side].push({
        id: flow.id || null,
        price: flow.price,
        qty: remain,
        fee: feeLeft,
        at: flow.at,
        cashApplied: flow.cashApplied === true,
        tPairId: flow.tPairId || null,
      })
    }
  }

  const openBuy = queue.buy.reduce((sum, item) => sum + item.qty, 0)
  const openSell = queue.sell.reduce((sum, item) => sum + item.qty, 0)
  const openBuyAmount = queue.buy.reduce(
    (sum, item) => sum + item.price * item.qty * 100,
    0,
  )
  const openSellAmount = queue.sell.reduce(
    (sum, item) => sum + item.price * item.qty * 100,
    0,
  )
  const openBuyFee = +queue.buy.reduce((sum, item) => sum + item.fee, 0).toFixed(2)
  const openSellFee = +queue.sell.reduce((sum, item) => sum + item.fee, 0).toFixed(2)
  const openBuyAvg = openBuy
    ? +(openBuyAmount / (openBuy * 100)).toFixed(3)
    : null
  const openSellAvg = openSell
    ? +(openSellAmount / (openSell * 100)).toFixed(3)
    : null
  const openBuyAt = queue.buy.length
    ? Math.max(...queue.buy.map((item) => item.at))
    : null
  const openSellAt = queue.sell.length
    ? Math.max(...queue.sell.map((item) => item.at))
    : null
  return {
    realized: +realized.toFixed(2),
    pairs,
    openBuy,
    openSell,
    pairList,
    openBuyAvg,
    openBuyFee,
    openBuyAt,
    openSellAvg,
    openSellFee,
    openSellAt,
    openBuyCashApplied: queue.buy.length > 0
      && queue.buy.every((item) => item.cashApplied),
    openSellCashApplied: queue.sell.length > 0
      && queue.sell.every((item) => item.cashApplied),
  }
}

export function tradeActivityContext(
  trades = [],
  code = '',
) {
  const wantedCode = String(code || '')
  const records = (Array.isArray(trades) ? trades : [])
    .filter((record) =>
      record?.code
      && (!wantedCode || String(record.code) === wantedCode)
    )
  const recent = records
    .slice()
    .sort((left, right) =>
      Number(right.at || right.sellAt || right.buyAt || 0)
      - Number(left.at || left.sellAt || left.buyAt || 0)
    )
    .slice(0, 8)
    .map((record) => ({
      id: String(record.id || ''),
      code: String(record.code || ''),
      side: tradeRecordType(record) === 'SELL' ? 'sell'
        : tradeRecordType(record) === 'BUY' ? 'buy'
          : 'paired',
      intent: tradeIntentOf(record),
      label: tradeIntentLabel(record),
      qty: Number(record.qty) || 0,
      price: Number(
        record.price
        ?? record.sellPrice
        ?? record.buyPrice,
      ) || 0,
      at: Number(record.at || record.sellAt || record.buyAt || 0),
      tPairId: record.tPairId || null,
      tPairTradeId: record.tPairTradeId || null,
    }))

  const groups = new Map()
  const names = new Map(
    records.map((record) => [
      String(record.code || ''),
      record.name || String(record.code || ''),
    ]),
  )
  for (const record of records) {
    const type = tradeRecordType(record)
    if (
      (type !== 'BUY' && type !== 'SELL')
      || tradeIntentOf(record) !== 't'
    ) continue
    const at = Number(record.at || record.sellAt || record.buyAt || 0)
    if (!(at > 0)) continue
    const key = `${record.code}|${beijingDayKey(at)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({
      id: String(record.id || ''),
      side: type === 'BUY' ? 'buy' : 'sell',
      price: Number(
        record.price
        ?? (type === 'BUY' ? record.buyPrice : record.sellPrice),
      ) || 0,
      qty: Number(record.qty) || 0,
      fee: Number(record.fee)
        || Number(type === 'BUY' ? record.buyFee : record.sellFee)
        || 0,
      cashApplied: record.cashApplied === true,
      at,
      tPairId: record.tPairId || null,
    })
  }

  const pairRecords = []
  let openBuyQty = 0
  let openSellQty = 0
  for (const [key, flows] of groups) {
    const [groupCode, day] = key.split('|')
    const manualGroups = new Map()
    const fifoFlows = []
    flows.forEach((flow) => {
      if (flow.tPairId) {
        if (!manualGroups.has(flow.tPairId)) {
          manualGroups.set(flow.tPairId, [])
        }
        manualGroups.get(flow.tPairId).push(flow)
      } else {
        fifoFlows.push(flow)
      }
    })
    let pairIndex = 0
    const appendComputed = (computed, manualPair = false) => {
      openBuyQty += Number(computed.openBuy) || 0
      openSellQty += Number(computed.openSell) || 0
      computed.pairList.forEach((pair) => {
        pairRecords.push({
          id: pair.tPairId
            ? `classified-t:${pair.tPairId}`
            : `classified-t:${groupCode}:${day}:${pairIndex}`,
          type: 'T',
          kind: 'T',
          tradeIntent: 't',
          classified: true,
          manualPair,
          tPairId: pair.tPairId || null,
          buyTradeId: pair.buyTradeId || null,
          sellTradeId: pair.sellTradeId || null,
          code: groupCode,
          name: names.get(groupCode) || groupCode,
          qty: pair.qty,
          buyPrice: pair.buyPrice,
          sellPrice: pair.sellPrice,
          buyFee: pair.buyFee,
          sellFee: pair.sellFee,
          grossPnl: pair.grossPnl,
          netPnl: pair.netPnl,
          realizedPnl: pair.netPnl,
          tDir: pair.tDir,
          buyAt: pair.buyAt,
          sellAt: pair.sellAt,
          at: pair.at,
        })
        pairIndex++
      })
    }
    manualGroups.forEach((pairFlows) => {
      appendComputed(computeTFlows(pairFlows), true)
    })
    if (fifoFlows.length) {
      appendComputed(computeTFlows(fifoFlows), false)
    }
  }

  const archived = records.filter((record) =>
    tradeRecordType(record) === 'T'
  )
  const archivedPnl = archived.reduce(
    (sum, record) =>
      sum + (Number(record.realizedPnl ?? record.netPnl) || 0),
    0,
  )
  const classifiedPnl = pairRecords.reduce(
    (sum, record) => sum + (Number(record.realizedPnl) || 0),
    0,
  )
  return {
    schemaVersion: 'trade-activity.v1',
    recent,
    t: {
      pairCount: archived.length + pairRecords.length,
      classifiedPairCount: pairRecords.length,
      realizedPnl: +(archivedPnl + classifiedPnl).toFixed(2),
      openBuyQty: +openBuyQty.toFixed(3),
      openSellQty: +openSellQty.toFixed(3),
      pairRecords,
    },
  }
}

export function tradeAnalyticsRecords(trades = []) {
  const source = Array.isArray(trades) ? trades : []
  const context = tradeActivityContext(source)
  const regular = source.filter((record) => {
    const type = tradeRecordType(record)
    return !(
      (type === 'BUY' || type === 'SELL')
      && tradeIntentOf(record) === 't'
    )
  })
  return [...regular, ...context.t.pairRecords]
}

export function livePositionOf(holding, code) {
  const positions = (holding || []).filter((item) => item.code === code)
  if (!positions.length) return null
  let qty = 0
  let costSum = 0
  let hasOpenT = false
  let tNetHands = 0
  for (const position of positions) {
    const baseQty = position.qty || 0
    const baseCost = position.buyPrice || 0
    const flows = computeTFlows(position.tFlows)
    const openBuy = flows.openBuy || 0
    const openSell = flows.openSell || 0
    const net = openBuy - openSell
    if (
      position.tFlows
      && position.tFlows.length
      && (openBuy > 0 || openSell > 0)
    ) hasOpenT = true
    tNetHands += net
    const liveQty = Math.max(0, baseQty + net)
    let cost = baseCost
    if (openBuy > 0 && flows.openBuyAvg != null && baseQty + openBuy > 0) {
      cost = (
        (baseCost * baseQty)
        + (flows.openBuyAvg * openBuy)
      ) / (baseQty + openBuy)
    }
    qty += liveQty
    costSum += cost * liveQty
  }
  if (qty <= 0) return null
  return {
    qty,
    cost: +(costSum / qty).toFixed(3),
    hasOpenT,
    tNetHands,
  }
}

export function beijingDayStartTs(now = Date.now()) {
  const offset = 8 * 60 * 60 * 1000
  const day = 24 * 60 * 60 * 1000
  return Math.floor((now + offset) / day) * day - offset
}

export function t1StatusOf(
  holding,
  closed,
  code,
  now = Date.now(),
) {
  const live = livePositionOf(holding, code)
  const liveQty = live ? live.qty : 0
  const dayStart = beijingDayStartTs(now)
  let boughtToday = 0
  const buys = []
  for (const trade of (closed || [])) {
    if (trade.code !== code || (trade.type || trade.kind) !== 'BUY') continue
    const at = trade.at || trade.buyAt || 0
    if (at < dayStart) continue
    boughtToday += trade.qty || 0
    buys.push({
      price: trade.price,
      qty: trade.qty,
      at,
      kind: tradeIntentOf(trade) === 't'
        ? '做T买腿'
        : '建仓/加仓',
    })
  }
  for (const position of (holding || []).filter((item) => item.code === code)) {
    for (const flow of (position.tFlows || [])) {
      if (flow.side !== 'buy' || (flow.at || 0) < dayStart) continue
      boughtToday += flow.qty || 0
      buys.push({
        price: flow.price,
        qty: flow.qty,
        at: flow.at,
        kind: '做T买腿',
      })
    }
  }
  boughtToday = +boughtToday.toFixed(3)
  return {
    liveQty,
    boughtToday,
    sellableToday: Math.max(0, +(liveQty - boughtToday).toFixed(3)),
    buys,
  }
}

export function computePortfolio(holding, quoteMap, account) {
  const finite = (value) => {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
  }
  const positions = (holding || []).map((position) => {
    const quote = quoteMap && quoteMap[position.code]
    const price = finite(
      quote && Number(quote.price) > 0
        ? quote.price
        : quote && Number(quote.prevClose) > 0
          ? Number(quote.prevClose)
          : position.buyPrice,
    )
    const baseQty = finite(position.qty)
    const flows = computeTFlows(position.tFlows)
    const liveQty = Math.max(
      0,
      baseQty + finite(flows.openBuy) - finite(flows.openSell),
    )
    const marketValue = +(price * liveQty * 100).toFixed(2)
    let costValue = (
      finite(position.buyPrice) * baseQty * 100
      + finite(position.buyFee)
    )
    if (flows.openBuy > 0 && flows.openBuyAvg != null) {
      costValue += (
        finite(flows.openBuyAvg) * finite(flows.openBuy) * 100
        + finite(flows.openBuyFee)
      )
    } else if (flows.openSell > 0 && baseQty > 0) {
      costValue *= (
        Math.max(0, baseQty - finite(flows.openSell))
        / baseQty
      )
    }
    costValue = +costValue.toFixed(2)
    const floatPnl = +(marketValue - costValue).toFixed(2)
    return {
      id: position.id,
      industry: position.industry || null,
      code: position.code,
      name: position.name,
      qty: liveQty,
      baseQty,
      price,
      buyPrice: position.buyPrice,
      mktValue: marketValue,
      costValue,
      floatPnl,
      floatPct: costValue
        ? +((floatPnl / costValue) * 100).toFixed(2)
        : 0,
    }
  })
  const holdMktValue = +positions
    .reduce((sum, position) => sum + position.mktValue, 0)
    .toFixed(2)
  const holdCostValue = +positions
    .reduce((sum, position) => sum + position.costValue, 0)
    .toFixed(2)
  const floatPnl = +(holdMktValue - holdCostValue).toFixed(2)
  const valuation = deriveAccountValuation({
    holdMktValue,
    holdCostValue,
    account,
  })
  const position = valuation.totalAssets
    ? +((holdMktValue / valuation.totalAssets) * 100).toFixed(1)
    : null
  for (const item of positions) {
    item.weight = valuation.totalAssets
      ? +((item.mktValue / valuation.totalAssets) * 100).toFixed(1)
      : null
  }
  const goal = account?.goal != null && account.goal > 0
    ? account.goal
    : null
  let goalProgress = null
  let goalGap = null
  let goalReturnPct = null
  if (goal && valuation.totalAssets != null) {
    goalProgress = +((valuation.totalAssets / goal) * 100).toFixed(1)
    goalGap = +(goal - valuation.totalAssets).toFixed(2)
    goalReturnPct = valuation.totalAssets > 0
      ? +(((goal - valuation.totalAssets) / valuation.totalAssets) * 100).toFixed(1)
      : null
  }
  return {
    positions,
    holdMktValue,
    holdCostValue,
    floatPnl,
    ...valuation,
    position,
    goal,
    goalProgress,
    goalGap,
    goalReturnPct,
  }
}
