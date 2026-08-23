// ============ 海外市场 / 商品 / 宏观 数据抓取（Node 直调开源原始 HTTP，无需 Python）============
// 数据源：腾讯行情(qt.gtimg.cn，港美股/指数)、东财(push2，A股指数/商品期货)、东财资讯搜索(新闻)。
// 全部为公开免费接口；海外/商品多为昨收或延迟，调用方需诚实标注时效。

// 腾讯行情批量：返回 v_xxx="...~..."; 字段 [1]=名称 [3]=现价 [4]=昨收 [5]=今开 [32]=涨跌幅%
async function tencentQuote(codes) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(`https://qt.gtimg.cn/q=${codes.join(',')}`, {
      signal: ctrl.signal, headers: { Referer: 'https://gu.qq.com/' },
    });
    clearTimeout(t);
    const buf = await r.arrayBuffer();
    // 腾讯返回 GBK，用 TextDecoder 解码
    const txt = new TextDecoder('gbk').decode(buf);
    const out = {};
    txt.split(';').forEach((line) => {
      const m = line.match(/v_([^=]+)="([^"]*)"/);
      if (!m) return;
      const key = m[1].trim();
      const p = m[2].split('~');
      if (p.length < 5) return;
      const price = Number(p[3]); const prev = Number(p[4]);
      let pct = p[32] != null ? Number(p[32]) : (prev ? +(((price - prev) / prev) * 100).toFixed(2) : null);
      out[key] = { name: p[1], price, prevClose: prev, pct: isNaN(pct) ? null : pct };
    });
    return out;
  } catch { return {}; }
}

// 海外指数 + 商品（腾讯代码）
const OVERSEAS_MAP = [
  { key: 'hkHSI', code: 'hkHSI', label: '恒生指数' },
  { key: 'hkHSTECH', code: 'hkHSTECH', label: '恒生科技' },
  { key: 'usDJI', code: 'usDJI', label: '道琼斯' },
  { key: 'usIXIC', code: 'usIXIC', label: '纳斯达克' },
  { key: 'usINX', code: 'usINX', label: '标普500' },
];
// 商品：伦敦金/美原油(腾讯国际期货代码)
const COMMODITY_MAP = [
  { key: 'hf_XAU', code: 'hf_XAU', label: '伦敦金(现货)' },
  { key: 'hf_CL', code: 'hf_CL', label: '美原油(WTI)' },
  { key: 'hf_GC', code: 'hf_GC', label: 'COMEX黄金' },
];

export async function fetchOverseas() {
  const codes = [...OVERSEAS_MAP, ...COMMODITY_MAP].map((x) => x.code);
  const q = await tencentQuote(codes);
  const pick = (map) => map.map((m) => {
    const d = q[m.code];
    return d ? { label: m.label, price: d.price, pct: d.pct } : { label: m.label, price: null, pct: null };
  }).filter((x) => x.price != null);
  return { indices: pick(OVERSEAS_MAP), commodities: pick(COMMODITY_MAP) };
}

// A股三大指数（东财，实时/最近收盘）
export async function fetchAIndices(emGet, num) {
  try {
    const j = await emGet(`/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.000001,0.399001,0.399006&fields=f12,f14,f2,f3`);
    const arr = (j && j.data && j.data.diff) || [];
    return arr.map((d) => ({ name: d.f14, price: num(d.f2), pct: num(d.f3) }));
  } catch { return []; }
}

function cleanNewsText(value, limit = 160) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function newsDate(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 1000000000) {
    try { return new Date(Number(value) * 1000).toISOString().slice(0, 10); } catch { return ''; }
  }
  return String(value || '').slice(0, 10);
}

function newsTimestamp(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 1000000000) {
    try { return new Date(Number(value) * 1000).toISOString(); } catch { return ''; }
  }
  return cleanNewsText(value, 32);
}

function newsKey(title) {
  return cleanNewsText(title, 200)
    .toLowerCase()
    .replace(/[\s，。、“”‘’：:；;！!？?（）()《》【】\-_]/g, '')
    .slice(0, 80);
}

function normalizedNews(item) {
  const title = cleanNewsText(item?.title || item?.summary || item?.content);
  if (!title) return null;
  const summary = cleanNewsText(item?.summary || '', 180);
  const timestamp = newsTimestamp(item?.publishedAt || item?.date);
  return {
    title,
    date: newsDate(item?.date),
    ...(timestamp ? { publishedAt: timestamp } : {}),
    url: /^https?:\/\//i.test(String(item?.url || '')) ? String(item.url) : '',
    src: cleanNewsText(item?.src || '财经资讯', 30),
    kind: String(item?.kind || 'media'),
    ...(summary && summary !== title ? { summary } : {}),
  };
}

// 各来源按轮次取一条，避免单一媒体占满结果；同标题只保留一次。
export function mergeNewsItems(sourceGroups, size = 8) {
  const groups = (Array.isArray(sourceGroups) ? sourceGroups : [])
    .map((group) => Array.isArray(group) ? group : [])
    .filter((group) => group.length);
  const out = [];
  const seen = new Set();
  let offset = 0;
  while (out.length < size && groups.some((group) => offset < group.length)) {
    for (const group of groups) {
      const item = normalizedNews(group[offset]);
      if (!item) continue;
      const key = newsKey(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= size) break;
    }
    offset++;
  }
  return out;
}

export async function collectNewsSources(tasks, size = 8) {
  const settled = await Promise.allSettled(Array.isArray(tasks) ? tasks : []);
  return mergeNewsItems(
    settled.map((result) => result.status === 'fulfilled' ? result.value : []),
    size,
  );
}

async function fetchJson(url, {
  fetchImpl = fetch,
  timeoutMs = 6000,
  headers = {},
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// 定向新闻检索主源：东方财富资讯搜索。
export async function fetchEastmoneyNews(keyword, size = 5, {
  fetchImpl = fetch,
} = {}) {
  try {
    const param = encodeURIComponent(JSON.stringify({
      uid: '', keyword, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web',
      param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: size } },
    }));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetchImpl(`https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=${param}`, {
      signal: ctrl.signal, headers: { Referer: 'https://so.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(t);
    if (!r.ok) return [];
    const txt = await r.text();
    const clean = txt.replace(/^x\(/, '').replace(/\);?$/, '');
    const nj = JSON.parse(clean);
    const arr = (nj.result && nj.result.cmsArticleWebOld) || [];
    return arr.map((a) => ({
      title: a.title,
      summary: a.content,
      date: a.date,
      url: a.url || '',
      src: '东方财富',
      kind: 'media',
    }))
      .filter((x) => x.title).slice(0, size);
  } catch { return []; }
}

// 华尔街见闻关键词检索：与东财独立，补行业、公司与海外事件。
export async function fetchWallstreetSearch(keyword, size = 5, {
  fetchImpl = fetch,
} = {}) {
  if (!String(keyword || '').trim()) return [];
  try {
    const url = 'https://api-one.wallstcn.com/apiv1/search/article'
      + `?query=${encodeURIComponent(String(keyword).trim())}`
      + `&limit=${Math.max(1, Math.min(20, Number(size) || 5))}`;
    const json = await fetchJson(url, { fetchImpl, headers: { Referer: 'https://wallstreetcn.com/' } });
    const items = Array.isArray(json?.data)
      ? json.data
      : (json?.data?.items || []);
    return items.map((item) => normalizedNews({
      title: item.title || item.content_short,
      summary: item.content_short || item.subtitle || item.content,
      date: item.display_time,
      url: item.uri || item.source_uri || '',
      src: '华尔街见闻',
      kind: 'media',
    })).filter(Boolean).slice(0, size);
  } catch { return []; }
}

// 华尔街见闻全球实时流：直接补充宏观、政策、商品与海外突发。
export async function fetchWallstreetLive(size = 12, {
  fetchImpl = fetch,
} = {}) {
  try {
    const limit = Math.max(1, Math.min(50, Number(size) || 12));
    const json = await fetchJson(
      `https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&client=pc&limit=${limit}`,
      { fetchImpl, headers: { Referer: 'https://wallstreetcn.com/live' } },
    );
    return (json?.data?.items || []).map((item) => normalizedNews({
      title: item.title || item.content_text || item.content,
      summary: item.title ? (item.content_text || item.content) : '',
      date: item.display_time,
      url: item.uri || '',
      src: '华尔街见闻',
      kind: 'flash',
    })).filter(Boolean).slice(0, size);
  } catch { return []; }
}

// 东方财富公司公告：公司级硬信息，优先用于识别减持、问询、立案、业绩和重大合同。
export async function fetchStockAnnouncements(code, size = 6, {
  fetchImpl = fetch,
} = {}) {
  code = String(code || '').trim();
  if (!/^\d{6}$/.test(code)) return [];
  try {
    const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann'
      + `?sr=-1&page_size=${Math.max(1, Math.min(20, Number(size) || 6))}`
      + `&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
    const json = await fetchJson(url, {
      fetchImpl,
      headers: { Referer: `https://data.eastmoney.com/notices/stock/${code}.html` },
    });
    return (json?.data?.list || []).map((item) => normalizedNews({
      title: item.title,
      date: item.notice_date || item.display_time,
      url: item.art_code
        ? `https://data.eastmoney.com/notices/detail/${code}/${item.art_code}.html`
        : '',
      src: '公司公告',
      kind: 'announcement',
    })).filter(Boolean).slice(0, size);
  } catch { return []; }
}

// 东方财富机构研报：明确标记为观点，不与公司公告或事实新闻混淆。
export async function fetchStockResearch(code, size = 3, {
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  code = String(code || '').trim();
  if (!/^\d{6}$/.test(code)) return [];
  try {
    const end = new Date(now);
    const begin = new Date(now);
    begin.setUTCDate(begin.getUTCDate() - 120);
    const day = (date) => date.toISOString().slice(0, 10);
    const params = new URLSearchParams({
      pageSize: String(Math.max(1, Math.min(10, Number(size) || 3))),
      pageNo: '1',
      stock: code,
      industryCode: '*',
      rating: '*',
      ratingChange: '*',
      beginTime: day(begin),
      endTime: day(end),
      qType: '0',
    });
    const json = await fetchJson(
      `https://reportapi.eastmoney.com/report/list?${params}`,
      { fetchImpl, headers: { Referer: `https://data.eastmoney.com/report/${code}.html` } },
    );
    return (json?.data || []).map((item) => normalizedNews({
      title: item.title,
      date: item.publishDate,
      url: item.infoCode
        ? `https://data.eastmoney.com/report/info/${item.infoCode}.html`
        : '',
      src: item.orgSName ? `研报·${item.orgSName}` : '机构研报',
      kind: 'research',
    })).filter(Boolean).slice(0, size);
  } catch { return []; }
}

// 定向新闻统一入口：东财 + 华尔街见闻并发，任一来源失败不影响另一来源。
export async function fetchNews(keyword, size = 5, options = {}) {
  return collectNewsSources([
    fetchEastmoneyNews(keyword, size, options),
    fetchWallstreetSearch(keyword, size, options),
  ], size);
}

// 个股新闻：媒体检索 + 公司公告 + 机构研报，公告优先且明确标识类型。
export async function fetchStockNews(name, size = 6, code = '', options = {}) {
  if (code && typeof code === 'object') {
    options = code;
    code = '';
  }
  const query = String(name || code || '').trim();
  const normalizedCode = /^\d{6}$/.test(String(code || '').trim())
    ? String(code).trim()
    : (/^\d{6}$/.test(query) ? query : '');
  return collectNewsSources([
    normalizedCode ? fetchStockAnnouncements(normalizedCode, Math.min(size, 6), options) : Promise.resolve([]),
    query ? fetchNews(query, size, options) : Promise.resolve([]),
    normalizedCode ? fetchStockResearch(normalizedCode, Math.min(size, 3), options) : Promise.resolve([]),
  ], size);
}

// ===== 权威财经快讯聚合（金十/财联社/东财，第三方开放聚合，无需 key）=====
// 财联社官方接口需签名无法直调，改用聚合了金十数据/财联社系/东财的开放 JSON，权威且新鲜。
export async function fetchClsTelegraph(size = 12, {
  fetchImpl = fetch,
} = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetchImpl('https://news.finai.fun/api/news', { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    if (!r.ok) return [];
    const j = await r.json();
    const data = (j && j.data) || [];
    const srcCn = { jin10: '金十数据', eastmoney: '东方财富', cls: '财联社', wallstreetcn: '华尔街见闻' };
    return data.map((x) => ({
      title: (x.title || x.summary || '').replace(/<[^>]+>/g, '').slice(0, 120),
      date: (x.publishedAt || '').slice(0, 10),
      publishedAt: String(x.publishedAt || '').slice(0, 32),
      url: x.url || '',
      src: srcCn[x.sourceId] || x.sourceId || '快讯',
      kind: 'flash',
      level: x.level, // 重要性(聚合源自带)
    })).filter((x) => x.title).slice(0, size);
  } catch { return []; }
}

// ===== 新浪财经 7×24 全球快讯（无需 key，直调）=====
export async function fetchSinaFlash(size = 12, {
  fetchImpl = fetch,
} = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    // 财经全球直播滚动接口(zhibo)：lid=1 全球直播
    const r = await fetchImpl(`https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=${size}&zhibo_id=152&tag_id=0&dire=f&dpc=1`, {
      signal: ctrl.signal, headers: { Referer: 'https://finance.sina.com.cn/7x24/', 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(t);
    if (!r.ok) return [];
    const j = await r.json();
    const list = (j && j.result && j.result.data && j.result.data.feed && j.result.data.feed.list) || [];
    return list.map((x) => ({
      title: (x.rich_text || x.content || '').replace(/<[^>]+>/g, '').slice(0, 120),
      date: (x.create_time || '').slice(0, 10),
      publishedAt: String(x.create_time || '').slice(0, 32),
      url: (x.docurl || (x.ext && (() => { try { return JSON.parse(x.ext).docurl } catch { return '' } })()) || ''),
      src: '新浪财经',
      kind: 'flash',
    })).filter((x) => x.title).slice(0, size);
  } catch { return []; }
}

// 宏观实时流统一入口：聚合源、新浪和华尔街见闻任一可用即可返回。
export async function fetchMarketFlashes(size = 12, options = {}) {
  return collectNewsSources([
    fetchClsTelegraph(size, options),
    fetchSinaFlash(size, options),
    fetchWallstreetLive(size, options),
  ], size);
}

// ===== Finnhub 海外市场新闻（需 key，补美股/宏观，英文）=====
// 环境变量 FINNHUB_KEY；category=general 综合财经
export async function fetchFinnhubNews(size = 8) {
  const key = process.env.FINNHUB_KEY;
  if (!key) return [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${key}`, { signal: ctrl.signal });
    clearTimeout(t);
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => ({
      title: x.headline || '',
      date: x.datetime ? new Date(x.datetime * 1000).toISOString().slice(0, 10) : '',
      publishedAt: x.datetime
        ? new Date(x.datetime * 1000).toISOString()
        : '',
      url: x.url || '', src: (x.source || 'Finnhub'),
    })).filter((x) => x.title).slice(0, size);
  } catch { return []; }
}
