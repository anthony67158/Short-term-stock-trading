import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

async function request(path, options = {}, timeoutMs = 45_000) {
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
        || `尾盘选股服务异常(${response.status})`,
      )
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('尾盘选股超过45秒，请查看任务状态')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function loadTailPickState() {
  return request('/api/tail_pick')
}

export function runTailPick(tradeDate) {
  return request('/api/tail_pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'run',
      idempotencyKey: `tail-pick:${tradeDate}:1450`,
    }),
  }, 60_000)
}
