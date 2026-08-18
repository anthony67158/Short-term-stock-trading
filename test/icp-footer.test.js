import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(
  new URL('../src/App.jsx', import.meta.url),
  'utf8',
)
const precision = readFileSync(
  new URL('../src/styles/precision.css', import.meta.url),
  'utf8',
)
const serverless = readFileSync(
  new URL('../s.yaml', import.meta.url),
  'utf8',
)

test('登录页与工作台统一展示可核验的 ICP 备案链接', () => {
  assert.match(app, /const ICP_NUMBER = '沪ICP备2026040243号-1'/)
  assert.match(app, /href="https:\/\/beian\.miit\.gov\.cn\/"/)
  assert.match(app, /className="footer-icp"/)
  assert.equal((app.match(/<RegulatoryFooter/g) || []).length, 2)
})

test('移动端保留备案号并隐藏冗长免责声明', () => {
  assert.match(precision, /\.footer-icp\s*{/)
  assert.match(
    precision,
    /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.footer-disclaimer\s*{[^}]*display:\s*none/s,
  )
})

test('FC 部署固化备案域名、证书与 TLS 1.2 以上协议', () => {
  assert.match(serverless, /domainName:\s*www\.tedixtf\.cn/)
  assert.match(serverless, /protocol:\s*HTTP,HTTPS/)
  assert.match(serverless, /certId:\s*"26673093"/)
  assert.match(serverless, /minVersion:\s*TLSv1\.2/)
  assert.match(serverless, /maxVersion:\s*TLSv1\.3/)
})
