import { num } from './_lib.js';

// ============ RAG 核心：语料构建 + 向量检索 ============

function toSecid(code) {
  const c = String(code).trim();
  return /^(6|9|5)/.test(c) ? '1.' + c : '0.' + c;
}
function toF10Code(code) {
  const c = String(code).trim();
  return (/^(6|9|5)/.test(c) ? 'SH' : 'SZ') + c;
}

async function jget(url, timeout = 7000, referer = 'https://quote.eastmoney.com/') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: referer,
        Accept: '*/*',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = await res.text();
    return txt;
  } finally {
    clearTimeout(t);
  }
}

// 抓取个股近5日行情 + 资金 + 主营 + 新闻，构建 RAG 文档块
export async function buildCorpus(code) {
  const secid = toSecid(code);
  const docs = [];
  let profile = null;
  let news = [];

  // 1) 近5日K线（多取几天保证有5个交易日）
  const klUrl =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f59,f61&klt=101&fqt=1&end=20500101&lmt=8`;
  // 2) 公司简介
  const f10Url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${toF10Code(code)}`;
  // 3) 个股新闻（东财搜索）
  const newsParam = encodeURIComponent(JSON.stringify({
    uid: '', keyword: code, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: 8 } },
  }));
  const newsUrl = `https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=${newsParam}`;

  const [klTxt, f10Txt, newsTxt] = await Promise.all([
    jget(klUrl).catch(() => null),
    jget(f10Url, 7000, 'https://emweb.securities.eastmoney.com/').catch(() => null),
    jget(newsUrl, 7000, 'https://so.eastmoney.com/').catch(() => null),
  ]);

  // 解析 K线 -> 近5日文档
  let name = code;
  try {
    const kj = JSON.parse(klTxt);
    name = (kj.data && kj.data.name) || code;
    const klines = ((kj.data && kj.data.klines) || []).slice(-5);
    klines.forEach((line) => {
      const p = line.split(',');
      docs.push({
        type: 'kline',
        text: `【${name} ${p[0]} 行情】开盘${p[1]} 收盘${p[2]} 最高${p[3]} 最低${p[4]} 成交量${p[5]}手 成交额${(num(p[6]) / 1e8).toFixed(2)}亿 涨跌幅${p[8]}% 换手率${p[7]}%`,
      });
    });
    // 汇总一条5日走势
    if (klines.length) {
      const first = klines[0].split(',');
      const last = klines[klines.length - 1].split(',');
      const chg = (((num(last[2]) - num(first[1])) / num(first[1])) * 100).toFixed(2);
      docs.push({ type: 'summary', text: `【${name} 近${klines.length}日走势】区间累计涨跌约${chg}%，最新价${last[2]}` });
    }
  } catch {}

  // 解析简介
  try {
    const fj = JSON.parse(f10Txt);
    const jb = (fj.jbzl && fj.jbzl[0]) || {};
    profile = {
      name: jb.SECURITY_NAME_ABBR || name,
      fullName: jb.ORG_NAME || '',
      industry: jb.EM2016 || jb.INDUSTRYCSRC1 || '',
      business: jb.BUSINESS_SCOPE || '',
      intro: (jb.ORG_PROFILE || '').trim(),
    };
    if (profile.industry) docs.push({ type: 'profile', text: `【${profile.name} 所属行业】${profile.industry}` });
    if (profile.business) docs.push({ type: 'profile', text: `【${profile.name} 主营业务】${profile.business}` });
    if (profile.intro) docs.push({ type: 'profile', text: `【${profile.name} 公司简介】${profile.intro.slice(0, 300)}` });
  } catch {}

  // 解析新闻（联网信息）
  try {
    const clean = newsTxt.replace(/^x\(/, '').replace(/\);?$/, '');
    const nj = JSON.parse(clean);
    const arr = (nj.result && nj.result.cmsArticleWebOld) || [];
    news = arr.slice(0, 8).map((a) => ({
      title: (a.title || '').replace(/<[^>]+>/g, ''),
      date: (a.date || '').slice(0, 10),
      summary: (a.content || '').replace(/<[^>]+>/g, '').slice(0, 160),
      url: a.url || (a.code ? `https://finance.eastmoney.com/a/${a.code}.html` : ''),
    }));
    news.forEach((n) => {
      docs.push({ type: 'news', text: `【新闻 ${n.date}】${n.title}。${n.summary}`, url: n.url, title: n.title, date: n.date });
    });
  } catch {}

  return { name, profile, news, docs };
}

// 调用嵌入模型
export async function embed(texts) {
  const BASE = process.env.LLM_BASE_URL;
  const KEY = process.env.LLM_API_KEY;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${BASE}/embeddings`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'BGE-m3', input: texts }),
    });
    if (!res.ok) throw new Error('embed HTTP ' + res.status);
    const j = await res.json();
    const data = j.data || (j.data === undefined ? j : []);
    return (j.data || []).map((d) => d.embedding);
  } finally {
    clearTimeout(t);
  }
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// 向量检索 topK；嵌入失败则退化为关键词匹配
export async function retrieve(query, docs, k = 6) {
  if (!docs.length) return [];
  try {
    const [qVec] = await embed([query]);
    const dVecs = await embed(docs.map((d) => d.text));
    if (qVec && dVecs.length === docs.length) {
      const scored = docs.map((d, i) => ({ ...d, score: cosine(qVec, dVecs[i]) }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k);
    }
  } catch (e) {
    // fallthrough to keyword
  }
  // 关键词回退
  const kw = query.split(/\s+/).filter(Boolean);
  const scored = docs.map((d) => ({
    ...d,
    score: kw.reduce((s, w) => s + (d.text.includes(w) ? 1 : 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
