async function notificationRegistration() {
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing?.active) return existing
  try {
    if (!existing) await navigator.serviceWorker.register('/sw.js')
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ])
  } catch { return null }
}

export async function showSystemNotification(notification = {}) {
  const title = String(notification.title || '').trim()
  const body = String(notification.body || '').trim()
  if (
    !title
    || typeof navigator === 'undefined'
    || !('serviceWorker' in navigator)
    || typeof Notification === 'undefined'
    || Notification.permission !== 'granted'
  ) return { ok: false, reason: '系统通知权限未开启' }

  const tag = String(
    notification.alertId
    || notification.tag
    || `alert-${Date.now()}`,
  ).slice(0, 160)
  const options = {
    body,
    icon: '/app-icon-192.png?v=7',
    badge: '/app-icon-192.png?v=7',
    tag,
    renotify: true,
    data: {
      url: notification.url || '/',
      code: String(notification.code || ''),
    },
  }
  try {
    const registration = await notificationRegistration()
    if (!registration?.showNotification) {
      return { ok: false, reason: '系统通知服务尚未就绪' }
    }
    await registration.showNotification(title, options)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: String(error?.message || '系统通知发送失败'),
    }
  }
}
