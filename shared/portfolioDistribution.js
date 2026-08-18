function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function nullableFinite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 2) {
  return +Number(value || 0).toFixed(digits)
}

export function portfolioCategory(accountWeightPct) {
  const weight = finite(accountWeightPct)
  if (weight >= 15) return '核心仓'
  if (weight >= 5) return '标准仓'
  return '卫星仓'
}

function conceptOf(tagInfo, position) {
  return String(
    tagInfo?.primaryTopic
    || tagInfo?.displayTags?.find?.((tag) => tag?.kind === 'concept')?.name
    || position?.industry
    || '其他',
  ).trim() || '其他'
}

export function buildPortfolioDistribution(
  portfolio = {},
  tagMap = {},
  positionConstraints = {},
  quoteMap = {},
) {
  const totalAssets = Math.max(0, finite(portfolio.totalAssets))
  const investedValue = Math.max(0, finite(portfolio.holdMktValue))
  const cash = Math.max(0, finite(
    portfolio.available ?? portfolio.cash,
  ))
  const byCode = new Map()

  for (const position of portfolio.positions || []) {
    const code = String(position?.code || '').trim()
    if (!/^\d{6}$/.test(code)) continue
    const current = byCode.get(code) || {
      code,
      name: String(position?.name || code).trim().slice(0, 40),
      qty: 0,
      weightedPrice: 0,
      marketValue: 0,
      costValue: 0,
      floatPnl: 0,
      position,
    }
    const qty = Math.max(0, finite(position.qty))
    current.qty += qty
    current.weightedPrice += finite(position.price) * qty
    current.marketValue += Math.max(0, finite(position.mktValue))
    current.costValue += Math.max(0, finite(position.costValue))
    current.floatPnl += finite(position.floatPnl)
    byCode.set(code, current)
  }

  const rawStocks = [...byCode.values()].map((item) => {
    const tagInfo = tagMap[item.code]
    const constraint = positionConstraints[item.code]
    const quote = quoteMap[item.code]
    const concept = conceptOf(tagInfo, item.position)
    const accountWeightPct = totalAssets > 0
      ? item.marketValue / totalAssets * 100
      : 0
    const holdingWeightPct = investedValue > 0
      ? item.marketValue / investedValue * 100
      : 0
    const price = item.qty > 0
      ? item.weightedPrice / item.qty
      : 0
    const dayPct = nullableFinite(quote?.pct)
    const previousClose = nullableFinite(quote?.prevClose)
    const dayPnl = previousClose != null && previousClose > 0
      ? round((price - previousClose) * item.qty * 100)
      : dayPct != null && dayPct > -100
        ? round(item.marketValue - item.marketValue / (1 + dayPct / 100))
        : null
    return {
      code: item.code,
      name: item.name,
      concept,
      industry: String(
        tagInfo?.industry || item.position?.industry || '其他',
      ).trim() || '其他',
      qty: round(item.qty, 3),
      price: round(price, 3),
      marketValue: round(item.marketValue),
      costValue: round(item.costValue),
      floatPnl: round(item.floatPnl),
      floatPct: item.costValue > 0
        ? round(item.floatPnl / item.costValue * 100)
        : 0,
      dayPct: dayPct == null ? null : round(dayPct),
      dayPnl,
      accountWeightPct: round(accountWeightPct),
      holdingWeightPct: round(holdingWeightPct),
      category: portfolioCategory(accountWeightPct),
      ...(constraint ? {
        sellableQty: round(Math.min(
          item.qty,
          Math.max(0, finite(constraint.sellableQty)),
        ), 3),
        boughtTodayQty: round(
          Math.max(0, finite(constraint.boughtTodayQty)),
          3,
        ),
        t1Locked: finite(constraint.boughtTodayQty) > 0,
      } : {}),
    }
  })
  const stocks = rawStocks
    .sort((left, right) => right.marketValue - left.marketValue)

  const groupMap = new Map()
  for (const stock of stocks) {
    const group = groupMap.get(stock.concept) || {
      name: stock.concept,
      marketValue: 0,
      children: [],
    }
    group.marketValue += stock.marketValue
    group.children.push(stock)
    groupMap.set(stock.concept, group)
  }
  const groups = [...groupMap.values()]
    .map((group) => {
      const quotedChildren = group.children.filter(
        (item) => item.dayPnl != null,
      )
      const dayPnl = quotedChildren.reduce(
        (sum, item) => sum + item.dayPnl,
        0,
      )
      const previousValue = quotedChildren.reduce(
        (sum, item) => sum + item.marketValue - item.dayPnl,
        0,
      )
      return {
        name: group.name,
        marketValue: round(group.marketValue),
        accountWeightPct: totalAssets > 0
          ? round(group.marketValue / totalAssets * 100)
          : 0,
        holdingWeightPct: investedValue > 0
          ? round(group.marketValue / investedValue * 100)
          : 0,
        dayPnl: quotedChildren.length ? round(dayPnl) : null,
        dayPct: quotedChildren.length && previousValue > 0
          ? round(dayPnl / previousValue * 100)
          : null,
        children: group.children,
      }
    })
    .sort((left, right) => right.marketValue - left.marketValue)

  const quotedStocks = stocks.filter((item) => item.dayPnl != null)
  const dayPnl = quotedStocks.reduce(
    (sum, item) => sum + item.dayPnl,
    0,
  )
  const previousInvestedValue = quotedStocks.reduce(
    (sum, item) => sum + item.marketValue - item.dayPnl,
    0,
  )

  const categories = ['核心仓', '标准仓', '卫星仓'].map((name) => {
    const items = stocks.filter((item) => item.category === name)
    const marketValue = items.reduce(
      (sum, item) => sum + item.marketValue,
      0,
    )
    return {
      name,
      stockCount: items.length,
      marketValue: round(marketValue),
      accountWeightPct: totalAssets > 0
        ? round(marketValue / totalAssets * 100)
        : 0,
    }
  })

  return {
    totalAssets: round(totalAssets),
    investedValue: round(investedValue),
    cash: round(cash),
    positionPct: totalAssets > 0
      ? round(investedValue / totalAssets * 100)
      : 0,
    cashReservePct: totalAssets > 0
      ? round(cash / totalAssets * 100)
      : 0,
    dayPnl: quotedStocks.length ? round(dayPnl) : null,
    dayPct: quotedStocks.length && previousInvestedValue > 0
      ? round(dayPnl / previousInvestedValue * 100)
      : null,
    groups,
    stocks,
    categories,
  }
}
