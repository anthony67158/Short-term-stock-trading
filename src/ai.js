// 调用后端 AI 代理（健壮解析：后端超时/崩溃时 Vercel 返回纯文本而非 JSON）
export async function callAI(mode, payload) {
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, payload }),
    })
    const raw = await res.text()
    try {
      return JSON.parse(raw)
    } catch {
      // 非 JSON = 平台层错误（504 超时 / 函数崩溃返回 "An error occurred..."）
      const timeout = res.status === 504 || /timed? ?out|An error occurred/i.test(raw)
      return { ok: false, error: timeout ? '分析超时，请稍后重试或缩小问题范围' : `服务暂时不可用（${res.status}）` }
    }
  } catch (e) {
    return { ok: false, error: '网络异常：' + String(e.message || e) }
  }
}

// 流式调用：数据采集阶段把进度(phase)实时回调给 UI，最终返回结构化 result(与 callAI 同结构)。
// onPhase({text,key}) 每到一个采集里程碑触发一次；signal 可选 AbortSignal。
// 后端不支持 SSE 时自动回退为整段 JSON，不影响结果。
export async function callAIStream(mode, payload, onPhase, signal) {
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, payload, stream: true }),
      signal,
    })
    const ctype = res.headers.get('content-type') || ''
    // 后端未走 SSE（旧版/错误）→ 回退整段解析
    if (!ctype.includes('text/event-stream')) {
      const raw = await res.text()
      try { return JSON.parse(raw) } catch {
        const timeout = res.status === 504 || /timed? ?out|An error occurred/i.test(raw)
        return { ok: false, error: timeout ? '分析超时，请稍后重试或缩小问题范围' : `服务暂时不可用（${res.status}）` }
      }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    let result = null
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep); buf = buf.slice(sep + 2)
        let event = 'message', dataStr = ''
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
        }
        if (!dataStr) continue
        let data = null; try { data = JSON.parse(dataStr) } catch { continue }
        if (event === 'phase') { if (typeof onPhase === 'function') onPhase(data) }
        else if (event === 'result') { result = data }
      }
    }
    return result || { ok: false, error: '分析未返回结果，请重试' }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, aborted: true, error: '已取消' }
    return { ok: false, error: '网络异常：' + String(e.message || e) }
  }
}
