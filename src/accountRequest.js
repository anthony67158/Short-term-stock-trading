export async function accountApiRequest(
  url,
  action,
  payload,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
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
    return {
      ok: false,
      error: error?.name === 'AbortError'
        ? '请求超时，请重试'
        : '网络连接失败，请检查网络后重试',
    }
  } finally {
    clearTimeout(timeout)
  }
}
