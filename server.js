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
  portfolioAnalysisTimerBody,
  portfolioAnalysisWorkerBody,
  reviewTimerBody,
  sectorForecastTimerBody,
  v2AccuracyTimerBody,
} from './api/_advice_timer.js';
import {
  PROTECTED_SITE_HOST,
  SITE_ACCESS_COOKIE,
  SITE_ACCESS_MAX_AGE_SECONDS,
  SITE_ACCESS_PATH,
  cookieValue,
  createSiteAccessLimiter,
  createSiteAccessToken,
  isPublicSiteAsset,
  isProtectedSiteHost,
  siteAccessCookie,
  verifySiteAccessCode,
  verifySiteAccessToken,
} from './api/_site_access.js';
import {
  RequestBodyError,
  readRequestBody,
  requestBodyLimitForPath,
} from './api/_http_body.js';

const PORT = process.env.FC_SERVER_PORT || process.env.PORT || 9000;
const ROOT = process.cwd();
const API_DIR = path.join(ROOT, 'api');
const DIST_DIR = path.join(ROOT, 'dist');
const siteAccessLimiter = createSiteAccessLimiter();
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

function protectedSiteSecret() {
  return process.env.SITE_ACCESS_SECRET || process.env.CRON_KEY || '';
}

function protectedSiteHeaders(res) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Robots-Tag', ROBOTS_TAG);
}

function siteAccessAuthorized(req) {
  return verifySiteAccessToken(
    cookieValue(req.headers.cookie, SITE_ACCESS_COOKIE),
    { secret: protectedSiteSecret() },
  );
}

function clientAddress(req) {
  return String(
    req.headers['x-forwarded-for']
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown',
  ).split(',')[0].trim().slice(0, 120);
}

function sendSiteAccessJson(res, statusCode, body) {
  protectedSiteHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readSiteAccessBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

async function handleSiteAccess(req, res) {
  if (req.method === 'OPTIONS') {
    protectedSiteHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === 'GET') {
    sendSiteAccessJson(res, 200, {
      ok: true,
      authorized: siteAccessAuthorized(req),
    });
    return;
  }
  if (req.method !== 'POST') {
    sendSiteAccessJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  const origin = String(req.headers.origin || '');
  if (origin && origin !== `https://${PROTECTED_SITE_HOST}`) {
    sendSiteAccessJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }

  const address = clientAddress(req);
  if (!siteAccessLimiter.canAttempt(address)) {
    res.setHeader(
      'Retry-After',
      String(siteAccessLimiter.retryAfterSeconds(address)),
    );
    sendSiteAccessJson(res, 429, { ok: false, error: 'too many attempts' });
    return;
  }

  const secret = protectedSiteSecret();
  const expectedDigest = process.env.SITE_ACCESS_CODE_HMAC || '';
  if (!secret || !expectedDigest) {
    sendSiteAccessJson(res, 503, { ok: false, error: 'access unavailable' });
    return;
  }

  let body;
  try {
    body = await readSiteAccessBody(req);
  } catch {
    sendSiteAccessJson(res, 400, { ok: false, error: 'invalid request' });
    return;
  }

  if (!verifySiteAccessCode(body?.code, { expectedDigest, secret })) {
    siteAccessLimiter.recordFailure(address);
    sendSiteAccessJson(res, 401, { ok: false, error: 'invalid access code' });
    return;
  }

  siteAccessLimiter.reset(address);
  const token = createSiteAccessToken({
    secret,
    maxAgeSeconds: SITE_ACCESS_MAX_AGE_SECONDS,
  });
  res.setHeader('Set-Cookie', siteAccessCookie(token));
  sendSiteAccessJson(res, 200, { ok: true, authorized: true });
}

function serveSiteAccess(req, res) {
  const file = path.join(DIST_DIR, 'site-access.html');
  if (!existsSync(file)) {
    sendSiteAccessJson(res, 503, { ok: false, error: 'access page unavailable' });
    return;
  }
  protectedSiteHeaders(res);
  res.statusCode = 401;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; "
      + "script-src 'unsafe-inline'; connect-src 'self'; "
      + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  if (req.method === 'HEAD') {
    res.end();
    return;
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
    const v2Body = v2AccuracyTimerBody(event, process.env.CRON_KEY);
    const alertBody = alertTimerBody(event, process.env.CRON_KEY);
    const reviewBody = reviewTimerBody(event, process.env.CRON_KEY);
    const sectorForecastBody = sectorForecastTimerBody(
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
      && !v2Body
      && !alertBody
      && !reviewBody
      && !sectorForecastBody
      && !portfolioAnalysisBody
    ) { res.statusCode = 403; res.end('forbidden'); return; }
    req.query = {};
    req.body = adviceBody
      || dailyReportBody
      || v2Body
      || alertBody
      || reviewBody
      || sectorForecastBody
      || portfolioAnalysisBody;
    req.headers['x-cron-key'] = process.env.CRON_KEY;
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (payload) => { res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); return res; };
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
    try {
      const handlerName = adviceBody
        ? 'cron_advice'
        : dailyReportBody
          ? 'cron_daily_report'
          : v2Body
            ? 'cron_v2_accuracy'
            : alertBody
              ? 'cron_alert'
              : reviewBody
                ? 'cron_review'
                : sectorForecastBody
                  ? 'sector_forecast'
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

  const protectedHost = isProtectedSiteHost(protectedSiteHost(req));
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
    if (pathname === SITE_ACCESS_PATH) {
      await handleSiteAccess(req, res);
      return;
    }
    if (!siteAccessAuthorized(req)) {
      if (
        ['GET', 'HEAD'].includes(req.method)
        && isPublicSiteAsset(pathname)
      ) {
        serveStatic(req, res, pathname);
      } else if (
        !pathname.startsWith('/api/')
        && (req.method === 'GET' || req.method === 'HEAD')
      ) {
        serveSiteAccess(req, res);
      } else {
        sendSiteAccessJson(res, 401, { ok: false, error: 'site access required' });
      }
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
  res.send = (payload) => { res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); return res; };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };

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
