import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

async function request(path, options = {}, timeoutMs = 70_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(api(path), {
      ...options,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        ...accountRequestHeaders(),
        ...(options.headers || {}),
      },
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(
        payload?.error
        || `公式选股服务异常(${response.status})`,
      )
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('公式计算超时，请稍后重试')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function loadFormulaSelectionState() {
  return request('/api/formula_selection?view=latest')
}

export function runFormulaSelection(mode) {
  return request('/api/formula_selection', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key':
        `formula-selection:${mode}:${Date.now()}`,
    },
    body: JSON.stringify({ mode }),
  }, mode === 'close' ? 100_000 : 70_000)
}

export function loadFormulaSelectionProgress(mode) {
  return request(
    `/api/formula_selection?view=progress&mode=${encodeURIComponent(mode)}`,
    {},
    10_000,
  )
}

export function loadStockFormulaPrice(code) {
  return request(
    `/api/formula_selection?view=stock&code=${encodeURIComponent(code)}`,
    {},
    30_000,
  )
}
