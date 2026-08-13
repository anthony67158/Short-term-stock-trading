// 「服务端按需生成 AI 操作建议」触发器(fire-and-forget)。
// 为什么存在:原先建议生成 100% 在浏览器里跑(callAIStream 走 SSE,无重试)——
//   手机上一旦切到后台/锁屏,iOS 会冻结页面并掐断在途网络连接 → SSE 断流 → "生成失败"。
// 这里把生成搬到服务端:向 /api/cron_advice 的【按需分支】发一个带账号密码的 POST,
//   enqueue 只在任务持久化且 FC 异步 Worker 已受理后返回；Worker 是独立函数调用，
//   浏览器刷新/锁屏/断网不会影响执行。前端必须读取受理结果，不再做未经确认的乐观启动。
import { api } from './apiBase'
import { authStore } from './authStore'
import { planStore } from './planStore'
import { ensureAdviceAccountSynced } from '../shared/adviceAccountSync.js'

let statusTimer = null
let statusPulling = false
let statusConsumer = null
let statusFastUntil = 0

export async function fetchServerAdviceStatus() {
  let creds = null
  try { creds = authStore.getCreds && authStore.getCreds() } catch { creds = null }
  if (!creds || !creds.nick || statusPulling) return null
  statusPulling = true
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(api('/api/cron_advice'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'status', nick: creds.nick, pw: creds.pw }),
      signal: controller.signal,
    })
    const data = await response.json()
    return data && data.ok ? data.progress : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
    statusPulling = false
  }
}

async function statusTick() {
  const progress = await fetchServerAdviceStatus()
  if (progress && statusConsumer) {
    try { statusConsumer(progress) } catch { /* ignore */ }
  }
  const fast = (progress && progress.running) || Date.now() < statusFastUntil
  statusTimer = setTimeout(statusTick, fast ? 2000 : 15000)
}

export function startServerAdviceStatusSync(consumer) {
  if (typeof consumer === 'function') statusConsumer = consumer
  if (typeof window === 'undefined' || statusTimer) return
  statusTimer = setTimeout(statusTick, 0)
}

export function kickServerAdviceStatusSync() {
  if (typeof window === 'undefined') return
  statusFastUntil = Date.now() + 30000
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(statusTick, 0)
}

// 触发服务端生成。codes=要生成的股票代码数组;成功发出返回 true,无登录态/空列表返回 false。
export async function triggerServerAdvice(codes, {
  scope = 'all', force = true, batchId = '', deepMode = false,
} = {}) {
  let creds = null
  try { creds = authStore.getCreds && authStore.getCreds() } catch { creds = null }
  if (!creds || !creds.nick) return { ok: false, error: '请先登录' }
  const list = [...new Set((codes || []).filter(Boolean).map(String))]
  if (!list.length) return { ok: false, error: '未选择股票' }
  const synced = await ensureAdviceAccountSynced({
    flushLocal: () => planStore.flushSave(),
    retryCloud: () => authStore.retrySave(),
  })
  if (!synced.ok) return synced
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(api('/api/cron_advice'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ondemand: true, codes: list, nick: creds.nick, pw: creds.pw, scope, force, batchId, deepMode,
      }),
      signal: controller.signal,
      keepalive: true,
    })
    const data = await response.json().catch(() => null)
    if (!data || typeof data !== 'object') {
      return {
        ok: false,
        queued: true,
        error: `云端返回异常(${response.status})，正在核对任务状态`,
      }
    }
    if (data.progress && statusConsumer) {
      try { statusConsumer(data.progress) } catch { /* ignore */ }
    }
    kickServerAdviceStatusSync()
    return data
  } catch {
    kickServerAdviceStatusSync()
    return {
      ok: false,
      queued: true,
      error: '提交结果未确认，正在核对云端任务状态',
    }
  } finally {
    clearTimeout(timeout)
  }
}

// 是否具备服务端生成条件(已登录云端账号)。前端据此决定走服务端还是本地兜底。
export function canServerAdvice() {
  try { const c = authStore.getCreds && authStore.getCreds(); return !!(c && c.nick) } catch { return false }
}

// 取消服务端任务:codes 为空/未传 → 取消全部(op:'cancelAll'),否则取消指定 codes(op:'cancel')。
// fire-and-forget + keepalive:即使随后切后台/关页面也已送达 FC;取消结果经 authStore.pull 轮询云端回灌。
// 返回 true=已发出,false=无登录态。
export function cancelServerAdvice(codes, batchId = '') {
  let creds = null
  try { creds = authStore.getCreds && authStore.getCreds() } catch { creds = null }
  if (!creds || !creds.nick) return false
  const list = [...new Set((codes || []).filter(Boolean).map(String))]
  const op = list.length ? 'cancel' : 'cancelAll'
  try {
    fetch(api('/api/cron_advice'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, codes: list, nick: creds.nick, pw: creds.pw, batchId }),
      keepalive: true,
    }).catch(() => { /* 取消结果靠云端轮询,忽略网络层错误 */ })
    kickServerAdviceStatusSync()
    return true
  } catch { return false }
}
