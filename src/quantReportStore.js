import { useSyncExternalStore } from 'react'
import { api } from './apiBase'

// ============ 量化每日重训「中文汇报」站内收件箱 ============
// 每天的持续训练定时任务跑完后会把中文汇报 POST 到 /api/quant_report（OSS 持久化）；
// 这里在「预警中心 · 量化」页打开时拉取展示，支持单条删除 + 一键清空。
// 因为汇报由后台定时任务在另一个进程生成，故不能像预警通知那样存在内存，必须从后端拉取。

let state = { reports: [], loading: false, loaded: false, error: '' }
const listeners = new Set()
function emit() { state = { ...state }; listeners.forEach((l) => l()) }

export const quantReportStore = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  get() { return state },

  // 拉取汇报列表（打开量化页时调用；force 忽略已加载缓存强制刷新）
  async load({ force = false } = {}) {
    if (state.loading) return
    if (state.loaded && !force) return
    state.loading = true; state.error = ''; emit()
    try {
      const r = await fetch(api('/api/quant_report?limit=100&_t=' + Date.now()), { cache: 'no-store' })
      const j = await r.json().catch(() => null)
      if (j && j.ok && Array.isArray(j.reports)) {
        state.reports = j.reports
      } else {
        state.error = (j && j.error) || '加载失败'
      }
    } catch (e) {
      state.error = String(e.message || e)
    } finally {
      state.loading = false; state.loaded = true; emit()
    }
  },

  // 单条删除：先本地乐观移除，再请求后端
  async remove(id) {
    state.reports = state.reports.filter((x) => x.id !== id); emit()
    try {
      await fetch(api('/api/quant_report'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      })
    } catch { /* 已本地移除，后端失败下次拉取会回显，可接受 */ }
  },

  // 清空全部
  async clearAll() {
    state.reports = []; emit()
    try {
      await fetch(api('/api/quant_report'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
      })
    } catch { /* ignore */ }
  },
}

export function useQuantReportStore() {
  return useSyncExternalStore(quantReportStore.subscribe, quantReportStore.get)
}
