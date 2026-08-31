import { preloadStockDetailData } from './stockDetailData.js'

export function loadStockDetailComponent() {
  return import('./components/StockDetail.jsx')
}

export function preloadStockDetailExperience(code) {
  const component = loadStockDetailComponent().catch(() => null)
  const data = code
    ? preloadStockDetailData(code)
    : Promise.resolve(null)
  return Promise.all([component, data])
}
