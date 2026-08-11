import { useSyncExternalStore } from 'react'
import { api } from './apiBase'
import { authStore } from './authStore'
import { planStore } from './planStore'
import { syncControlSelection } from '../shared/modelVersion.js'

let state = {
  open: false,
  loading: false,
  error: '',
  control: null,
  accuracy: null,
}
const listeners = new Set()
let statusPollTimer = null
const STATUS_POLL_MS = 4000
function emit() {
  state = { ...state }
  listeners.forEach((listener) => {
    try { listener() } catch { /* ignore */ }
  })
}

function stopStatusPolling() {
  if (statusPollTimer) clearTimeout(statusPollTimer)
  statusPollTimer = null
}

function scheduleStatusPolling() {
  stopStatusPolling()
  if (!state.open || !state.control?.v2Transitioning) return
  statusPollTimer = setTimeout(async () => {
    statusPollTimer = null
    await run('get', {}, { background: true })
    scheduleStatusPolling()
  }, STATUS_POLL_MS)
}

async function request(action, extra = {}) {
  const creds = authStore.getCreds()
  if (!creds) throw new Error('请先登录')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45000)
  try {
    const response = await fetch(api('/api/quant_model'), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...creds, ...extra }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.ok) throw new Error(body?.error || '模型控制失败')
    return body
  } finally {
    clearTimeout(timeout)
  }
}

async function run(action, extra = {}, { background = false } = {}) {
  if (!background) state.loading = true
  state.error = ''
  emit()
  try {
    const body = await request(action, extra)
    state.control = body.control || state.control
    state.accuracy = body.accuracy || state.accuracy
    if (body.control) {
      syncControlSelection(body.control, (key, value) => {
        if (planStore.getSetting(key, 'default') !== value) {
          planStore.setSetting(key, value)
        }
      })
    }
    return body
  } catch (error) {
    state.error = error?.name === 'AbortError'
      ? '模型控制响应较慢，系统会继续同步状态'
      : String(error?.message || error)
    return null
  } finally {
    if (!background) state.loading = false
    emit()
  }
}

export const quantModelStore = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  get() { return state },
  async open() {
    stopStatusPolling()
    state.open = true
    emit()
    await run('get')
    scheduleStatusPolling()
  },
  close() {
    stopStatusPolling()
    state.open = false
    emit()
  },
  async refresh() {
    const body = await run('get')
    scheduleStatusPolling()
    return body
  },
  async select(version) {
    const body = await run('select', { version })
    scheduleStatusPolling()
    return body
  },
  async setV2Enabled(enabled) {
    const body = await run(enabled ? 'startV2' : 'stopV2')
    scheduleStatusPolling()
    return body
  },
}

export function useQuantModelStore() {
  return useSyncExternalStore(quantModelStore.subscribe, quantModelStore.get)
}
