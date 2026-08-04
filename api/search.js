import { sendJson, sendError } from './_lib.js';

// 股票搜索：名称/代码/拼音 → 匹配的境内证券（沪深京A股 + ETF/LOF）
// 数据源双通道：主用东方财富 suggest；失败/被限流/空结果时回退腾讯财经。
// 两个源都返回真实行情数据，互为兜底，解决"部分股票（尤其北交所）搜不到 / 整批搜索崩溃"。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchText(url, headers, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    return await r.text();
  } finally { clearTimeout(t); }
}

// 由市场 + 代码推断展示类型（沪A/深A/京A/创业板/科创板/ETF）
function classify(code, mktName) {
  const isEtf = /^(15|16|51|56|58|50|18)/.test(code);
  if (isEtf) return { type: 'ETF/基金', isEtf: true };
  if (/^(300|301)/.test(code)) return { type: '创业板', isEtf: false };
  if (code.startsWith('688')) return { type: '科创板', isEtf: false };
  if (/^(83|87|43|92)/.test(code)) return { type: '京A', isEtf: false };
  return { type: mktName || '', isEtf: false };
}

// ---- 源1：东方财富 suggest（偶发 JSONP 包裹 / 限流，需容错解析）----
async function fromEastmoney(kw) {
  const url =
    `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}` +
    `&type=14&count=10&token=D43BF722C8E33BDC906FB84D85E326E8`;
  const raw = await fetchText(url, { Referer: 'https://www.eastmoney.com/', 'User-Agent': UA });
  // 兼容纯 JSON 与 JSONP（jQuery123_456({...})）两种回包
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  const j = (a >= 0 && b > a) ? JSON.parse(raw.slice(a, b + 1)) : null;
  const arr = (j && j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
  return arr
    .filter((x) => {
      const code = x.Code || '';
      const mkt = String(x.MktNum);
      if (!/^[0-9]{6}$/.test(code)) return false;
      if (mkt !== '0' && mkt !== '1') return false; // 只留境内沪深京
      const tn = x.SecurityTypeName || '';
      const isStock = /[AB]股|京A|北A|创业|科创|北交所|沪A|深A/.test(tn);
      const isBse = /^(83|87|43|92)/.test(code);
      const isFund = /基金|ETF|LOF/.test(tn) || /^(15|16|51|56|58|50|18)/.test(code);
      return isStock || isBse || isFund;
    })
    .map((x) => {
      const { type, isEtf } = classify(x.Code, x.SecurityTypeName);
      return { code: x.Code, name: x.Name, type, isEtf };
    });
}

// ---- 源2：腾讯财经 smartbox（支持中文名/代码/拼音，UTF-8 JSON，含北交所）----
async function fromTencent(kw) {
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get?app=ChinaStock&q=${encodeURIComponent(kw)}`;
  const raw = await fetchText(url, { Referer: 'https://gu.qq.com/', 'User-Agent': UA });
  const j = JSON.parse(raw);
  const stock = (j && j.data && j.data.stock) || [];
  const mktName = { sh: '沪A', sz: '深A', bj: '京A' };
  return stock
    .filter((s) => ['sh', 'sz', 'bj'].includes(s[0]) && /^[0-9]{6}$/.test(s[1]))
    .map((s) => {
      const code = s[1];
      const { type, isEtf } = classify(code, mktName[s[0]]);
      return { code, name: s[2], type, isEtf };
    });
}

export default async function handler(req, res) {
  try {
    const kw = (req.query.kw || '').trim();
    if (!kw) return sendJson(res, { ok: true, list: [] });

    let list = [];
    // 主源：东方财富（失败/空则回退），双源都真实数据
    try { list = await fromEastmoney(kw); } catch { list = []; }
    if (!list.length) {
      try { list = await fromTencent(kw); } catch { /* 两源都失败下方返回空 */ }
    }

    // 去重（同代码只留一条）+ 截断
    const seen = new Set();
    list = list.filter((x) => (seen.has(x.code) ? false : (seen.add(x.code), true))).slice(0, 12);

    sendJson(res, { ok: true, list }, { cache: 120 });
  } catch (e) {
    sendError(res, e);
  }
}
