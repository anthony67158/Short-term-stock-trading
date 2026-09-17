import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

const READ_TIMEOUT_MS = 30_000
const RUN_TIMEOUT_MS = 180_000

function clientError(error = {}) {
  const status = Number(error?.status) || 0
  const detail = String(error?.message || error || '')
  if (
    status >= 500
    || /HTTP\s*\d{3}|fetch failed|network|timeout|aborted|超时/i.test(detail)
  ) return '选股服务暂时不可用，请稍后重试'
  return detail || '选股服务暂时不可用'
}

async function call(path, { method = 'GET', body = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(api(path), {
      method,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...accountRequestHeaders(),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      const failure = new Error(payload?.error || `选股服务异常(${response.status})`)
      failure.status = response.status
      throw failure
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('选股请求超时')
    const failure = new Error(clientError(error))
    failure.status = error?.status || 0
    throw failure
  } finally {
    clearTimeout(timeout)
  }
}

export function loadStockPick() {
  return call('/api/stock_pick')
}

export function runStockPickRecall() {
  return call('/api/stock_pick', {
    method: 'POST',
    body: { action: 'run' },
    timeoutMs: RUN_TIMEOUT_MS,
  })
}

export function runStockPickAgent() {
  return call('/api/stock_pick', {
    method: 'POST',
    body: { action: 'agent' },
    timeoutMs: RUN_TIMEOUT_MS,
  })
}
