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
      const failure = new Error(
        `尾盘任务提交超过${Math.round(timeoutMs / 1000)}秒，正在检查云端状态`,
      )
      failure.errorCode = 'REQUEST_TIMEOUT'
      throw failure
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function loadTailPickState() {
  return request('/api/tail_pick')
}

export function isActiveTailPickTask(task) {
  return ['QUEUED', 'RUNNING'].includes(task?.status)
}

export function runTailPick(tradeDate) {
  return request('/api/tail_pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'run',
      mode: 'manual',
      idempotencyKey: `tail-pick:${tradeDate}:manual:${Date.now()}`,
    }),
  }, 15_000)
}
