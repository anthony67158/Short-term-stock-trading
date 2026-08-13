import { deriveAccountValuation } from './accountValuation.js'

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
      })
      remain -= matched
      feeLeft -= feeLeft * (matched / (remain + matched))
      head.qty -= matched
      head.fee -= head.fee * (matched / (head.qty + matched))
      if (head.qty <= 1e-9) queue[opposite].shift()
    }
    if (remain > 0) {
      queue[flow.side].push({
        price: flow.price,
        qty: remain,
        fee: feeLeft,
        at: flow.at,
        cashApplied: flow.cashApplied === true,
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
      kind: '建仓/加仓',
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
