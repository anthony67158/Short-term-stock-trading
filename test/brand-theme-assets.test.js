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
const legacyStyles = read('src/styles.css')
const stockDetail = read('src/components/StockDetail.jsx')

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
    '/apple-touch-icon-v2.png',
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

test('主题颜色取自品牌图标并保留A股红涨绿跌', () => {
  assert.match(tokens, /--brand-abyss:\s*#030b1b/i)
  assert.match(tokens, /--brand-midnight:\s*#071126/i)
  assert.match(tokens, /--brand-navy:\s*#0d1b36/i)
  assert.match(tokens, /--brand-steel-blue:\s*#364b6d/i)
  assert.match(tokens, /--brand-silver:\s*#9ea5b1/i)
  assert.match(tokens, /--brand-pearl:\s*#e4e5e8/i)
  assert.match(tokens, /--gradient-app:/)
  assert.match(tokens, /--gradient-nav:/)
  assert.match(tokens, /--gradient-primary:/)
  const light = tokens.match(/html\[data-theme="light"\]\s*{([\s\S]*?)\n}/)?.[1] || ''
  assert.match(light, /--color-paper:\s*#e8eff7/i)
  assert.match(light, /--color-paper-2:\s*#f8fafd/i)
  assert.match(light, /--color-accent:\s*#1f5f9f/i)
  assert.match(light, /--color-accent-ink:\s*var\(--brand-ice\)/)
  assert.match(light, /--color-up:\s*oklch\(57% 0\.2 25\)/)
  assert.match(light, /--color-down:\s*oklch\(52% 0\.16 150\)/)
  assert.match(
    precision,
    /body\s*{[^}]*background-image:\s*var\(--gradient-app\)/s,
  )
  assert.match(
    precision,
    /\.nav\s*{[^}]*background(?:-image)?:\s*var\(--gradient-nav-theme\)/s,
  )
  assert.match(
    precision,
    /\.portfolio-overview-zone\s*{[^}]*background-image:\s*var\(--gradient-surface\)/s,
  )
  assert.match(
    precision,
    /\.plan-section-sticky,[\s\S]*?\.plan-section-hold-sticky\s*{[^}]*border:\s*0[^}]*border-radius:\s*0[^}]*background-color:\s*transparent[^}]*background-image:\s*none/s,
  )
  assert.match(
    precision,
    /\.nav button\.icon-btn,[\s\S]*?\.nav button\.icon-btn\.nav-undo:disabled\s*{[^}]*background:\s*var\(--color-nav-control\)/s,
  )
  assert.match(
    light,
    /--gradient-nav-theme:[\s\S]*?var\(--brand-ice\)[\s\S]*?#edf3f8[\s\S]*?#dce7f2/,
  )
  assert.match(
    light,
    /--color-nav-active:\s*var\(--brand-ice\)[\s\S]*?--color-nav-active-ink:\s*var\(--brand-midnight\)/s,
  )
  assert.doesNotMatch(
    legacyStyles,
    /#(?:7c6bf5|8b7cf6|5b8def|9c8bff)|rgba\(\s*(?:124\s*,\s*107\s*,\s*245|91\s*,\s*141\s*,\s*239)\s*,/i,
  )
  assert.match(stockDetail, /const STOCK_CHART_COLORS = Object\.freeze/)
  assert.match(stockDetail, /price:\s*'#75b7ff'/i)
  assert.match(stockDetail, /price:\s*'#1f5f9f'/i)
  assert.match(stockDetail, /ma10:\s*'#5f9fe3'/i)
  assert.match(stockDetail, /ma10:\s*'#2e72b8'/i)
  assert.doesNotMatch(
    stockDetail,
    /#(?:7c6bf5|8b7cf6|5b8def|9c8bff)|rgba\(\s*(?:124\s*,\s*107\s*,\s*245|91\s*,\s*141\s*,\s*239)\s*,/i,
  )
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
