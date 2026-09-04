const ACCOUNT_COMPRESSION_THRESHOLD_BYTES = 64 * 1024

export function accountRequestTimeoutMs(action) {
  const normalized = String(action || '')
  if (['login', 'register'].includes(normalized)) return 45000
  if (normalized === 'get') return 30000
  if (normalized === 'save') return 45000
  return 20000
}

async function accountRequestBody(action, payload) {
  const serialized = JSON.stringify({ action, ...payload })
  const canCompress = (
    typeof CompressionStream === 'function'
    && typeof Blob === 'function'
    && typeof Response === 'function'
  )
  const source = canCompress ? new Blob([serialized]) : null
  if (
    !['register', 'save'].includes(String(action || ''))
    || !source
    || source.size < ACCOUNT_COMPRESSION_THRESHOLD_BYTES
  ) {
    return {
      body: serialized,
      headers: { 'Content-Type': 'application/json' },
    }
  }

  try {
    const stream = source
      .stream()
      .pipeThrough(new CompressionStream('gzip'))
    const compressed = new Uint8Array(
      await new Response(stream).arrayBuffer(),
    )
    return {
      body: compressed,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
    }
  } catch {
    return {
      body: serialized,
      headers: { 'Content-Type': 'application/json' },
    }
  }
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
  const request = await accountRequestBody(action, payload)
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1000, Number(timeoutMs) || 20000),
  )
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
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
