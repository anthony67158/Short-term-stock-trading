// 本地开发 API 服务器：把 api/*.js（Vercel serverless 函数）挂载为本地 HTTP 路由
// 仅本地开发用。生产环境由 Vercel 直接托管 api/ 目录，无需此文件。
//
// 用法：
//   1) npm install
//   2) node dev-server.js        （默认端口 3000）
//   3) 另开一个终端：npm run dev  （Vite 前端，已配置把 /api 代理到 3000）
//
// 说明：Vercel 函数签名为 export default (req, res) => {}，其中 req/res 近似 Node 原生 + 少量便捷方法，
// 这里做了最小兼容适配（req.query / req.body / res.status().send() 等）。

import http from 'node:http'
import { readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import {
  RequestBodyError,
  readRequestBody,
} from './api/_http_body.js'

const PORT = process.env.PORT || 3000
const API_DIR = path.join(process.cwd(), 'api')
const API_BODY_LIMIT = 8 * 1024 * 1024
const BODY_READ_TIMEOUT_MS = 15_000

// 预加载所有非下划线开头的函数模块
const handlers = {}
for (const f of readdirSync(API_DIR)) {
  if (!f.endsWith('.js') || f.startsWith('_')) continue
  const name = f.replace(/\.js$/, '')
  const mod = await import(pathToFileURL(path.join(API_DIR, f)).href)
  handlers[name] = mod.default
}
console.log('[dev-api] 已加载函数:', Object.keys(handlers).join(', '))

async function handleRequest(req, res) {
  let url
  try {
    url = new URL(req.url, `http://localhost:${PORT}`)
  } catch {
    res.statusCode = 400
    res.end('Bad request')
    return
  }
  if (!url.pathname.startsWith('/api/')) { res.statusCode = 404; res.end('Not found'); return }
  const name = url.pathname.slice(5)
  const handler = handlers[name]
  if (!handler) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'no such api: ' + name })); return }

  // 适配 Vercel req/res
  req.query = Object.fromEntries(url.searchParams.entries())
  const raw = (req.method === 'POST' || req.method === 'PUT')
    ? await readRequestBody(req, {
        maxBytes: API_BODY_LIMIT,
        timeoutMs: BODY_READ_TIMEOUT_MS,
      })
    : ''
  try { req.body = raw ? JSON.parse(raw) : {} } catch { req.body = raw }

  res.status = (code) => { res.statusCode = code; return res }
  res.send = (payload) => { res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); return res }
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res }

  try {
    await handler(req, res)
  } catch (e) {
    console.error('[dev-api] handler failed', name, e?.code || e?.name || e?.message)
    if (!res.writableEnded) {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: '接口执行失败' }))
    }
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    if (res.writableEnded) return
    console.error('[dev-api] request failed', error?.code || error?.name || error?.message)
    res.statusCode = error instanceof RequestBodyError
      ? error.statusCode
      : 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof RequestBodyError
        ? error.message
        : '服务内部错误',
    }))
  })
})

server.listen(PORT, () => console.log(`[dev-api] 本地 API 运行在 http://localhost:${PORT}`))
