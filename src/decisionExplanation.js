import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

const REQUEST_TIMEOUT_MS = 30_000

export async function loadDecisionExplanation(code, decisionId, {
  signal,
} = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(api('/api/decision_explain'), {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...accountRequestHeaders(),
      },
      body: JSON.stringify({ code, decisionId }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || '模型解读暂不可用')
    }
    return payload.explanation
  } catch (error) {
    if (error?.name === 'AbortError' && !signal?.aborted) {
      throw new Error('模型解读超时')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abort)
  }
}
