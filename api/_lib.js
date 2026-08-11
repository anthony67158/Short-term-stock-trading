// 共享工具：东财接口多镜像域名容错请求
const EM_HOSTS = [
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://48.push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
];

const EM_HIS_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://82.push2his.eastmoney.com',
];

async function fetchJson(url, { timeout = 7000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://data.eastmoney.com/',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 并发竞速多个镜像 host，最快成功的返回，避免串行累积超时
export async function emGet(pathAndQuery, { his = false } = {}) {
  const hosts = his ? EM_HIS_HOSTS : EM_HOSTS;
  const attempts = hosts.map((host) => fetchJson(host + pathAndQuery));
  try {
    return await Promise.any(attempts);
  } catch (e) {
    // Promise.any 的 AggregateError
    throw new Error('all hosts failed');
  }
}

// 批量分页场景使用单镜像并在失败时顺序回退，避免每一页都并发竞速全部镜像。
export async function emGetOne(pathAndQuery, { his = false, hostIndex = 0, maxAttempts } = {}) {
  const hosts = his ? EM_HIS_HOSTS : EM_HOSTS;
  const start = Math.abs(Number(hostIndex) || 0) % hosts.length;
  const attempts = Math.max(1, Math.min(hosts.length, Number(maxAttempts) || hosts.length));
  for (let offset = 0; offset < attempts; offset++) {
    const host = hosts[(start + offset) % hosts.length];
    try { return await fetchJson(host + pathAndQuery); } catch { /* 换下一镜像 */ }
  }
  throw new Error('all hosts failed');
}

// ---- 统一 CORS / 预检契约 ----
// 前端(Vercel 域)直连 FC 后端属跨域，JSON POST 会先发 OPTIONS 预检；
// 所有 handler 统一走这里，避免各写一份、漏设 Allow-Methods/Headers 导致预检失败。
export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-internal, X-Account-Nick, X-Account-Password',
  );
}

// OPTIONS 预检统一应答：命中则回 204 并返回 true，调用方 `if (preflight(req,res)) return;`
export function preflight(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res);
    res.status(204).end();
    return true;
  }
  return false;
}

export function sendJson(res, data, { cache = 30 } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  applyCors(res);
  res.setHeader(
    'Cache-Control',
    `public, s-maxage=${cache}, stale-while-revalidate=${cache * 4}`
  );
  res.status(200).send(JSON.stringify(data));
}

export function sendError(res, err) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  applyCors(res);
  res.status(200).send(
    JSON.stringify({ ok: false, error: String(err && err.message || err) })
  );
}

// 安全取数：null/'-' 转 0
export function num(v) {
  if (v === '-' || v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
