import { useSyncExternalStore } from 'react'

// 「AI 模型配置」向导的开合状态。入口藏在账号下拉菜单里，点开后全屏向导。
let open = false
const listeners = new Set()
function emit() { listeners.forEach((l) => l()) }

export const llmConfigStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return open },
  open() { open = true; emit() },
  close() { open = false; emit() },
}

export function useLLMConfigOpen() {
  return useSyncExternalStore(llmConfigStore.subscribe, llmConfigStore.get)
}
