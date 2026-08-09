import { put, list, readJson, hasStorage } from './_blob.js';
import { emGet, num, sendJson, preflight } from './_lib.js';
import { marketTimePromptBlock } from './_market_time.js';
import { fetchOverseas, fetchAIndices, fetchNews, fetchStockNews, fetchClsTelegraph, fetchSinaFlash, fetchFinnhubNews } from './_market_data.js';
import { buildDailySummary } from './_daily_summary.js';
import { llmEnv, makeSSE, callChat, parseLLMJson } from './_llm.js';
import { ensureConfig, getModel, getReasoning } from './_llm_config.js';

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

// 日报模型改为运行时读取；原独立 daily 角色已移除，复用 agent 模型，见 handler 内 getModel('agent')

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
  if (preflight(req, res)) return;
  await ensureConfig();               // 预热运行时配置（前端可改 Base/Key/模型）
  const MODEL = getModel('agent');    // 策略日报复用「智能体」模型(原独立 daily 角色已移除)
  const REASONING = getReasoning('agent');
  const { BASE, KEY } = llmEnv();
  const streaming = true; // 本接口一律 SSE

  const { emit, phase, stopHeartbeat } = makeSSE(res); // makeSSE 内已统一应用 CORS
  // 双重 end 兜底:任何分支只要调用 endOnce 即可,重复调用无副作用(避免 "write after end" 崩溃)
  let ended = false;
  const endOnce = () => { if (ended) return; ended = true; try { stopHeartbeat && stopHeartbeat(); } catch { /* ignore */ } try { res.end(); } catch { /* 连接已断 */ } };

  try {
    let body = req.body; if (typeof body === 'string') body = JSON.parse(body || '{}');
    const START = Date.now();
    const BUDGET = 115000; // 总预算 115s（FC 超时 600s，此值决定何时兜底返回）；三路 LLM 并行，慢模型也不易被误杀
    const remain = () => BUDGET - (Date.now() - START);
    const holdings = Array.isArray(body && body.holdings) ? body.holdings.slice(0, 20) : [];
    const session = (req.query.session && SESSION_CN[req.query.session]) ? req.query.session : autoSession();
    const refresh = req.query.refresh === '1';
    const day = bjDayKey();
    const hasBlob = hasStorage();

    // 1) 命中缓存(同日同场次且非强制刷新)→ 直接返回
    if (hasBlob && !refresh) {
      try {
        const { blobs } = await list({ prefix: cacheKey(day, session), limit: 5 });
        if (blobs.length) {
          const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
          const cached = await readJson(latest);
          if (cached && cached.report) { emit('result', { ok: true, cached: true, ...cached }); return endOnce(); }
        }
      } catch { /* 无缓存继续生成 */ }
    }

    if (!BASE || !KEY) { emit('result', { ok: false, error: 'LLM 未配置' }); return endOnce(); }

    // 2) 并行抓全市场数据
    phase('正在采集 A股板块资金 / 涨停 / 指数…');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;
    const getJ = (p) => { const c = new AbortController(); const to = setTimeout(() => c.abort(), 8000); return fetch(origin + p, { headers: { 'x-internal': '1' }, signal: c.signal }).then((r) => r.json()).catch(() => null).finally(() => clearTimeout(to)); };

    const [sectors, aIdx, overseas, limitPool, sectorNews, macroNews, holdingInfo, holdingQuotes, clsNews, sinaNews, finnhubNews] = await Promise.all([
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
      // ★持仓股今日真实行情(现价/涨跌幅/涨停跌停)——防止日报凭新闻标题臆断涨跌方向
      holdings.length ? getJ(`/api/quote?codes=${holdings.map((h) => h.code).join(',')}&_t=${Date.now()}`) : Promise.resolve(null),
      // 权威快讯源(金十/财联社系/东财聚合) + 新浪7×24 + Finnhub海外
      fetchClsTelegraph(14),
      fetchSinaFlash(10),
      fetchFinnhubNews(6),
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

    // 持仓股今日真实行情表:code → {price,pct,涨停,跌停}，作为日报持仓段的"当下事实"，压过新闻臆断
    const hqMap = {};
    ((holdingQuotes && holdingQuotes.list) || []).forEach((q) => {
      if (!q || !q.code) return;
      const pct = num(q.pct);
      hqMap[q.code] = {
        现价: num(q.price),
        今日涨跌幅: pct,
        状态: q.isLimitUp ? '今日涨停' : q.isLimitDown ? '今日跌停' : (pct >= 7 ? '今日大涨' : pct <= -7 ? '今日大跌' : pct >= 0 ? '今日上涨' : '今日下跌'),
        量比: q.volRatio ?? null,
        换手率: q.turnover ?? null,
      };
    });

    // 3) 组织数据，拆成两路【并行】LLM 生成(单次输出减半、并发不叠加时间，避免超时)
    phase('数据齐全，正在撰写策略日报…');
    const dataBlock = {
      session: SESSION_CN[session], day,
      aIndices: aIdx, overseas: overseas.indices, commodities: overseas.commodities,
      sectorFlow, limitUpCount: limitCount,
      sectorNews: sectorNews.map((s) => ({ 板块: s.name, 新闻: s.news.map((n) => n.title).slice(0, 3) })),
      macroNews: macroNews.map((n) => n.title),
      权威快讯: (clsNews || []).map((n) => `[${n.src}]${n.title}`).slice(0, 12),   // 金十/财联社系/东财聚合
      新浪快讯: (sinaNews || []).map((n) => n.title).slice(0, 8),
      海外新闻: (finnhubNews || []).map((n) => n.title).slice(0, 6),               // Finnhub(有key才有)
      holdings: holdingInfo.map((h) => ({
        名称: h.name, 代码: h.code,
        今日行情: hqMap[h.code] || null,   // ★真实行情(现价/涨跌幅/涨停跌停)——写持仓段必须以此为准
        相关信息: h.news.map((n) => n.title),
      })),
    };
    const dataStr = JSON.stringify(dataBlock, null, 0);
    const SYS = `你是顶级卖方策略分析师，为专业短线/波段投资者撰写《全市场投资策略日报》。基于给定真实数据做判断，绝不编造。每个观点要有证据(引用给定数据的具体数字/新闻)。红涨绿跌(A股口径)。只输出合法 JSON，不要 markdown 代码块包裹。`;
    const timeCtx = marketTimePromptBlock();

    // 动态超时：两路并发，各自可用剩余预算
    const llmTimeout = Math.max(14000, remain() - 3000);
    const callLLM = async (userPrompt, maxTokens) => {
      const { resp, done } = await callChat({
        model: MODEL,
        role: 'agent',   // 策略日报复用 agent 角色 → 端点级模型解析走 agent
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: userPrompt }],
        temperature: 0.4,
        maxTokens,
        timeoutMs: llmTimeout,
        reasoning: REASONING,
        responseFormat: { type: 'json_object' },
      });
      done();
      if (!resp || resp.__err || !resp.ok) return null;
      const j = await resp.json().catch(() => null);
      const content = (j && j.choices?.[0]?.message?.content) || '';
      if (!content.trim()) return null;
      return parseLLMJson(content).value;
    };

    // 路A：总览 + 海外 + 整体策略 + 风险 + 持仓股(短)
    const promptA = `${timeCtx}\n【本期：${SESSION_CN[session]} · ${day}】\n【真实数据】\n${dataStr}\n\n输出 JSON：{"overview":"两三句总览(引用指数与资金具体数字)","overseas":"一句话隔夜海外/商品对A股影响(引用恒生/纳指/黄金/原油涨跌)","strategy":"今日整体操作策略(仓位/节奏/主攻方向,两三句)","risks":["风险1","风险2","风险3"],"holdings":[{"name":"持仓股名","info":"今日相关信息(引用给定信息;无则'今日无重要公告/新闻')","impact":"影响与关注建议(简短)"}]}。holdings 逐一覆盖每只持仓股。
【★持仓段·铁律,绝对不能违反】每只持仓股的 info 必须以该股 data.holdings[].今日行情 为【当下事实唯一依据】：
1. 涨跌方向以"今日行情.状态/今日涨跌幅"为准——跌停就写跌停、下跌就写下跌,【绝对不能】把跌的说成涨、把涨停说成跌停;若某股今日行情为 null(未取到),只能写"今日行情数据缺失",不许臆断涨跌。
2. "相关信息"里的新闻标题多为【全市场/板块新闻】,不是这只股的个股事实。【绝对禁止】把"88只涨停股/70股每笔成交量增长/封单超亿元"这类全市场统计,当成这只持仓股自己的表现来写。只有明确点名该股(名称/代码)的信息才可作为个股事实引用。
3. info 里出现的涨跌幅数字必须等于"今日行情.今日涨跌幅",不许自造。语言精炼。只输出 JSON。`;
    // 路B/C：10 板块拆两批各5块并发(单批输出小更快，避免单次大JSON超时)
    const sectorPrompt = (blocks) => `${timeCtx}\n【本期：${SESSION_CN[session]} · ${day}】\n【真实数据】\n${dataStr}\n\n只针对这些板块输出 JSON：{"sectors":[{"name":"板块名","rating":"看多/中性/看空","view":"观点+证据(一句话,引用资金流/涨停/新闻具体数据)","strategy":"操作策略(简短)","risk":"风险(简短)"}]}。必须且只覆盖这几个板块:${blocks}。数据不足的板块基于新闻常识给方向,view标'数据有限'。每字段一到两句。只输出 JSON。`;
    const promptB = sectorPrompt('AI/科技、消费、医药、新能源、周期资源');
    const promptC = sectorPrompt('金融地产、红利资产、港股、美股、商品');

    const [partA, partB, partC] = await Promise.all([callLLM(promptA, 1200), callLLM(promptB, 1200), callLLM(promptC, 1200)]);
    if (!partA && !partB && !partC) { emit('result', { ok: false, error: '日报生成超时，请稍后重试' }); return endOnce(); }
    const report = {
      session: SESSION_CN[session],
      overview: (partA && partA.overview) || '',
      overseas: (partA && partA.overseas) || '',
      strategy: (partA && partA.strategy) || '',
      risks: (partA && partA.risks) || [],
      holdings: (partA && partA.holdings) || [],
      sectors: [...((partB && partB.sectors) || []), ...((partC && partC.sectors) || [])],
    };

    const result = {
      ok: true, cached: false, day, session, sessionCn: SESSION_CN[session], updatedAt: Date.now(),
      report,
      // 附上关键数据供前端展示与"数据来源"标注
      data: { aIndices: aIdx, overseas: overseas.indices, commodities: overseas.commodities, sectorFlow, limitUpCount: limitCount },
      newsRefs: [...(clsNews || []).slice(0, 4), ...(finnhubNews || []).slice(0, 2), ...macroNews.slice(0, 2), ...sectorNews.flatMap((s) => s.news.slice(0, 1))].filter((n) => n && n.url).slice(0, 10),
    };
    // 精简摘要：供操作建议/复盘复用为"外部市场环境"(阶段2)
    result.summary = buildDailySummary(result);

    // 4) 写缓存
    if (hasBlob) {
      try { await put(`${cacheKey(day, session)}-${Date.now()}.json`, JSON.stringify(result), { access: 'public', contentType: 'application/json', addRandomSuffix: true, cacheControlMaxAge: 0 }); } catch { /* ignore */ }
    }

    emit('result', result);
    return endOnce();
  } catch (e) {
    emit('result', { ok: false, error: String(e.message || e) });
    return endOnce();
  }
}
