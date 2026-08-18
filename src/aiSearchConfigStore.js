import { useSyncExternalStore } from 'react'
import { normalizeAiSearchPublicConfig } from '../shared/aiSearchUi.js'
import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

const EMPTY_CONFIG = normalizeAiSearchPublicConfig({})
let state = {
  open: false,
  status: 'idle',
  error: '',
  notice: '',
  ...EMPTY_CONFIG,
}
let loadPromise = null
const listeners = new Set()

function emit(patch = {}) {
  state = { ...state, ...patch }
  for (const listener of listeners) {
    try { listener() } catch (error) { console.error('[store] listener error', error) }
  }
}

async function request(action, payload = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(api('/api/ai_search_config'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...accountRequestHeaders(),
      },
      body: JSON.stringify({ action, ...payload }),
    })
    const raw = await response.text()
    try { return JSON.parse(raw) } catch {
      return { ok: false, error: `服务异常(${response.status})` }
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function savePatch(patch, {
  optimisticEnabled,
} = {}) {
  const previous = state
  emit({
    ...(typeof optimisticEnabled === 'boolean'
      ? { enabled: optimisticEnabled }
      : {}),
    status: 'saving',
    error: '',
    notice: '',
  })
  try {
    const result = await request('save', patch)
    if (!result?.ok) throw new Error(result?.error || '保存失败')
    const config = normalizeAiSearchPublicConfig(result.config)
    emit({
      ...config,
      status: 'ready',
      error: '',
      notice: 'AI消息检索设置已更新',
    })
    return { ok: true, config }
  } catch (error) {
    emit({
      ...previous,
      status: 'error',
      error: String(error?.message || error),
      notice: '',
    })
    return { ok: false, error: String(error?.message || error) }
  }
}

export const aiSearchConfigStore = {
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  get() { return state },
  open() {
    emit({ open: true, error: '', notice: '' })
    void aiSearchConfigStore.load(true)
  },
  close() { emit({ open: false, error: '', notice: '' }) },
  async load(force = false) {
    if (loadPromise && !force) return loadPromise
    if (!force && state.status === 'ready') return { ok: true, config: state }
    emit({ status: 'loading', error: '' })
    loadPromise = request('get')
      .then((result) => {
        if (!result?.ok) throw new Error(result?.error || '读取配置失败')
        const config = normalizeAiSearchPublicConfig(result.config)
        emit({ ...config, status: 'ready', error: '' })
        return { ok: true, config }
      })
      .catch((error) => {
        emit({ status: 'error', error: String(error?.message || error) })
        return { ok: false, error: String(error?.message || error) }
      })
      .finally(() => { loadPromise = null })
    return loadPromise
  },
  async toggle() {
    if (state.status === 'saving') return { ok: false, error: '设置保存中' }
    if (!state.hasKey && !state.enabled) {
      aiSearchConfigStore.open()
      return { ok: false, error: '请先配置 API Key' }
    }
    const enabled = !state.enabled
    return savePatch({ enabled }, { optimisticEnabled: enabled })
  },
  async save({ enabled = state.enabled, apiKey = '' } = {}) {
    return savePatch({
      enabled: !!enabled,
      apiKey: String(apiKey || '').trim(),
    }, { optimisticEnabled: !!enabled })
  },
}

export function useAiSearchConfig() {
  return useSyncExternalStore(
    aiSearchConfigStore.subscribe,
    aiSearchConfigStore.get,
  )
}
