function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function portfolioExposureContext(portfolio = {}) {
  const totalAssets = finite(portfolio.totalAssets)
  const cash = finite(portfolio.available ?? portfolio.cash)
  const positions = Array.isArray(portfolio.positions) ? portfolio.positions : []
  const cashReservePct = totalAssets > 0 && cash != null
    ? +(cash / totalAssets * 100).toFixed(1)
    : null

  const stockValues = new Map()
  const industryValues = new Map()
  for (const position of positions) {
    const marketValue = Math.max(0, finite(position?.mktValue) || 0)
    const code = String(position?.code || '')
    if (code) stockValues.set(code, (stockValues.get(code) || 0) + marketValue)
    const industry = String(position?.industry || '').trim()
    if (industry && industry !== '其他') {
      industryValues.set(industry, (industryValues.get(industry) || 0) + marketValue)
    }
  }

  const maxStockValue = Math.max(0, ...stockValues.values())
  const maxStockWeight = totalAssets > 0
    ? +(maxStockValue / totalAssets * 100).toFixed(1)
    : null
  const industryWeights = totalAssets > 0
    ? [...industryValues.entries()]
      .map(([industry, marketValue]) => ({
        industry,
        weight: +(marketValue / totalAssets * 100).toFixed(1),
      }))
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 8)
    : []

  return {
    cashReservePct,
    maxStockWeight,
    industryWeights,
  }
}
