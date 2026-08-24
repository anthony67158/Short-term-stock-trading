import { api } from './apiBase.js'
import { accountRequestHeaders } from './quantModel.js'

function readEvent(chunk) {
  let event = 'message'
  let dataText = ''
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataText += line.slice(5).trim()
  }
  if (!dataText) return null
  try {
    return { event, data: JSON.parse(dataText) }
  } catch {
    return null
  }
}

function progressText(event, data) {
  if (event === 'status') return String(data?.text || '')
  if (event !== 'tool') return ''
  const label = String(data?.label || '公开资料')
  if (data?.status === 'calling') return `正在${label}…`
  if (data?.status === 'done') return `${label}已完成`
  return data?.status === 'error' ? `${label}暂时不可用` : ''
}

export async function requestAgentAnswer({
  question,
  onProgress,
  signal,
  timeoutMs = 125000,
  fetchImpl = fetch,
} = {}) {
  const prompt = String(question || '').trim()
  if (!prompt) throw new Error('缺少需要解释的问题')

  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener?.('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  try {
    const response = await fetchImpl(api('/api/agent'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...accountRequestHeaders(),
      },
      body: JSON.stringify({
        question: prompt,
        history: [],
        purpose: 'sector_concept_explanation',
      }),
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `智能体服务异常(${response.status})`)
      }
      const answer = String(payload?.answer || '').trim()
      if (!answer) throw new Error('智能体没有返回概念解释')
      return {
        answer,
        evidence: payload?.evidence || [],
        searchReference: payload?.searchReference || null,
        model: payload?.model || '',
      }
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('智能体响应不可读取')
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let answer = ''
    let result = null
    let failure = ''
    const handle = (parsed) => {
      if (!parsed) return
      const status = progressText(parsed.event, parsed.data)
      if (status) onProgress?.(status, parsed.event, parsed.data)
      if (parsed.event === 'delta') {
        answer += String(parsed.data?.text || '')
      } else if (parsed.event === 'done') {
        result = parsed.data
        answer = String(parsed.data?.answer || answer)
      } else if (parsed.event === 'error') {
        failure = String(parsed.data?.error || '智能体解释失败')
      }
    }
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        handle(readEvent(chunk))
      }
    }
    if (buffer.trim()) handle(readEvent(buffer))
    if (failure && !answer.trim()) throw new Error(failure)
    if (!answer.trim()) throw new Error('智能体没有返回概念解释')
    return {
      answer: answer.trim(),
      evidence: result?.evidence || [],
      searchReference: result?.searchReference || null,
      model: result?.model || '',
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(signal?.aborted ? '已取消概念解释' : '概念解释请求超时')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abort)
  }
}
