// 「服务端按需生成 AI 操作建议」触发器(fire-and-forget)。
// 为什么存在:原先建议生成 100% 在浏览器里跑(callAIStream 走 SSE,无重试)——
//   手机上一旦切到后台/锁屏,iOS 会冻结页面并掐断在途网络连接 → SSE 断流 → "生成失败"。
// 这里把生成搬到服务端:向 /api/cron_advice 的【按需分支】发一个带账号令牌的 POST,
//   enqueue 只在任务持久化且 FC 异步 Worker 已受理后返回；Worker 是独立函数调用，
//   浏览器刷新/锁屏/断网不会影响执行。前端必须读取受理结果，不再做未经确认的乐观启动。
import { api } from './apiBase'
import { authStore } from './authStore'
import { planStore } from './planStore'
import { ensureAdviceAccountSynced } from '../shared/adviceAccountSync.js'
import { createAdviceCompletionPuller } from '../shared/adviceUiState.js'
import {
  activeAdviceCancellationTargets,
  confirmAdviceBatchCancellation,
  confirmAdviceCancellation,
} from '../shared/adviceCancellation.js'

let statusTimer = null
let statusPulling = false
let statusConsumer = null
let statusFastUntil = 0
let statusRuntimeSince = 0
let statusRuntimeNick = ''
const pullCompletedAdvice = createAdviceCompletionPuller(
  () => authStore.pull(),
)

export async function fetchServerAdviceStatus() {
  let creds = null
  try { creds = authStore.getCreds && authStore.getCreds() } catch { creds = null }
  if (!creds || !creds.nick || statusPulling) return null
  if (statusRuntimeNick !== creds.nick) {
    statusRuntimeNick = creds.nick
    statusRuntimeSince = 0
  }
  statusPulling = true
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(api('/api/cron_advice'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'status',
        since: statusRuntimeSince,
        ...creds,
      }),
      signal: controller.signal,
    })
    const data = await response.json()
    if (!data?.ok) return null
    const deliveredAdvice = new Map()
    for (const update of (Array.isArray(data.runtimeUpdates)
      ? data.runtimeUpdates
      : [])) {
      if (!update?.code) continue
      const delta = {
        ...(update.advice
          ? { advice: { [String(update.code)]: update.advice } }
          : {}),
        adviceLog: update.adviceLog || [],
        decisionLog: update.decisionLog || [],
        alerts: update.alerts || [],
      }
      try {
        planStore.mergeCloud(delta)
        if (update.advice) {
          deliveredAdvice.set(
            String(update.code),
            Number(update.updatedAt) || 0,
          )
        }
        statusRuntimeSince = Math.max(
          statusRuntimeSince,
          Number(update.updatedAt) || 0,
        )
      } catch {
        return data.progress || null
      }
    }
    const latestTerminal = [
      ...(data.progress?.items || []),
      ...(data.progress?.reviews || []),
    ]
      .filter((item) => item?.status === 'ok' && item?.code)
      .sort((left, right) =>
        Number(right.progressAt) - Number(left.progressAt)
      )[0]
    const adviceDelivered = !!latestTerminal
      && Number(deliveredAdvice.get(String(latestTerminal.code))) >=
        Number(latestTerminal.progressAt || 0)
    return {
      ...(data.progress || {}),
      adviceDelivered,
    }
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
  if (progress) await pullCompletedAdvice(progress)
  const fast = (
    progress
    && (progress.running || progress.reviewRunning)
  ) || Date.now() < statusFastUntil
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
  requestId = '',
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
        ondemand: true,
        codes: list,
        ...creds,
        scope,
        force,
        batchId,
        deepMode,
        requestId,
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

async function sendCancellationRequest(creds, targets, batchId = '') {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(api('/api/cron_advice'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'cancel',
        targets,
        codes: targets.map((target) => target.code),
        ...creds,
        batchId,
      }),
      signal: controller.signal,
      keepalive: true,
    })
    const data = await response.json().catch(() => null)
    if (!data || typeof data !== 'object') {
      throw new Error(`停止接口返回异常(${response.status})`)
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

async function sendBatchCancellationRequest(
  creds,
  batchId,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(api('/api/cron_advice'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'cancelAll',
        ...creds,
        batchId,
      }),
      signal: controller.signal,
      keepalive: true,
    })
    const data = await response.json().catch(() => null)
    if (!data || typeof data !== 'object') {
      throw new Error(`停止接口返回异常(${response.status})`)
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

export async function cancelServerAdviceBatch(batchId, items = []) {
  let creds = null
  try {
    creds = authStore.getCreds && authStore.getCreds()
  } catch {
    creds = null
  }
  const key = String(batchId || '')
  if (!creds?.nick || !key) {
    return {
      ok: false,
      confirmed: false,
      canceled: 0,
      batchId: key,
      error: !creds?.nick ? '请先登录' : '缺少批次标识',
    }
  }
  const targets = activeAdviceCancellationTargets(items)
  kickServerAdviceStatusSync()
  const result = await confirmAdviceBatchCancellation({
    batchId: key,
    targets,
    attempts: 4,
    delayMs: 350,
    send: () => sendBatchCancellationRequest(creds, key),
    readStatus: fetchServerAdviceStatus,
  })
  if (result.progress && statusConsumer) {
    try { statusConsumer(result.progress) } catch { /* ignore */ }
  }
  kickServerAdviceStatusSync()
  return result
}

// 取消必须等云端权威状态确认。请求失败会重试；每个目标携带 jobId，
// 防止旧页面延迟到达的取消误伤同股票的新一轮任务。
export async function cancelServerAdvice(items, batchId = '') {
  let creds = null
  try { creds = authStore.getCreds && authStore.getCreds() } catch { creds = null }
  if (!creds || !creds.nick) {
    return { ok: false, confirmed: false, error: '请先登录' }
  }
  const normalizedItems = (items || []).map((item) =>
    typeof item === 'string'
      ? { code: item, status: 'running', jobId: '' }
      : item
  )
  const targets = activeAdviceCancellationTargets(normalizedItems)
  if (!targets.length) {
    return { ok: true, confirmed: true, canceled: 0, progress: null }
  }
  kickServerAdviceStatusSync()
  const result = await confirmAdviceCancellation({
    targets,
    attempts: 5,
    delayMs: 1000,
    send: (currentTargets) =>
      sendCancellationRequest(creds, currentTargets, batchId),
    readStatus: fetchServerAdviceStatus,
  })
  if (result.progress && statusConsumer) {
    try { statusConsumer(result.progress) } catch { /* ignore */ }
  }
  kickServerAdviceStatusSync()
  return result
}
