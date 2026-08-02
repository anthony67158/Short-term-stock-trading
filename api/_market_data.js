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

// 定向新闻检索（东财资讯搜索）——给某个关键词取最新几条标题
export async function fetchNews(keyword, size = 5) {
  try {
    const param = encodeURIComponent(JSON.stringify({
      uid: '', keyword, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web',
      param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: size } },
    }));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=${param}`, {
      signal: ctrl.signal, headers: { Referer: 'https://so.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(t);
    const txt = await r.text();
    const clean = txt.replace(/^x\(/, '').replace(/\);?$/, '');
    const nj = JSON.parse(clean);
    const arr = (nj.result && nj.result.cmsArticleWebOld) || [];
    return arr.map((a) => ({ title: (a.title || '').replace(/<[^>]+>/g, ''), date: (a.date || '').slice(0, 10), url: a.url || '' }))
      .filter((x) => x.title).slice(0, size);
  } catch { return []; }
}

// 个股当日公告/新闻（东财，用股票名检索）
export async function fetchStockNews(name, size = 4) {
  return fetchNews(name, size);
}
