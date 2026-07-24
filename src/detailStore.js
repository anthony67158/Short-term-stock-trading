import { useSyncExternalStore } from 'react'

// 全局个股详情 store：任意页面点击股票名 → 弹出详情+K线弹窗
let state = { stock: null } // { code, name }
const listeners = new Set()

function emit() { state = { ...state }; listeners.forEach((l) => l()) }

export const detailStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return state },
  // 打开某只股票的详情弹窗
  open(stock) { if (stock && stock.code) { state.stock = stock; emit() } },
  close() { state.stock = null; emit() },
}

export function useDetailStore() {
  return useSyncExternalStore(detailStore.subscribe, detailStore.get)
}

// 便捷：给任意股票名/单元格用的点击处理器
export function openStockDetail(code, name) {
  detailStore.open({ code, name })
}
