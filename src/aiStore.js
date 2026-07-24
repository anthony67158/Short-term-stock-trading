import { useSyncExternalStore } from 'react'

// 轻量全局 store：让任意组件聚焦某股票 / 板块并打开 AI 助手
let state = {
  open: false,
  stock: null,   // { code, name }
  sector: null,  // { code, name }
  intent: null,  // 'diagnose' | 'scan' | 'market' | 'sector' | null  —— 打开后要自动触发的动作
  seq: 0,        // 自增，用于触发 intent
}
const listeners = new Set()

function emit() {
  state = { ...state }
  listeners.forEach((l) => l())
}

export const aiStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return state },

  // 打开助手（可选带意图）
  open(intent = null) { state.open = true; if (intent) { state.intent = intent; state.seq++ } emit() },
  close() { state.open = false; emit() },
  toggle() { state.open = !state.open; emit() },

  // 聚焦某只股票并打开；可带意图（如 diagnose）
  focusStock(stock, intent = null) {
    state.stock = stock; state.open = true
    if (intent) { state.intent = intent; state.seq++ }
    emit()
  },
  // 设置当前板块（供板块选股用）
  setSector(sector) { state.sector = sector; emit() },

  // 消费意图（助手处理后清空）
  consumeIntent() { state.intent = null; emit() },
}

export function useAIStore() {
  return useSyncExternalStore(aiStore.subscribe, aiStore.get)
}
