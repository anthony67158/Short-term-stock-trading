export function portfolioHeatmapStockCode(params) {
  const code = String(params?.data?.stock?.code || '').trim()
  return /^\d{6}$/.test(code) ? code : ''
}

export function nextPortfolioHeatmapCode(currentCode, params) {
  return portfolioHeatmapStockCode(params) || String(currentCode || '')
}
