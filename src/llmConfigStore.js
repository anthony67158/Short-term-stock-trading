import { useSyncExternalStore } from 'react'

// 模型设置弹窗状态。入口可直接定位端点配置或训练中心。
let state = { open: false, view: 'endpoints' }
const listeners = new Set()
function emit() { listeners.forEach((l) => { try { l() } catch (e) { console.error('[store] listener error', e) } }) }

export const llmConfigStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  getOpen() { return state.open },
  getView() { return state.view },
  open(view = 'endpoints') {
    state = {
      open: true,
      view: view === 'training' ? 'training' : 'endpoints',
    }
    emit()
  },
  setView(view) {
    state = {
      ...state,
      view: view === 'training' ? 'training' : 'endpoints',
    }
    emit()
  },
  close() { state = { ...state, open: false }; emit() },
}

export function useLLMConfigOpen() {
  return useSyncExternalStore(
    llmConfigStore.subscribe,
    llmConfigStore.getOpen,
  )
}

export function useLLMConfigView() {
  return useSyncExternalStore(
    llmConfigStore.subscribe,
    llmConfigStore.getView,
  )
}
