import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

export async function runPreCatalyst({
  force = false,
  timeoutMs = 90_000,
} = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(api('/api/pre_catalyst'), {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        ...accountRequestHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'run',
        force,
      }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(
        payload?.error
        || `预催化扫描服务异常(${response.status})`,
      )
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('预催化扫描超时')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
