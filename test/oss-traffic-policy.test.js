import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('FC与杭州OSS同地域时强制使用内网Endpoint', () => {
  const yaml = read('s.yaml')

  assert.match(
    yaml,
    /^\s+OSS_ENDPOINT:\s*https:\/\/oss-cn-hangzhou-internal\.aliyuncs\.com/m,
  )
  assert.match(
    yaml,
    /^\s+OSS_ALLOW_PUBLIC_NETWORK:\s*"false"/m,
  )
})

test('跨设备账号同步每30秒走FC增量接口且OSS保持内网访问', () => {
  const authStore = read('src/authStore.js')

  assert.match(authStore, /api\('sync'/)
  assert.match(authStore, /PULL_INTERVAL\s*=\s*30\s*\*\s*1000/)
  assert.match(authStore, /PULL_FAST\s*=\s*15\s*\*\s*1000/)
  assert.doesNotMatch(authStore, /setTimeout\(tick,\s*0\)/)
})

test('军师Worker降低进度落盘与取消检查频率', () => {
  const cronAdvice = read('api/cron_advice.js')

  assert.match(cronAdvice, /PROGRESS_SAVE_INTERVAL_MS\s*=\s*5000/)
  assert.match(cronAdvice, /CANCEL_POLL_INTERVAL_MS\s*=\s*5000/)
  assert.match(cronAdvice, /history:\s*false/)
  assert.match(cronAdvice, /verify:\s*false/)
})
