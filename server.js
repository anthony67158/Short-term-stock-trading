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
import {
  alertTimerBody,
  adviceTimerBody,
  adviceWorkerBody,
  dailyReportTimerBody,
  dailyReportWorkerBody,
  formulaSelectionTimerBody,
  learningTimerBody,
  opportunityRadarTimerBody,
  portfolioAnalysisTimerBody,
  portfolioAnalysisWorkerBody,
  preCatalystTimerBody,
  reviewTimerBody,
  sectorForecastTimerBody,
  tailPickTimerBody,
  tailPickWorkerBody,
} from './api/_advice_timer.js';
import {
  RequestBodyError,
  readRequestBody,
  requestBodyLimitForPath,
} from './api/_http_body.js';
import {
  sendApiResponse,
  sendJsonResponse,
} from './api/_http_response.js';

const PORT = process.env.FC_SERVER_PORT || process.env.PORT || 9000;
const ROOT = process.cwd();
const API_DIR = path.join(ROOT, 'api');
const DIST_DIR = path.join(ROOT, 'dist');
const PROTECTED_SITE_HOST = 'www.tedixtf.cn';
const INVOKE_BODY_LIMIT = 256 * 1024;
const BODY_READ_TIMEOUT_MS = 15_000;
const ROBOTS_TAG = 'noindex, nofollow, noarchive, nosnippet, noimageindex';

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
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

function protectedSiteHost(req) {
  return req.headers['x-forwarded-host'] || req.headers.host || '';
}

function protectedSiteHeaders(res) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Robots-Tag', ROBOTS_TAG);
}

// 静态资源：命中文件则回传；未命中且非静态扩展名 → 回退 index.html（SPA 路由）
function serveStatic(_req, res, pathname) {
  if (!existsSync(DIST_DIR)) { res.statusCode = 404; res.end('dist not built'); return; }
  res.setHeader('X-Robots-Tag', ROBOTS_TAG);
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    res.statusCode = 400;
    res.end('bad path');
    return;
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  let file = path.resolve(DIST_DIR, rel);
  // 防目录穿越
  const relative = path.relative(DIST_DIR, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    // 有扩展名却找不到 → 404；否则按 SPA 路由回退 index.html
    if (path.extname(rel)) { res.statusCode = 404; res.end('not found'); return; }
    file = path.join(DIST_DIR, 'index.html');
    if (!existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
  }
  const ext = path.extname(file).toLowerCase();
  res.setHeader(
    'Content-Type',
    rel === 'manifest.json'
      ? 'application/manifest+json; charset=utf-8'
      : MIME[ext] || 'application/octet-stream',
  );
  res.setHeader('Content-Disposition', 'inline');
  // index.html 不缓存；带 hash 的 assets 长缓存（对齐原 vercel.json）
  if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  else if (rel.startsWith('assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  else if (rel === 'manifest.json' || rel === 'apple-touch-icon.png') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  } else if (
    rel.startsWith('app-icon-')
    || rel === 'apple-touch-icon-v2.png'
    || rel === 'apple-touch-icon-v7.png'
    || rel.startsWith('favicon-')
  ) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  createReadStream(file)
    .on('error', () => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end('read failed');
      }
    })
    .pipe(res);
}

function sendRequestFailure(req, res, error) {
  if (res.writableEnded) return;
  const requestError = error instanceof RequestBodyError;
  const statusCode = requestError ? error.statusCode : 500;
  if (statusCode === 408) {
    res.shouldKeepAlive = false;
    res.setHeader('Connection', 'close');
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    ok: false,
    error: requestError ? error.message : '服务内部错误',
  }));
  if (statusCode === 408) req.destroy();
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.statusCode = 400;
    res.end('bad request');
    return;
  }
  const pathname = url.pathname;

  // FC 事件源（Timer/InvokeFunction）固定 POST /invoke。仅接受部署时 CRON_KEY
  // 匹配的专用触发器，避免公开 HTTP 地址伪造定时调用消耗模型额度。
  if (pathname === '/invoke' && req.method === 'POST') {
    const raw = await readRequestBody(req, {
      maxBytes: INVOKE_BODY_LIMIT,
      timeoutMs: BODY_READ_TIMEOUT_MS,
    });
    let event = null;
    try { event = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    const adviceBody = adviceTimerBody(event, process.env.CRON_KEY)
      || adviceWorkerBody(event, process.env.CRON_KEY);
    const dailyReportBody = dailyReportTimerBody(
      event,
      process.env.CRON_KEY,
    ) || dailyReportWorkerBody(event, process.env.CRON_KEY);
    const opportunityRadarBody = opportunityRadarTimerBody(
      event,
      process.env.CRON_KEY,
    );
    const learningBody = learningTimerBody(
      event,
      process.env.CRON_KEY,
    );
    const preCatalystBody = preCatalystTimerBody(
      event,
      process.env.CRON_KEY,
    );
    const alertBody = alertTimerBody(event, process.env.CRON_KEY);
    const reviewBody = reviewTimerBody(event, process.env.CRON_KEY);
    const sectorForecastBody = sectorForecastTimerBody(
      event,
      process.env.CRON_KEY,
    );
    const tailPickBody = tailPickTimerBody(
      event,
      process.env.CRON_KEY,
    ) || tailPickWorkerBody(event, process.env.CRON_KEY);
    const formulaSelectionBody = formulaSelectionTimerBody(
      event,
      process.env.CRON_KEY,
    );
    const portfolioAnalysisBody = portfolioAnalysisWorkerBody(
      event,
      process.env.CRON_KEY,
    ) || portfolioAnalysisTimerBody(event, process.env.CRON_KEY);
    if (
      !adviceBody
      && !dailyReportBody
      && !opportunityRadarBody
      && !learningBody
      && !preCatalystBody
      && !alertBody
      && !reviewBody
      && !sectorForecastBody
      && !tailPickBody
      && !formulaSelectionBody
      && !portfolioAnalysisBody
    ) { res.statusCode = 403; res.end('forbidden'); return; }
    req.query = {};
    req.body = adviceBody
      || dailyReportBody
      || opportunityRadarBody
      || learningBody
      || preCatalystBody
      || alertBody
      || reviewBody
      || sectorForecastBody
      || tailPickBody
      || formulaSelectionBody
      || portfolioAnalysisBody;
    req.headers['x-cron-key'] = process.env.CRON_KEY;
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (payload) => sendApiResponse(req, res, payload);
    res.json = (obj) => sendJsonResponse(req, res, obj);
    try {
      const handlerName = adviceBody
        ? 'cron_advice'
        : dailyReportBody
          ? 'cron_daily_report'
          : opportunityRadarBody
            ? 'cron_opportunity_radar'
            : learningBody
              ? 'cron_learning'
            : preCatalystBody
              ? 'pre_catalyst'
              : alertBody
                ? 'cron_alert'
                : reviewBody
                  ? 'cron_review'
                  : sectorForecastBody
                    ? 'sector_forecast'
                    : tailPickBody
                      ? 'tail_pick'
                      : formulaSelectionBody
                        ? 'formula_selection'
                        : 'portfolio_analysis';
      await handlers[handlerName](req, res);
    } catch (e) {
      console.error('[fc] invoke handler failed', e?.code || e?.name || e?.message);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: '定时任务执行失败' }));
      }
    }
    return;
  }

  // 健康检查
  if (pathname === '/__health') { res.statusCode = 200; res.end('ok'); return; }

  const protectedHost = String(protectedSiteHost(req)).split(',')[0]
    .trim().toLowerCase().split(':')[0] === PROTECTED_SITE_HOST;
  if (protectedHost) {
    protectedSiteHeaders(res);
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0].trim().toLowerCase();
    if (forwardedProto === 'http') {
      res.statusCode = 308;
      res.setHeader('Location', `https://${PROTECTED_SITE_HOST}${req.url}`);
      res.end();
      return;
    }
  }

  // 非 /api/ → 静态前端
  if (!pathname.startsWith('/api/')) { serveStatic(req, res, pathname); return; }

  const name = pathname.slice(5);
  const handler = handlers[name];
  if (!handler) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'no such api: ' + name })); return; }

  // 适配 Vercel req/res
  req.query = Object.fromEntries(url.searchParams.entries());
  const raw = (req.method === 'POST' || req.method === 'PUT')
    ? await readRequestBody(req, {
        maxBytes: requestBodyLimitForPath(pathname),
        timeoutMs: BODY_READ_TIMEOUT_MS,
      })
    : '';
  try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }

  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (payload) => sendApiResponse(req, res, payload);
  res.json = (obj) => sendJsonResponse(req, res, obj);

  try {
    await handler(req, res);
  } catch (e) {
    console.error('[fc] api handler failed', name, e?.code || e?.name || e?.message);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: '接口执行失败' }));
    }
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[fc] request failed', error?.code || error?.name || error?.message);
    sendRequestFailure(req, res, error);
  });
});

server.listen(PORT, () => console.log(`[fc] server listening on ${PORT}`));
