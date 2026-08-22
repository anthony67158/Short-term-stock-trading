import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(
  new URL('../src/App.jsx', import.meta.url),
  'utf8',
)
const siteAccess = readFileSync(
  new URL('../public/site-access.html', import.meta.url),
  'utf8',
)
const index = readFileSync(
  new URL('../index.html', import.meta.url),
  'utf8',
)
const precision = readFileSync(
  new URL('../src/styles/precision.css', import.meta.url),
  'utf8',
)
const robots = readFileSync(
  new URL('../public/robots.txt', import.meta.url),
  'utf8',
)
const server = readFileSync(
  new URL('../server.js', import.meta.url),
  'utf8',
)
const serverless = readFileSync(
  new URL('../s.yaml', import.meta.url),
  'utf8',
)
const vercel = readFileSync(
  new URL('../vercel.json', import.meta.url),
  'utf8',
)

test('登录页与工作台统一展示工信与公安备案链接', () => {
  assert.match(app, /const ICP_NUMBER = '沪ICP备2026040243号-1'/)
  assert.match(app, /const PUBLIC_SECURITY_NUMBER = '沪公网安备31011002008126号'/)
  assert.match(app, /href="https:\/\/beian\.miit\.gov\.cn\/"/)
  assert.match(app, /href="https:\/\/beian\.mps\.gov\.cn\//)
  assert.match(app, /className="footer-icp"/)
  assert.match(app, /className="footer-public-security"/)
  assert.equal((app.match(/<RegulatoryFooter/g) || []).length, 2)
})

test('设备授权页同样展示工信与公安备案链接', () => {
  assert.match(siteAccess, /class="regulatory-footer"/)
  assert.match(siteAccess, /沪ICP备2026040243号-1/)
  assert.match(siteAccess, /沪公网安备31011002008126号/)
  assert.match(siteAccess, /https:\/\/beian\.miit\.gov\.cn\//)
  assert.match(
    siteAccess,
    /https:\/\/beian\.mps\.gov\.cn\/#\/query\/webSearch\?code=31011002008126/,
  )
})

test('移动端保留两类备案号并隐藏冗长免责声明', () => {
  assert.match(precision, /\.footer-icp\s*{/)
  assert.match(precision, /\.footer-public-security\s*{/)
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.footer-disclaimer\s*{[^}]*display:\s*none/s,
  )
})

test('所有公开入口均要求搜索引擎不收录', () => {
  assert.match(
    index,
    /<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex" \/>/,
  )
  assert.match(robots, /User-agent:\s*\*\s*\nDisallow:\s*\/\s*$/i)
  assert.match(
    server,
    /const ROBOTS_TAG = 'noindex, nofollow, noarchive, nosnippet, noimageindex'/,
  )
  assert.match(
    server,
    /res\.setHeader\('X-Robots-Tag', ROBOTS_TAG\)/,
  )
  assert.match(server, /'\.txt': 'text\/plain; charset=utf-8'/)
  assert.match(
    vercel,
    /"source": "\/\(\.\*\)"[\s\S]*?"key": "X-Robots-Tag"[\s\S]*?"value": "noindex, nofollow, noarchive, nosnippet, noimageindex"/,
  )
})

test('FC 部署固化备案域名、证书与 TLS 1.2 以上协议', () => {
  assert.match(serverless, /domainName:\s*www\.tedixtf\.cn/)
  assert.match(serverless, /protocol:\s*HTTP,HTTPS/)
  assert.match(serverless, /certId:\s*"26673093"/)
  assert.match(serverless, /minVersion:\s*TLSv1\.2/)
  assert.match(serverless, /maxVersion:\s*TLSv1\.3/)
})
