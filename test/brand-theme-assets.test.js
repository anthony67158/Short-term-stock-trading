import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
  }
}

const index = read('index.html')
const manifest = JSON.parse(read('public/manifest.json'))
const tokens = read('tokens.css')
const app = read('src/App.jsx')
const authGate = read('src/components/AuthGate.jsx')
const themeStore = read('src/themeStore.js')
const precision = read('src/styles/precision.css')
const appIcon = read('public/app-icon.svg')
const maskableIcon = read('public/app-icon-maskable.svg')

test('品牌图标按亮暗主题切换且统一使用黑底银白高光', () => {
  assert.match(index, /href="\/brand-light\.svg"[^>]*prefers-color-scheme:\s*light/)
  assert.match(index, /href="\/brand-dark\.svg"[^>]*prefers-color-scheme:\s*dark/)
  assert.match(index, /id="app-favicon"/)
  assert.match(themeStore, /theme === 'light' \? '\/brand-light\.svg' : '\/brand-dark\.svg'/)
  assert.match(index, /rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/)
  assert.deepEqual(pngSize('public/apple-touch-icon.png'), {
    width: 180,
    height: 180,
  })
  const lightBrand = read('public/brand-light.svg')
  const darkBrand = read('public/brand-dark.svg')
  assert.match(lightBrand, /id="brand-bg-light"/)
  assert.match(lightBrand, /id="brand-mark-light"/)
  assert.match(lightBrand, /id="brand-shadow-light"/)
  assert.match(lightBrand, /scale\(1\.22 1\.7\)/)
  assert.doesNotMatch(lightBrand, /#0874D8|#42A7FF|#1389ED/)
  assert.match(darkBrand, /id="brand-bg-dark"/)
  assert.match(darkBrand, /id="brand-mark-dark"/)
  assert.match(darkBrand, /id="brand-shadow-dark"/)
  assert.match(darkBrand, /scale\(1\.22 1\.7\)/)
  assert.doesNotMatch(darkBrand, /#0874D8|#42A7FF|#1389ED/)
})

test('PWA主图标使用黑白高光方形源图并为maskable保留安全区', () => {
  assert.deepEqual(pngSize('public/icon-192.png'), {
    width: 192,
    height: 192,
  })
  assert.deepEqual(pngSize('public/icon-512.png'), {
    width: 512,
    height: 512,
  })
  assert.deepEqual(pngSize('public/icon-maskable-512.png'), {
    width: 512,
    height: 512,
  })
  assert.ok(manifest.icons.some((icon) =>
    icon.src === '/icon-192.png' && icon.purpose === 'any'
  ))
  assert.ok(manifest.icons.some((icon) =>
    icon.src === '/icon-maskable-512.png' && icon.purpose === 'maskable'
  ))
  assert.ok(manifest.icons.some((icon) =>
    icon.src === '/app-icon.svg' && icon.purpose === 'any'
  ))
  assert.match(appIcon, /id="background"/)
  assert.match(appIcon, /id="glow"/)
  assert.match(appIcon, /id="sheen"/)
  assert.match(appIcon, /id="mark-shadow"/)
  assert.match(appIcon, /scale\(1\.22 1\.7\)/)
  assert.doesNotMatch(appIcon, /#0874D8|#42A7FF|#1389ED|#0052B5/)
  assert.match(maskableIcon, /scale\(1\.02 1\.48\)/)
  assert.doesNotMatch(maskableIcon, /#0874D8|#42A7FF|#1389ED|#0052B5/)
})

test('导航、恢复登录和登录门户统一使用主题品牌标记', () => {
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
