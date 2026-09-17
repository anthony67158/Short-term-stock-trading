import { useSyncExternalStore } from 'react'
import { api } from './apiBase.js'

export function createModelTrainingStore({
  fetcher = globalThis.fetch,
  timeoutMs = 20000,
} = {}) {
  let state = {
    models: [],
    runs: [],
    active: null,
    warnings: [],
    sources: null,
    loading: false,
    loaded: false,
    error: '',
  }
  const listeners = new Set()
  const emit = () => {
    state = { ...state }
    listeners.forEach((listener) => listener())
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get() {
      return state
    },
    async load({ force = false } = {}) {
      if (state.loading || (state.loaded && !force)) return
      state.loading = true
      state.error = ''
      emit()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetcher(
          api(`/api/model_training?limit=200&_t=${Date.now()}`),
          { cache: 'no-store', signal: controller.signal },
        )
        const payload = await response.json()
        if (!response.ok || payload?.ok !== true) {
          throw new Error(payload?.error || '模型训练记录读取失败')
        }
        if (!Array.isArray(payload.models) || !Array.isArray(payload.runs)) {
          throw new Error('模型训练记录格式无效')
        }
        state.models = payload.models
        state.runs = payload.runs
        state.active = payload.active || null
        state.warnings = Array.isArray(payload.warnings)
          ? payload.warnings
          : []
        state.sources = payload.sources || null
        state.loaded = true
      } catch (error) {
        state.error = error?.name === 'AbortError'
          ? '训练记录读取超时，请重试'
          : (error?.message || '训练记录读取失败，请重试')
        state.loaded = false
      } finally {
        clearTimeout(timer)
        state.loading = false
        emit()
      }
    },
  }
}

export const modelTrainingStore = createModelTrainingStore()

export function useModelTrainingStore() {
  return useSyncExternalStore(
    modelTrainingStore.subscribe,
    modelTrainingStore.get,
  )
}
