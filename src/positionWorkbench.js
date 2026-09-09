import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

const MIN_REFRESH_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

export async function loadPositionWorkbench({ signal } = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(api('/api/position_workbench'), {
      cache: 'no-store',
      headers: accountRequestHeaders(),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(
        payload?.error?.message
        || payload?.error
        || `持仓决策读取失败(${response.status})`,
      )
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError' && !signal?.aborted) {
      throw new Error('持仓决策读取超时')
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener?.('abort', abort)
  }
}

export function usePositionWorkbench(
  intervalMs,
  dependencyKey = '',
) {
  const [state, setState] = useState({
    data: null,
    loading: true,
    error: '',
  })
  const controllerRef = useRef(null)
  const load = useCallback(async () => {
    if (controllerRef.current) {
      try { controllerRef.current.abort() } catch { /* ignore */ }
    }
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const data = await loadPositionWorkbench({
        signal: controller.signal,
      })
      if (!controller.signal.aborted) {
        setState({ data, loading: false, error: '' })
      }
    } catch (error) {
      if (error?.name === 'AbortError') return
      if (!controller.signal.aborted) {
        setState((current) => ({
          ...current,
          loading: false,
          error: String(error?.message || error),
        }))
      }
    }
  }, [dependencyKey])

  useEffect(() => {
    void load()
    const delay = Math.max(
      MIN_REFRESH_MS,
      Number(intervalMs) || MIN_REFRESH_MS,
    )
    const timer = window.setInterval(() => {
      void load()
    }, delay)
    return () => {
      window.clearInterval(timer)
      if (controllerRef.current) {
        try { controllerRef.current.abort() } catch { /* ignore */ }
      }
    }
  }, [intervalMs, load])

  return {
    ...state,
    reload: load,
  }
}
