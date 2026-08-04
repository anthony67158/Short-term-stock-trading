import { useSyncExternalStore } from 'react'

// 「量化汇报」弹窗的开合状态。入口在账号下拉菜单里，与「AI 模型配置」并列，点开后全屏弹窗。
let open = false
const listeners = new Set()
function emit() { listeners.forEach((l) => l()) }

export const quantReportUiStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return open },
  open() { open = true; emit() },
  close() { open = false; emit() },
}

export function useQuantReportOpen() {
  return useSyncExternalStore(quantReportUiStore.subscribe, quantReportUiStore.get)
}
