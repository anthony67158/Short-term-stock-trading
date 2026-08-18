// ============ Service Worker:后台/关页面 Web Push 接收 ============
// 由前端 push.js 注册。即使浏览器标签全关(或手机切后台/锁屏),只要系统进程存活,
// 收到服务端(api/cron_alert.js 经 web-push 网关)下发的推送就会弹系统通知。
// iOS 需 16.4+ 且「添加到主屏幕」以 PWA 方式打开后,本 SW 才会被系统保活以收推送。

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// 收到推送 → 弹系统通知
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: (event.data && event.data.text()) || '' }; }
  const title = data.title || '⚡ 盯盘预警';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || ('alert-' + Date.now()),
    renotify: true,
    data: { url: data.url || '/', code: data.code || '' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 点通知 → 聚焦已开页面,或新开
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { try { await c.focus(); return; } catch { /* ignore */ } } }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
