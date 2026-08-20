import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const index = read('index.html')
const main = read('src/main.jsx')
const app = read('src/App.jsx')

test('首次载入与恢复登录只使用同一个启动加载层', () => {
  const splashAt = index.indexOf('id="app-splash"')
  const rootAt = index.indexOf('id="root"')

  assert.ok(splashAt >= 0)
  assert.ok(rootAt > splashAt)
  assert.doesNotMatch(
    index,
    /<div id="root">\s*<div id="app-splash">/,
  )
  assert.match(app, /if \(booting\) return null/)
  assert.doesNotMatch(app, /auth-card-loading/)
  assert.doesNotMatch(app, /正在恢复登录/)
})

test('启动加载层等待账号恢复完成后再统一退出', () => {
  assert.match(app, /dismissBootSplash/)
  assert.match(app, /if \(!booting\) dismissBootSplash\(\)/)
  assert.doesNotMatch(main, /requestAnimationFrame\([^)]*hideSplash/)
  assert.doesNotMatch(main, /setTimeout\(hideSplash,\s*4000\)/)
})
