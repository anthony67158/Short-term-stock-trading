export function accountRequestTimeoutMs(action) {
  const normalized = String(action || '')
  if (['login', 'register'].includes(normalized)) return 45000
  if (normalized === 'get') return 12000
  return 20000
}

export async function accountApiRequest(
  url,
  action,
  payload,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = accountRequestTimeoutMs(action),
  } = {},
) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1000, Number(timeoutMs) || 20000),
  )
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    })
    const raw = await response.text()
    try {
      return JSON.parse(raw)
    } catch {
      return {
        ok: false,
        error: `服务异常(${response.status})`,
      }
    }
  } catch (error) {
    const timedOut = error?.name === 'AbortError'
    return {
      ok: false,
      transient: true,
      code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      error: timedOut
        ? '请求超时，请重试'
        : '网络连接失败，请检查网络后重试',
    }
  } finally {
    clearTimeout(timeout)
  }
}
