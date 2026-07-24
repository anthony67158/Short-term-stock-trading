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

export function sendJson(res, data, { cache = 30 } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Cache-Control',
    `public, s-maxage=${cache}, stale-while-revalidate=${cache * 4}`
  );
  res.status(200).send(JSON.stringify(data));
}

export function sendError(res, err) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
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
