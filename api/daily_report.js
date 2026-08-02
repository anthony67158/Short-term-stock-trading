import { put, list } from '@vercel/blob';
import { emGet, num, sendJson } from './_lib.js';
import { marketTimePromptBlock } from './_market_time.js';
import { fetchOverseas, fetchAIndices, fetchNews, fetchStockNews } from './_market_data.js';

// ============ 全市场投资策略日报（早/午/晚三场次，SSE 流式 + Blob 缓存）============
// GET /api/daily_report?session=morning|noon|evening[&refresh=1]  body(POST): { holdings:[{code,name}] }
// 数据源全部为开源免费原始接口(东财/腾讯/新浪)，海外/商品诚实标注时效。

function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000); }
function bjDayKey() { const d = nowBJ(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function bjMinutes() { const d = nowBJ(); return d.getHours() * 60 + d.getMinutes(); }
// 按当前时刻自动判定默认场次：<11:30 早报 / 11:30-15:00 午报 / >=15:00 晚报
function autoSession() { const hm = bjMinutes(); if (hm < 690) return 'morning'; if (hm < 900) return 'noon'; return 'evening'; }
const SESSION_CN = { morning: '盘前早报', noon: '午间午报', evening: '收盘晚报' };
const PREFIX = 'dailyreport/';
const cacheKey = (day, session) => `${PREFIX}${day}-${session}`;

const MODEL = process.env.DAILY_MODEL || process.env.LLM_MODEL || 'DeepSeek-V3.2-Pro';

// 板块清单（全市场覆盖）→ 每个用关键词做定向新闻检索
const SECTORS = [
  { key: 'ai_tech', name: 'AI/科技', kw: 'AI 芯片 算力 半导体 科技股' },
  { key: 'consume', name: '消费', kw: '白酒 消费 食品饮料 免税' },
  { key: 'pharma', name: '医药', kw: '医药 创新药 医疗器械 CXO' },
  { key: 'new_energy', name: '新能源', kw: '新能源 光伏 锂电 储能 电动车' },
  { key: 'cyclical', name: '周期资源', kw: '有色 煤炭 钢铁 稀土 化工' },
  { key: 'finance', name: '金融地产', kw: '银行 券商 保险 房地产' },
  { key: 'dividend', name: '红利资产', kw: '红利 高股息 央企 电力 运营商' },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const BASE = process.env.LLM_BASE_URL, KEY = process.env.LLM_API_KEY;
  const streaming = true; // 本接口一律 SSE

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const emit = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 断连 */ } };
  const phase = (text) => emit('phase', { text });

  try {
    let body = req.body; if (typeof body === 'string') body = JSON.parse(body || '{}');
    const START = Date.now();
    const BUDGET = 58000; // 58s 内必须返回，避免被平台强杀
    const remain = () => BUDGET - (Date.now() - START);
    const holdings = Array.isArray(body && body.holdings) ? body.holdings.slice(0, 20) : [];
    const session = (req.query.session && SESSION_CN[req.query.session]) ? req.query.session : autoSession();
    const refresh = req.query.refresh === '1';
    const day = bjDayKey();
    const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;

    // 1) 命中缓存(同日同场次且非强制刷新)→ 直接返回
    if (hasBlob && !refresh) {
      try {
        const { blobs } = await list({ prefix: cacheKey(day, session), limit: 5 });
        if (blobs.length) {
          const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
          const cached = await fetch(latest.url).then((r) => r.json()).catch(() => null);
          if (cached && cached.report) { emit('result', { ok: true, cached: true, ...cached }); return res.end(); }
        }
      } catch { /* 无缓存继续生成 */ }
    }

    if (!BASE || !KEY) { emit('result', { ok: false, error: 'LLM 未配置' }); return res.end(); }

    // 2) 并行抓全市场数据
    phase('正在采集 A股板块资金 / 涨停 / 指数…');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;
    const getJ = (p) => { const c = new AbortController(); const to = setTimeout(() => c.abort(), 8000); return fetch(origin + p, { headers: { 'x-internal': '1' }, signal: c.signal }).then((r) => r.json()).catch(() => null).finally(() => clearTimeout(to)); };

    const [sectors, aIdx, overseas, limitPool, sectorNews, macroNews, holdingInfo] = await Promise.all([
      getJ('/api/sectors?type=industry&sort=main'),
      fetchAIndices(emGet, num),
      fetchOverseas(),
      getJ('/api/board?type=limitup&kind=zt'),
      // 各板块定向新闻(每块并行)
      Promise.all(SECTORS.map((s) => fetchNews(s.kw, 3).then((n) => ({ key: s.key, name: s.name, news: n })))),
      // 宏观
      fetchNews('宏观 政策 央行 A股 美联储 关税', 6),
      // 持仓股(每只并行取当日新闻)
      holdings.length ? Promise.all(holdings.map((h) => fetchStockNews(h.name || h.code, 3).then((news) => ({ code: h.code, name: h.name, news })))) : Promise.resolve([]),
    ]);
    phase('数据齐全，正在撰写策略日报…');

    // 板块资金 TOP/BOTTOM
    const slist = (sectors && sectors.list) || [];
    const sSorted = [...slist].sort((a, b) => b.mainInflow - a.mainInflow);
    const yi = (v) => +(v / 1e8).toFixed(2);
    const sectorFlow = {
      top: sSorted.slice(0, 8).map((s) => ({ name: s.name, pct: s.pct, inflowYi: yi(s.mainInflow), lead: s.leadName })),
      bottom: sSorted.slice(-6).reverse().map((s) => ({ name: s.name, pct: s.pct, inflowYi: yi(s.mainInflow) })),
    };
    const limitCount = ((limitPool && limitPool.list) || []).length;

    // 3) 组织 prompt，调 LLM 生成结构化日报
    phase('数据齐全，正在撰写策略日报…');
    const dataBlock = {
      session: SESSION_CN[session], day,
      aIndices: aIdx, overseas: overseas.indices, commodities: overseas.commodities,
      sectorFlow, limitUpCount: limitCount,
      sectorNews: sectorNews.map((s) => ({ 板块: s.name, 新闻: s.news.map((n) => n.title).slice(0, 3) })),
      macroNews: macroNews.map((n) => n.title),
      holdings: holdingInfo.map((h) => ({ 名称: h.name, 代码: h.code, 相关信息: h.news.map((n) => n.title) })),
    };

    const SYS = `你是顶级卖方策略分析师，为专业短线/波段投资者撰写《全市场投资策略日报》。基于给定的真实数据(A股板块资金/涨停/指数、海外指数、商品、各板块新闻、宏观、持仓股信息)做判断，绝不编造数据。每个观点都要有证据链(引用给定数据里的具体数字/新闻)。红涨绿跌(A股口径)。只输出合法 JSON，不要 markdown 代码块包裹。`;

    const userPrompt = `${marketTimePromptBlock()}

【本期：${SESSION_CN[session]} · ${day}】
【真实数据】
${JSON.stringify(dataBlock, null, 0)}

请撰写一份覆盖全市场的投资策略日报，输出 JSON：
{
 "session":"${SESSION_CN[session]}",
 "overview":"一段话总览(今日/隔夜市场定调，引用指数与资金的具体数字)",
 "overseas":"隔夜海外与商品对A股的影响研判(引用恒生/纳指/标普/黄金/原油的具体涨跌)",
 "sectors":[{"name":"板块名(如AI/科技、消费、医药、新能源、周期资源、金融地产、红利资产、港股、美股、商品——至少覆盖A股几大板块+港股+美股+商品)","rating":"看多/中性/看空","view":"观点结论","evidence":"证据链(引用资金流/涨停/新闻的具体数据)","picks":"值得关注的方向或个股(有则给,来自数据或常识龙头)","strategy":"操作策略","risk":"风险提示"}],
 "holdings":[{"name":"持仓股名","info":"该股今日相关信息发布情况(引用给定的相关信息;无则写'今日无重要公告/新闻')","impact":"对该持仓的影响与关注建议"}],
 "strategy":"今日整体操作策略(仓位/节奏/主攻方向)",
 "risks":["全局风险点1","风险点2"]
}
要求：sectors 至少覆盖 AI/科技、消费、医药、新能源、周期资源、金融地产、红利资产、港股、美股、商品 这些板块(数据不足的板块基于新闻与常识给方向性判断并标注'数据有限')。holdings 必须逐一覆盖给定的每只持仓股。只输出 JSON。`;

    const ctrl = new AbortController();
    // LLM 超时按剩余预算动态给(预留2s兜底返回)，最少12s
    const llmTimeout = Math.max(12000, remain() - 2000);
    const t = setTimeout(() => ctrl.abort(), llmTimeout);
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYS }, { role: 'user', content: userPrompt }], temperature: 0.4, max_tokens: 3600, response_format: { type: 'json_object' } }),
    }).catch((e) => ({ __err: e }));
    clearTimeout(t);
    if (resp && resp.__err) { emit('result', { ok: false, error: '日报生成超时，请稍后重试' }); return res.end(); }
    if (!resp.ok) { const e = await resp.text().catch(() => ''); emit('result', { ok: false, error: `LLM ${resp.status}`, detail: (e || '').slice(0, 150) }); return res.end(); }

    const j = await resp.json();
    const content = j.choices?.[0]?.message?.content || '';
    let report; try { report = JSON.parse(content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()); } catch { report = { raw: content }; }

    const result = {
      ok: true, cached: false, day, session, sessionCn: SESSION_CN[session], updatedAt: Date.now(),
      report,
      // 附上关键数据供前端展示与"数据来源"标注
      data: { aIndices: aIdx, overseas: overseas.indices, commodities: overseas.commodities, sectorFlow, limitUpCount: limitCount },
      newsRefs: [...macroNews.slice(0, 3), ...sectorNews.flatMap((s) => s.news.slice(0, 1))].filter((n) => n && n.url).slice(0, 8),
    };

    // 4) 写缓存
    if (hasBlob) {
      try { await put(`${cacheKey(day, session)}-${Date.now()}.json`, JSON.stringify(result), { access: 'public', contentType: 'application/json', addRandomSuffix: true, cacheControlMaxAge: 0 }); } catch { /* ignore */ }
    }

    emit('result', result);
    return res.end();
  } catch (e) {
    emit('result', { ok: false, error: String(e.message || e) });
    return res.end();
  }
}
