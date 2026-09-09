// SSE 终态必须立即交付。HTTP 连接是否关闭不代表模型是否完成。
export async function readAIResultStream(body, { onPhase, onEvent, signal } = {}) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('服务未返回可读取的分析流')
  }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let result
  let completed = false
  let rejectAbort
  const aborted = new Promise((resolve, reject) => { rejectAbort = reject })
  const onAbort = () => {
    rejectAbort(signal?.reason || new DOMException('已取消', 'AbortError'))
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const consume = (flush = false) => {
    buffer = buffer.replace(/\r\n/g, '\n')
    if (flush && buffer.trim()) buffer += '\n\n'
    let boundary
    while (!completed && (boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      let event = 'message'
      const lines = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart())
      }
      if (!lines.length) continue
      let data
      try { data = JSON.parse(lines.join('\n')) } catch { continue }
      if (event === 'result') {
        if (!data || typeof data !== 'object') continue
        result = data
        completed = true
      } else {
        // 订阅方渲染异常不能丢弃已经收到的模型正文。
        try {
          if (event === 'phase') onPhase?.(data)
          else onEvent?.(event, data)
        } catch { /* UI 订阅隔离 */ }
      }
    }
  }
  try {
    while (!completed) {
      const { value, done } = await Promise.race([reader.read(), aborted])
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      consume(done)
      if (done) break
    }
    return result || { ok: false, error: '分析连接已结束，但未收到完整结果，请重试' }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // cancel 本身也可能受代理阻塞，不能再把已收到的终态挂在网络清理上。
    try { void reader.cancel().catch(() => {}) } catch { /* ignore */ }
    try { reader.releaseLock() } catch { /* 未完成读取由 cancel 收束 */ }
  }
}
