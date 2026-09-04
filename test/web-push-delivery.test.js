import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { normalizePushDelivery } from '../api/_push_send.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('Web Push 使用通知级 TTL 和优先级并写入绝对过期时间', () => {
  const delivery = normalizePushDelivery({
    title: '贵州茅台｜观察价已到',
    body: '600519｜现价145.3≥145.24｜复核中，约2分钟内给结论',
    ttl: 180,
    urgency: 'normal',
  }, 1_000)
  const payload = JSON.parse(delivery.data)

  assert.deepEqual(delivery.options, {
    TTL: 180,
    urgency: 'normal',
  })
  assert.equal(payload.sentAt, 1_000)
  assert.equal(payload.expiresAt, 181_000)
})

test('Web Push 拒绝无限有效期和非法优先级', () => {
  const delivery = normalizePushDelivery({
    ttl: 86_400,
    urgency: 'urgent-now',
  }, 2_000)

  assert.deepEqual(delivery.options, {
    TTL: 3_600,
    urgency: 'normal',
  })
  assert.equal(JSON.parse(delivery.data).expiresAt, 3_602_000)
})

test('Service Worker 丢弃过期推送并用事件ID回灌站内通知', () => {
  const serviceWorker = read('public/sw.js')
  const systemNotification = read('src/systemNotification.js')
  const alertStore = read('src/alertStore.js')

  assert.match(serviceWorker, /Date\.now\(\) >= Number\(data\.expiresAt\)/)
  assert.match(serviceWorker, /alertId: data\.eventId \|\| tag/)
  assert.match(serviceWorker, /renotify: data\.renotify !== false/)
  assert.match(serviceWorker, /silent: data\.silent === true/)
  assert.match(
    systemNotification,
    /notification\.tag\s*\|\|\s*notification\.alertId/,
  )
  assert.match(alertStore, /if \(notification\?\.silent !== true\) beep\(\)/)
})
