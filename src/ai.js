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
