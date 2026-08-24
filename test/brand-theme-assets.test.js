import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { isPublicSiteAsset } from '../api/_site_access.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

function pngSize(path) {
  const buffer = readFileSync(new URL(`../${path}`, import.meta.url))
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    hasAlpha: [4, 6].includes(buffer[25]),
  }
}

function assetBuffer(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url))
}

const index = read('index.html')
const manifest = JSON.parse(read('public/manifest.json'))
const tokens = read('tokens.css')
const app = read('src/App.jsx')
const authGate = read('src/components/AuthGate.jsx')
const brandMark = read('src/components/BrandMark.jsx')
const server = read('server.js')
const themeStore = read('src/themeStore.js')
const precision = read('src/styles/precision.css')

test('网站、启动页与主题切换统一使用同一套新版品牌图标', () => {
  assert.doesNotMatch(index, /brand-light\.svg|brand-dark\.svg/)
  assert.match(index, /id="app-favicon"/)
  assert.doesNotMatch(index, /\.svg/)
  assert.match(index, /href="\/favicon-48\.png\?v=7"/)
  assert.match(index, /rel="apple-touch-icon"[^>]*href="\/apple-touch-icon-v7\.png"/)
  assert.match(index, /href="\/manifest\.json\?v=7"/)
  assert.match(index, /src="\/app-icon-192\.png\?v=7"/)
  assert.match(themeStore, /favicon-48\.png\?v=7/)
  assert.doesNotMatch(themeStore, /brand-light\.svg|brand-dark\.svg/)
  assert.match(brandMark, /src="\/app-icon-192\.png\?v=7"/)
  assert.doesNotMatch(brandMark, /brand-light\.svg|brand-dark\.svg/)
  assert.deepEqual(pngSize('public/apple-touch-icon-v7.png'), {
    width: 180,
    height: 180,
    hasAlpha: false,
  })
  assert.deepEqual(pngSize('public/apple-touch-icon.png'), {
    width: 180,
    height: 180,
    hasAlpha: false,
  })

  const v7AppleTouchIcon = assetBuffer('public/apple-touch-icon-v7.png')
  for (const path of [
    'public/apple-touch-icon.png',
    'public/apple-touch-icon-v2.png',
    'public/apple-touch-icon-v5.png',
    'public/apple-touch-icon-v6.png',
  ]) {
    assert.deepEqual(assetBuffer(path), v7AppleTouchIcon, path)
  }
})

test('PWA和网站图标由用户提供的同一位图母版生成', () => {
  assert.equal(existsSync(new URL('../public/app-icon-source.webp', import.meta.url)), true)
  assert.deepEqual(pngSize('public/app-icon-192.png'), {
    width: 192,
    height: 192,
    hasAlpha: false,
  })
  assert.deepEqual(pngSize('public/app-icon-512.png'), {
    width: 512,
    height: 512,
    hasAlpha: false,
  })
  assert.deepEqual(pngSize('public/app-icon-maskable-512.png'), {
    width: 512,
    height: 512,
    hasAlpha: false,
  })
  assert.deepEqual(pngSize('public/app-icon-1024.png'), {
    width: 1024,
    height: 1024,
    hasAlpha: false,
  })
  assert.deepEqual(pngSize('public/favicon-48.png'), {
    width: 48,
    height: 48,
    hasAlpha: false,
  })
  assert.ok(manifest.icons.some((icon) =>
    icon.src === '/app-icon-192.png?v=7' && icon.purpose === 'any'
  ))
  assert.ok(manifest.icons.some((icon) =>
    icon.src === '/app-icon-maskable-512.png?v=7'
      && icon.purpose === 'maskable'
  ))
  assert.ok(manifest.icons.every((icon) => icon.type === 'image/png'))
  for (const [canonical, legacy] of [
    ['public/app-icon-192.png', 'public/icon-192.png'],
    ['public/app-icon-512.png', 'public/icon-512.png'],
    ['public/app-icon-maskable-512.png', 'public/icon-maskable-512.png'],
  ]) {
    assert.deepEqual(assetBuffer(legacy), assetBuffer(canonical), legacy)
  }
  for (const path of [
    'public/app-icon.svg',
    'public/app-icon-maskable.svg',
    'public/favicon.svg',
    'public/safari-pinned-tab.svg',
    'public/brand-light.svg',
    'public/brand-dark.svg',
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path)
  }
})

test('受保护域名允许系统在未登录时读取PWA元数据和图标', () => {
  for (const path of [
    '/manifest.json',
    '/favicon-32.png',
    '/favicon-48.png',
    '/apple-touch-icon.png',
    '/apple-touch-icon-v5.png',
    '/apple-touch-icon-v6.png',
    '/apple-touch-icon-v7.png',
    '/app-icon-192.png',
    '/app-icon-512.png',
    '/app-icon-maskable-512.png',
  ]) {
    assert.equal(isPublicSiteAsset(path), true, path)
  }
  assert.equal(isPublicSiteAsset('/index.html'), false)
  assert.equal(isPublicSiteAsset('/api/account'), false)
  assert.match(server, /isPublicSiteAsset\(pathname\)/)
  assert.match(server, /application\/manifest\+json/)
})

test('导航和登录门户统一使用主题品牌标记', () => {
  assert.match(app, /import BrandMark from '\.\/components\/BrandMark'/)
  assert.match(app, /<BrandMark/)
  assert.match(authGate, /import BrandMark from '\.\/BrandMark'/)
  assert.match(authGate, /<BrandMark/)
})

test('亮色主题使用钴蓝强调色并保留A股红涨绿跌', () => {
  const light = tokens.match(/html\[data-theme="light"\]\s*{([\s\S]*?)\n}/)?.[1] || ''
  assert.match(light, /--color-accent:\s*oklch\(52% 0\.205 255\)/)
  assert.match(light, /--color-accent-ink:\s*oklch\(98\.5% 0\.006 255\)/)
  assert.match(light, /--color-up:\s*oklch\(57% 0\.2 25\)/)
  assert.match(light, /--color-down:\s*oklch\(52% 0\.16 150\)/)
})

test('导航品牌图标与右侧操作按钮保持同尺寸', () => {
  assert.match(app, /<BrandMark className="nav-brand-mark"\s*\/>/)
  assert.match(
    precision,
    /\.nav-brand-mark\s*{[^}]*width:\s*36px[^}]*height:\s*36px/s,
  )
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.nav-brand-mark\s*{[^}]*width:\s*44px[^}]*height:\s*44px/s,
  )
})
