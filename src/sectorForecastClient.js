import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

export async function sectorForecastRequest({
  action = 'latest',
  method = 'GET',
  body = {},
  query = {},
  timeoutMs = 20000,
} = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const params = new URLSearchParams({ action, ...query })
  try {
    const response = await fetch(
      api(`/api/sector_forecast?${params.toString()}`),
      {
        method,
        signal: controller.signal,
        headers: {
          ...accountRequestHeaders(),
          ...(method === 'POST'
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        ...(method === 'POST'
          ? { body: JSON.stringify({ action, ...body }) }
          : {}),
      },
    )
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(
        payload?.error
        || `板块前瞻服务异常(${response.status})`,
      )
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('板块前瞻请求超时')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
