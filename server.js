// ============ 阿里云函数计算 FC 3.0 自定义运行时入口 ============
// 一个进程承载全部：/api/* → api 目录下的 12 个 handler（含 SSE 流式），
// 其它路径 → 托管 dist/ 静态前端（SPA，找不到文件回退 index.html）。
//
// 部署形态：FC 3.0「Web 函数 / 自定义运行时(Node.js)」，启动命令 `node server.js`。
// FC 会注入监听端口环境变量 FC_SERVER_PORT（默认 9000）。
//
// 本地也可用它自测：PORT=3000 node server.js
//
// 说明：Vercel 函数签名 export default (req,res)=>{}，req/res 近似 Node 原生 + 少量便捷方法，
// 这里做最小兼容适配（req.query / req.body / res.status().send() 等），与 dev-server.js 同源。

import http from 'node:http';
import { readdirSync, existsSync, statSync, createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { adviceTimerBody, v2AccuracyTimerBody } from './api/_advice_timer.js';

const PORT = process.env.FC_SERVER_PORT || process.env.PORT || 9000;
const ROOT = process.cwd();
const API_DIR = path.join(ROOT, 'api');
const DIST_DIR = path.join(ROOT, 'dist');

// 预加载所有非下划线开头的函数模块
const handlers = {};
for (const f of readdirSync(API_DIR)) {
  if (!f.endsWith('.js') || f.startsWith('_')) continue;
  const name = f.replace(/\.js$/, '');
  const mod = await import(pathToFileURL(path.join(API_DIR, f)).href);
  handlers[name] = mod.default;
}
console.log('[fc] 已加载 API 函数:', Object.keys(handlers).join(', '));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

// 静态资源：命中文件则回传；未命中且非静态扩展名 → 回退 index.html（SPA 路由）
function serveStatic(req, res, pathname) {
  if (!existsSync(DIST_DIR)) { res.statusCode = 404; res.end('dist not built'); return; }
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  let file = path.join(DIST_DIR, rel);
  // 防目录穿越
  if (!file.startsWith(DIST_DIR)) { res.statusCode = 403; res.end('forbidden'); return; }
  if (!existsSync(file) || !statSync(file).isFile()) {
    // 有扩展名却找不到 → 404；否则按 SPA 路由回退 index.html
    if (path.extname(rel)) { res.statusCode = 404; res.end('not found'); return; }
    file = path.join(DIST_DIR, 'index.html');
    if (!existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
  }
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  // index.html 不缓存；带 hash 的 assets 长缓存（对齐原 vercel.json）
  if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  else if (rel.startsWith('assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // FC 事件源（Timer/InvokeFunction）固定 POST /invoke。仅接受部署时 CRON_KEY
  // 匹配的 advice-resume-timer，避免公开 HTTP 地址伪造定时调用消耗模型额度。
  if (pathname === '/invoke' && req.method === 'POST') {
    const raw = await parseBody(req);
    let event = null;
    try { event = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    const adviceBody = adviceTimerBody(event, process.env.CRON_KEY);
    const v2Body = v2AccuracyTimerBody(event, process.env.CRON_KEY);
    if (!adviceBody && !v2Body) { res.statusCode = 403; res.end('forbidden'); return; }
    req.query = {};
    req.body = adviceBody || v2Body;
    req.headers['x-cron-key'] = process.env.CRON_KEY;
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (payload) => { res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); return res; };
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
    try {
      await handlers[adviceBody ? 'cron_advice' : 'cron_v2_accuracy'](req, res);
    } catch (e) {
      if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
    }
    return;
  }

  // 健康检查
  if (pathname === '/__health') { res.statusCode = 200; res.end('ok'); return; }

  // 非 /api/ → 静态前端
  if (!pathname.startsWith('/api/')) { serveStatic(req, res, pathname); return; }

  const name = pathname.slice(5);
  const handler = handlers[name];
  if (!handler) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'no such api: ' + name })); return; }

  // 适配 Vercel req/res
  req.query = Object.fromEntries(url.searchParams.entries());
  const raw = (req.method === 'POST' || req.method === 'PUT') ? await parseBody(req) : '';
  try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }

  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (payload) => { res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); return res; };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };

  try {
    await handler(req, res);
  } catch (e) {
    if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
  }
});

server.listen(PORT, () => console.log(`[fc] server listening on ${PORT}`));
