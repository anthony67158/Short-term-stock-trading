// ============ Web Push 订阅管理(前端) ============
// 目标:页面关闭/切后台/锁屏也能收到盯盘预警(买点、止盈、止损、涨跌停…)。
// 链路:注册 Service Worker(/sw.js) → 用 VAPID 公钥订阅 PushManager → 把订阅上报到
//       api/push.js(绑定当前账号) → 服务端 cron_alert.js 命中即用 web-push 下发 → SW 弹系统通知。
// iOS 特别说明:必须 iOS 16.4+,且从 Safari「分享→添加到主屏幕」以 PWA 打开后才支持;
//              普通 Safari 标签页 / 非 Safari 内核浏览器均不支持(系统限制,非本站问题)。

import { api as apiUrl } from './apiBase'
import { authStore } from './authStore'
import { requestPushPermission } from '../shared/pushPermission.js'

let _vapidPub = null
let _syncedBinding = ''

// 能力探测:是否可能支持 Web Push
export function pushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

// iOS 判定 + 是否已以 PWA(添加到主屏幕)方式打开——用于给 iOS 用户精准引导
export function iosInfo() {
  const ua = navigator.userAgent || ''
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  return { isIOS, standalone }
}

async function getVapidKey() {
  if (_vapidPub) return _vapidPub
  try {
    const r = await fetch('/vapid.json', { cache: 'no-cache' })
    const j = await r.json()
    _vapidPub = j && j.publicKey
  } catch { _vapidPub = null }
  return _vapidPub
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null
  try { return await navigator.serviceWorker.register('/sw.js') } catch { return null }
}

// 当前订阅状态:'unsupported' | 'denied' | 'off'(支持但未订阅) | 'on'(已订阅)
export async function pushStatus() {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return 'off'
    const sub = await reg.pushManager.getSubscription()
    return sub ? 'on' : 'off'
  } catch { return 'off' }
}

async function uploadSubscription(sub, creds, { force = false } = {}) {
  if (!sub || !creds) return { ok: false, error: '推送订阅或账号不可用' }
  const binding = `${creds.nick}|${sub.endpoint}`
  if (!force && binding === _syncedBinding) return { ok: true }
  const r = await fetch(apiUrl('/api/push'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'subscribe', ...creds, subscription: sub, ua: navigator.userAgent }),
  })
  const j = await r.json().catch(() => ({ ok: false }))
  if (!j.ok) return { ok: false, error: j.error || '订阅上报失败' }
  _syncedBinding = binding
  return { ok: true }
}

// 兼容历史账号保存曾误删服务端 pushSubs 的情况：浏览器本地订阅仍存在时，
// 登录恢复后静默重新绑定，无需用户先关闭再开启。
export async function syncPushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') {
    return { ok: false, skipped: true }
  }
  const creds = authStore.getCreds()
  if (!creds) return { ok: false, skipped: true }
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = reg && (await reg.pushManager.getSubscription())
    if (!sub) return { ok: false, skipped: true }
    return await uploadSubscription(sub, creds)
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 开启推送:请求授权 → 订阅 → 上报绑定账号。返回 { ok, error? }
export async function enablePush() {
  if (!pushSupported()) return { ok: false, error: '当前环境不支持系统推送' }
  const creds = authStore.getCreds()
  if (!creds) return { ok: false, error: '请先登录账号再开启推送' }
  const pub = await getVapidKey()
  if (!pub) return { ok: false, error: '推送公钥未配置' }
  try {
    const perm = await requestPushPermission(Notification)
    if (perm !== 'granted') return { ok: false, error: '通知权限被拒绝' }
    const reg = (await navigator.serviceWorker.getRegistration()) || (await registerSW())
    if (!reg) return { ok: false, error: 'Service Worker 注册失败' }
    await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pub),
      })
    }
    return await uploadSubscription(sub, creds, { force: true })
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 关闭推送:取消本设备订阅 + 通知服务端删除
export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = reg && (await reg.pushManager.getSubscription())
    if (sub) {
      const creds = authStore.getCreds()
      try {
        await fetch(apiUrl('/api/push'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unsubscribe', ...(creds || {}), endpoint: sub.endpoint }),
        })
      } catch { /* ignore */ }
      await sub.unsubscribe()
    }
    _syncedBinding = ''
    return { ok: true }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}
