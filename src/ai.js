// 调用后端 AI 代理（健壮解析：后端超时/崩溃时 Vercel 返回纯文本而非 JSON）
import { api } from './apiBase'
import { accountRequestHeaders, quantModelHeaders } from './quantModel'

// 盘面研究·外部宏观快讯聚合：一次性拉取宏观要闻 + 7×24 快讯（非流式）
export async function fetchMarketNews() {
  try {
    const res = await fetch(api('/api/market?news=1'))
    const raw = await res.text()
    try { return JSON.parse(raw) } catch {
      return { ok: false, error: `服务暂时不可用（${res.status}）`, macro: [], flashes: [] }
    }
  } catch (e) {
    return { ok: false, error: '网络异常：' + String(e.message || e), macro: [], flashes: [] }
  }
}

// 全市场策略日报：SSE 流式(phase 进度 + result 结果)。session: morning|noon|evening
export async function fetchDailyReport({
  session,
  holdings,
  watchlist,
  refresh,
  onPhase,
  signal,
}) {
  try {
    const qs = `?session=${session || ''}${refresh ? '&refresh=1' : ''}`
    const res = await fetch(api('/api/daily_report' + qs), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...accountRequestHeaders(),
      },
      body: JSON.stringify({
        holdings: holdings || [],
        watchlist: watchlist || [],
      }),
      signal,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = '', result = null
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
        else if (event === 'result') result = data
      }
    }
    return result || { ok: false, error: '日报未返回结果，请重试' }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, aborted: true, error: '已取消' }
    return { ok: false, error: '网络异常：' + String(e.message || e) }
  }
}

async function dailyReportScheduleRequest(action, settings) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(api('/api/daily_report_schedule'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...accountRequestHeaders(),
      },
      body: JSON.stringify({
        action,
        ...(settings ? { settings } : {}),
      }),
      signal: controller.signal,
    })
    const raw = await response.text()
    let payload = null
    try { payload = JSON.parse(raw) } catch {
      throw new Error(`服务暂时不可用（${response.status}）`)
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `服务暂时不可用（${response.status}）`)
    }
    return payload
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchDailyReportSchedule() {
  return dailyReportScheduleRequest('get')
}

export async function saveDailyReportSchedule(settings) {
  return dailyReportScheduleRequest('save', settings)
}
// onPhase({text,key}) 每到一个采集里程碑触发一次；signal 可选 AbortSignal。
// 第 5 参 onEvent(event,data) 可选：转发细粒度事件——
//   'source'{label,ok}   每个数据源采集完成(名称+成功/失败)，供前端渲染勾选清单；
//   'reasoning'{text}    模型思维链增量(开启深度思考时)，供前端实时展示"军师在想什么"。
// 后端不支持 SSE 时自动回退为整段 JSON，不影响结果。
export async function callAIStream(mode, payload, onPhase, signal, onEvent, options = {}) {
  try {
    const res = await fetch(api('/api/ai'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...accountRequestHeaders(),
        ...quantModelHeaders(payload?.quantModelVersion),
      },
      body: JSON.stringify({
        mode,
        payload,
        stream: true,
        ...(options.fastMode != null ? { fastMode: !!options.fastMode } : {}),
        ...(options.forceReasoning ? { forceReasoning: true } : {}),
        ...(options.runtimeBudgetMs ? { runtimeBudgetMs: options.runtimeBudgetMs } : {}),
      }),
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
        else if (typeof onEvent === 'function') onEvent(event, data)  // source / reasoning 等细粒度事件
      }
    }
    return result || { ok: false, error: '分析未返回结果，请重试' }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, aborted: true, error: '已取消' }
    return { ok: false, error: '网络异常：' + String(e.message || e) }
  }
}
