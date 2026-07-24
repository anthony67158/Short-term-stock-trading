import { sendJson, sendError } from './_lib.js';

// 股票搜索：名称/代码/拼音 → 匹配的A股列表
// query: kw=关键词
export default async function handler(req, res) {
  try {
    const kw = (req.query.kw || '').trim();
    if (!kw) return sendJson(res, { ok: true, list: [] });

    const url =
      `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}` +
      `&type=14&count=10&token=D43BF722C8E33BDC906FB84D85E326E8`;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    let j = null;
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Referer: 'https://www.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
      j = await r.json();
    } finally { clearTimeout(t); }

    const arr = (j && j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
    // 保留 A股 + ETF/LOF基金（沪深京，MktNum 0=深 1=沪 说明是境内），过滤港美股/指数
    const list = arr
      .filter((x) => {
        const code = x.Code || '';
        const mkt = String(x.MktNum);
        if (!/^[0-9]{6}$/.test(code)) return false;
        if (mkt !== '0' && mkt !== '1') return false; // 只留境内沪深
        const t = x.SecurityTypeName || '';
        const isStock = /[AB]股|京A|创业|科创|北交所|沪A|深A/.test(t);
        const isFund = /基金|ETF|LOF/.test(t) || /^(15|16|51|56|58|50|18)/.test(code);
        return isStock || isFund;
      })
      .slice(0, 12)
      .map((x) => {
        const t = x.SecurityTypeName || '';
        const isEtf = /基金|ETF|LOF/.test(t) || /^(15|16|51|56|58|50|18)/.test(x.Code);
        return { code: x.Code, name: x.Name, type: isEtf ? 'ETF/基金' : t, isEtf };
      });

    sendJson(res, { ok: true, list }, { cache: 300 });
  } catch (e) {
    sendError(res, e);
  }
}
