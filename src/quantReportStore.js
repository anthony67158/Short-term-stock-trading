import { useSyncExternalStore } from 'react'
import { api } from './apiBase'

export function createQuantReportStore({ fetcher = globalThis.fetch, timeoutMs = 15000 } = {}) {
  let state = {
    reports: [], workflow: null, opportunity: null,
    loading: false, mutating: false, loaded: false, error: '',
  }
  const listeners = new Set()
  function emit() {
    state = { ...state }
    listeners.forEach((listener) => {
      try { listener() } catch (error) { console.error('[quant-report] listener error', error) }
    })
  }
  async function request(path, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(api(path), { ...options, signal: controller.signal })
      const payload = await response.json()
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '请求失败')
      return payload
    } finally {
      clearTimeout(timer)
    }
  }
  async function mutate(action, id) {
    if (state.loading || state.mutating) return false
    state.mutating = true
    state.error = ''
    emit()
    try {
      await request('/api/quant_report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      })
      state.reports = action === 'clear' ? [] : state.reports.filter((row) => row.id !== id)
      return true
    } catch {
      state.error = '删除未成功，请刷新后重试'
      return false
    } finally {
      state.mutating = false
      emit()
    }
  }

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    get() { return state },
    async load({ force = false } = {}) {
      if (state.loading || state.mutating || (state.loaded && !force)) return
      state.loading = true
      state.error = ''
      emit()
      try {
        const payload = await request('/api/quant_report?limit=200&_t=' + Date.now(), { cache: 'no-store' })
        if (!Array.isArray(payload.reports)) throw new Error('汇报列表无效')
        state.reports = payload.reports
        state.workflow = payload.workflow || null
        state.opportunity = payload.opportunity || null
        state.loaded = true
      } catch (error) {
        state.error = error.name === 'AbortError' ? '汇报读取超时，请重试' : '汇报读取失败，请重试'
        state.loaded = false
      } finally {
        state.loading = false
        emit()
      }
    },
    remove(id) { return mutate('delete', id) },
    clearAll() { return mutate('clear') },
  }
}

export const quantReportStore = createQuantReportStore()

export function useQuantReportStore() {
  return useSyncExternalStore(quantReportStore.subscribe, quantReportStore.get)
}
