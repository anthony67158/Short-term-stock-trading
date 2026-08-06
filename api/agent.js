import { emGet, num, applyCors, preflight } from './_lib.js';
import { buildCorpus } from './_rag.js';
import { retrieveTheory } from './_kb.js';
import { screenStocks } from './_screen.js';
import { marketTimePromptBlock } from './_market_time.js';
import { fetchClsTelegraph } from './_market_data.js';
import { makeSSE, callChat, pumpStream, llmEnv } from './_llm.js';
import { ensureConfig, getModel, getReasoning } from './_llm_config.js';

// ============ 股票 Agent：工具增强的智能体 ============
// LLM 自主调用 skill 工具（查行情/选股/板块/涨停/异动/新闻…）多轮后综合作答
// 用支持 function calling 的模型（默认 Qwen3-Max-A，可在前端「AI 模型配置」改）

// 工具中文名（用于超时兜底时告诉用户"已经查到了什么"）
const TOOL_LABEL_CN = {
  search_stock: '股票搜索', get_quote: '实时行情', get_stock_detail: '公司主营',
  get_quant_score: '量化打分', screen_stocks: '条件选股', get_sector_rank: '板块资金排行',
  get_limit_pool: '涨停连板池', get_movers: '盘中异动', get_market: '大盘情绪', web_news: '联网新闻',
};

function toSecid(code) {
  const c = String(code).trim();
  return /^(6|9|5)/.test(c) ? '1.' + c : '0.' + c;
}

// ---------- Skill 工具定义（给 LLM 看的 schema） ----------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_stock',
      description: '根据股票名称或关键词搜索，返回匹配的股票代码和名称。当用户提到股票名字但你不知道代码时先用它。',
      parameters: { type: 'object', properties: { keyword: { type: 'string', description: '股票名称或关键词，如"茅台"' } }, required: ['keyword'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description: '查询一只或多只股票的实时行情：现价、涨跌幅、换手率、量比、主力净流入。',
      parameters: { type: 'object', properties: { codes: { type: 'string', description: '6位股票代码，多个用逗号分隔' } }, required: ['codes'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_detail',
      description: '查询个股的公司主营业务、简介、所属行业。分析基本面时用。',
      parameters: { type: 'object', properties: { code: { type: 'string', description: '6位股票代码' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_quant_score',
      description: '查询个股的【量化模型打分】：0~100综合分(越高越偏多)、偏多/偏空/中性判断、建议做T方向(正T低吸/反T高抛)、多因子解读(动量/均线/RSI/量价/均值回归)。分析或推荐某只个股、给买卖价参考、判断该不该买/该不该做T时，务必调用它作为量化依据。',
      parameters: { type: 'object', properties: { code: { type: 'string', description: '6位股票代码' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screen_stocks',
      description: '按条件从全市场筛选/选股。可指定排序(资金/涨幅/换手/量比/涨速)和过滤条件。推荐股票、选股时用。',
      parameters: {
        type: 'object',
        properties: {
          sort: { type: 'string', enum: ['main', 'pct', 'turnover', 'volratio', 'speed'], description: '排序依据：main=主力净流入,pct=涨幅,turnover=换手,volratio=量比,speed=涨速' },
          minPct: { type: 'number', description: '最小涨幅%' },
          maxPct: { type: 'number', description: '最大涨幅%' },
          minTurnover: { type: 'number', description: '最小换手率%' },
          minVolRatio: { type: 'number', description: '最小量比' },
          minInflowYi: { type: 'number', description: '最小主力净流入(亿)' },
          onlyLimitUp: { type: 'boolean', description: '是否只要涨停股' },
          limit: { type: 'number', description: '返回数量,默认15' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sector_rank',
      description: '查询板块资金流向排行，找出最强/最弱板块及其领涨股。判断热点方向时用。',
      parameters: { type: 'object', properties: { type: { type: 'string', enum: ['industry', 'concept'], description: '行业或概念' }, limit: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_limit_pool',
      description: '查询今日涨停连板池，含连板数、封板资金、所属行业。判断短线情绪、找强势股时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_movers',
      description: '查询盘中异动：主力抢筹榜或涨速榜，发现当下活跃个股。',
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['inflow', 'speed'], description: 'inflow=主力抢筹,speed=涨速' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market',
      description: '查询大盘整体情绪：三大指数、涨跌家数、涨停跌停数。判断今日能不能做时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_news',
      description: '联网搜索某只股票或某个主题的最新新闻/消息面。问消息、利好利空、催化剂时用。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索词，如"贵州茅台"或"半导体 政策"' } }, required: ['query'] },
    },
  },
];

// ---------- Skill 工具执行器（真正调数据） ----------
async function execTool(name, args, origin) {
  const call = async (pathname, timeoutMs = 8000) => {
    // 内部 API 调用加超时保护(原来无超时——某个工具后端卡住会拖垮整轮 agent、烧光预算)
    // timeoutMs 可覆盖：普通工具 8s 足够；量化含冷启动需放宽(见 get_quant_score)
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await fetch(origin + pathname, { headers: { 'x-internal': '1' }, signal: c.signal });
      return await r.json();
    } finally {
      clearTimeout(to);
    }
  };
  try {
    if (name === 'search_stock') {
      // 用东财搜索建议接口
      const kw = encodeURIComponent(args.keyword || '');
      const j = await fetch(
        `https://searchapi.eastmoney.com/api/suggest/get?input=${kw}&type=14&count=6&token=D43BF722C8E33BDC906FB84D85E326E8`,
        { headers: { Referer: 'https://www.eastmoney.com/' } }
      ).then((r) => r.json()).catch(() => null);
      const arr = (j && j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
      const list = arr
        .filter((x) => /^(SH|SZ|1|0)/.test(x.QuoteID || '') && /[0-9]{6}/.test(x.Code || ''))
        .slice(0, 6)
        .map((x) => ({ code: x.Code, name: x.Name, market: x.MktNum, type: x.SecurityTypeName }));
      return { list };
    }
    if (name === 'get_quote') {
      const j = await call(`/api/quote?codes=${encodeURIComponent(args.codes || '')}`);
      return { list: (j.list || []).map((s) => ({ code: s.code, name: s.name, price: s.price, pct: s.pct, turnover: s.turnover, volRatio: s.volRatio, mainInflowYi: +(s.mainInflow / 1e8).toFixed(2) })) };
    }
    if (name === 'get_stock_detail') {
      const j = await call(`/api/stock_detail?code=${args.code}&lmt=1`);
      const p = j.profile || {};
      return { name: p.name, code: p.code, industry: p.industry, business: (p.business || '').slice(0, 300), intro: (p.intro || '').slice(0, 300) };
    }
    if (name === 'get_quant_score') {
      // 拉量化打分 + 专业技术指标（含买卖价位锚），给 LLM 做量化依据
      // 量化后端(LightGBM+GARCH)冷启动实测~11s，8s 会被 abort。放宽到 24s，并做一次重试:
      // 首次可能踩冷启动，重试时服务已热(~1s)，几乎必成。绝不因超时让"量化打分"整块失败。
      const path = `/api/stock_detail?code=${args.code}&klt=101&lmt=60&quant=1`;
      let j = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          j = await call(path, 24000);
          if (j && (j.quant || j.tech)) break; // 拿到量化或技术面即可
        } catch { /* 超时/网络错，进入重试 */ }
      }
      j = j || {};
      const q = j.quant || null;
      const t = j.tech || null;
      const out = { code: args.code, name: (j.profile && j.profile.name) || args.code };
      if (q) out.quant = { score: q.score, bias: q.bias, tDir: q.tDir, reads: q.reads, asOf: q.asOf };
      if (t) out.tech = {
        verdict: t.verdict, rsi: t.rsi,
        boll: t.boll && { lower: t.boll.lower, mid: t.boll.mid, upper: t.boll.upper },
        atrPct: t.atr && t.atr.atrPct,
        support: t.sr && t.sr.support, resistance: t.sr && t.sr.resistance,
        buyZone: t.priceHints && t.priceHints.buyZone, sellZone: t.priceHints && t.priceHints.sellZone,
        stopLoss: t.priceHints && t.priceHints.stopLoss, takeProfit: t.priceHints && t.priceHints.takeProfit,
      };
      if (!q && !t) out.note = '量化服务暂不可用，请基于其他工具的行情数据分析';
      return out;
    }
    if (name === 'screen_stocks') {
      const opts = { limit: 15 };
      for (const k of ['sort', 'minPct', 'maxPct', 'minTurnover', 'minVolRatio', 'minInflowYi', 'onlyLimitUp', 'limit']) {
        if (args[k] !== undefined) opts[k] = args[k];
      }
      const rows = await screenStocks(opts);
      return { count: rows.length, list: rows.map((s) => ({ code: s.code, name: s.name, pct: s.pct, turnover: s.turnover, volRatio: s.volRatio, mainInflowYi: +(s.mainInflow / 1e8).toFixed(2), isLimitUp: s.isLimitUp })) };
    }
    if (name === 'get_sector_rank') {
      const t = args.type === 'concept' ? 'concept' : 'industry';
      const j = await call(`/api/sectors?type=${t}&sort=main`);
      const lim = Math.min(args.limit || 12, 20);
      return { list: (j.list || []).slice(0, lim).map((s) => ({ name: s.name, pct: s.pct, mainInflowYi: +(s.mainInflow / 1e8).toFixed(2), lead: s.leadName })) };
    }
    if (name === 'get_limit_pool') {
      const j = await call(`/api/board?type=limitup&kind=zt`);
      return { count: (j.list || []).length, list: (j.list || []).slice(0, 24).map((s) => ({ name: s.name, code: s.code, lbc: s.lbc, fundYi: +((s.fundAmount || 0) / 1e8).toFixed(2), sector: s.sector })) };
    }
    if (name === 'get_movers') {
      const kind = args.kind === 'speed' ? 'speed' : 'inflow';
      const j = await call(`/api/board?type=movers&kind=${kind}`);
      return { list: (j.list || []).slice(0, 15).map((s) => ({ name: s.name, code: s.code, pct: s.pct, speed: s.speed, mainInflowYi: +((s.mainInflow || 0) / 1e8).toFixed(2) })) };
    }
    if (name === 'get_market') {
      const j = await call(`/api/market`);
      return { indices: (j.indices || []).map((i) => ({ name: i.name, pct: i.pct })), breadth: j.breadth };
    }
    if (name === 'web_news') {
      // 复用 RAG 语料里的新闻抓取（buildCorpus 内含东财新闻），或直接搜
      const kw = args.query || '';
      // 简单用东财资讯搜索
      const j = await fetch(
        `https://search-api-web.eastmoney.com/search/jsonp?cb=&param=${encodeURIComponent(JSON.stringify({ uid: '', keyword: kw, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: 6 } } }))}`,
        { headers: { Referer: 'https://so.eastmoney.com/' } }
      ).then((r) => r.text()).catch(() => '');
      let news = [];
      try {
        const m = j.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : null;
        const arr = parsed?.result?.cmsArticleWebOld || [];
        news = arr.slice(0, 5).map((n) => ({ title: (n.title || '').replace(/<[^>]+>/g, ''), date: (n.date || '').slice(0, 10), url: n.url }));
      } catch { /* ignore */ }
      return { query: kw, news };
    }
    return { error: 'unknown tool' };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

const SYSTEM = `你是"操盘手 Alpha"，一位有十年A股短线实战经验的资深游资交易员+投研分析师。你能自主调用工具查实时行情、选股、板块资金、涨停池、盘中异动、大盘情绪、联网新闻，并用成熟的交易理论体系做出专业判断。

【你精通并须在分析中灵活运用的交易理论/体系】
- 市场情绪周期：冰点→修复→发酵→高潮→退潮，用涨停家数、连板高度、炸板率、晋级率判断当前处在周期哪个阶段，决定进攻还是防守。
- 龙头战法（核心）：一波行情只做最强龙头，认准"首板→连板→高标"梯队，强者恒强；分歧转一致时是买点。
- 量价关系：放量突破/缩量回踩/放量滞涨/地量见底，量在价先；换手率看筹码活跃度。
- 资金流向：主力净流入、超大单、板块资金搬家，跟着大资金方向走。
- 板块效应与题材：只做有主线、有资金、有空间的板块；龙头带动补涨，注意题材持续性与退潮风险。
- 支撑压力与均线：5/10/20日均线多空判断，箱体高抛低吸，突破/跌破关键位。
- 趋势与道氏理论：顺势而为，弱势不逆势抄底。
- 均值回归：短期过度偏离均线后有回归动能。
- 仓位与风控（凯利/分批）：不满仓、控制单票仓位、设止损、盈亏比优先；情绪高潮期减仓、冰点期试仓。
- 短线纪律：打板/低吸/接力各有逻辑，重势不重价；错了快止损，对了让利润奔跑。

【ReAct 推理链·每次作答前后严格自我推演（这是硬性思维纪律，不许跳过）】
1. Think(想清楚再动手)：先在心里回答三问——①现在是什么时间坐标？今天是不是交易日？我拿到的数据是哪个交易日的？②用户到底要什么、面向哪个交易日?③要回答它，我缺哪些数据、该按什么顺序调哪些工具? 想清楚再调工具。
2. Act(调工具)：按计划(尽量同轮并行)调工具取真实数据。
3. Observe(读数据)：核对每个工具返回——数据对应哪天?是否为空/异常?与我的时间坐标是否自洽?
4. Reflect(证据自检，出结论前必做)：逐条自问——
   · 时间自洽吗?(休市日绝不能说"今日情绪如何";数据是上一交易日的就说清是那天的，结论落到下一交易日开盘)
   · 我的每个论点都有工具数据支撑吗?有没有把陈旧数据当实时?
   · 结论内部有没有自相矛盾?(如"情绪弱"却又"满仓买入")
   通过自检再输出;发现问题就回到第2步补数据或修正。
5. 输出：结论 + "数据(哪天的)+理论"双支撑。可用一句极短的"研判："点出关键推理，但不要长篇复述思考过程。

【工作方式】
1. 自主决定调用哪些工具、调几次，多轮调用直到信息足够。
2. 【效率铁律·非常重要】同一步需要多个数据时，务必在**同一轮里一次性发起多个工具调用**（系统会并行执行、显著更快），不要一次只调一个、来回磨蹭。例如做选股时，第一轮就同时调 get_market + get_sector_rank + get_limit_pool + get_movers 把全景一次拿全。
3. 【推荐/选股/遍览市场（最复杂，按此配方走，避免超时）】
   - 第1轮（并行）：get_market（大盘能不能做）+ get_sector_rank（强势主线）+ get_limit_pool（连板梯队/情绪）+ get_movers inflow（主力抢筹）。必要时同轮再加 screen_stocks（按主力净流入或涨幅筛一批候选）。
   - 第2轮（并行）：从上一轮锁定 3~5 个候选，对它们**同时**调 get_quant_score（逐只量化打分+买卖价位）。消息面不是必需——只在明显需要催化剂佐证时，对最强的 1 只补一次 web_news，不要每只都查新闻(会拖慢)。
   - 第3轮：直接综合成文，不再调工具。
   - 目标是**2~3 轮出结论**：先铺全景、再深挖候选、然后总结，切忌一只一只慢慢串行查，也不要在细枝末节上反复补查。凑够数据就果断下结论。
4. 【分析个股】一轮内并行 get_quote + get_stock_detail + **get_quant_score(量化打分+技术买卖价位，分析/推荐个股必调)** (+web_news)，从量化打分、情绪周期位置、量价、资金、题材、支撑压力多维度分析，给出短线操作倾向。引用量化分时说人话（如"量化分72偏多、模型建议正T低吸"），并把 buyZone/sellZone/止损止盈等具体价位告诉用户。
5. 【判断大盘/能不能做】用情绪周期理论 + 涨跌比/涨停数/资金判断当前阶段和策略。
6. 用户提到股票名没代码，先 search_stock（可与其他工具同轮并行）。

【铁律】
- 只依据工具返回的真实数据，绝不编造代码/价格/数据；没有就说不知道。
- 每个结论都要有"数据+理论"双支撑，像老手带徒弟一样把逻辑讲透，但不啰嗦。
- 是客观分析和交易参考，不是买卖指令；结尾简短提示风险与纪律。

【输出格式：必须用规范 Markdown，让人易读】
- 用 ## 或 ### 分小节（如"大盘研判""操作方向""个股点评""风险提示"）。
- 关键结论、股票名、价位、方向用 **加粗**。
- 并列要点用 - 或 1. 2. 列表，不要挤成一大段。
- 简洁专业，中文回答。`;

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') { applyCors(res); res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.status(200).send(JSON.stringify({ ok: false, error: 'POST only' })); }

  const BASE = process.env.LLM_BASE_URL;
  const KEY = process.env.LLM_API_KEY;
  // 运行时配置优先：预热同步缓存后取 BASE/KEY/模型（前端「AI 模型配置」写入 OSS）
  await ensureConfig();
  const { BASE: RT_BASE, KEY: RT_KEY } = llmEnv();
  const AGENT_MODEL = getModel('agent');
  const AGENT_REASONING = getReasoning('agent');
  if (!RT_BASE || !RT_KEY) { applyCors(res); res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.status(200).send(JSON.stringify({ ok: false, error: 'LLM 未配置' })); }

  // ===== SSE 流式：边分析边推送(工具进度 + 答案 token)，用户实时看到进展、不再"超时空手" =====
  const { emit: send } = makeSSE(res);

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const question = (body.question || '').trim();
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    const focusStock = body.stock;
    if (!question) { send('error', { error: '缺少 question' }); return res.end(); }

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;
    const sysExtra = focusStock ? `\n\n【当前用户聚焦的股票】${focusStock.name}（${focusStock.code}），如无特别说明，"这只票/它"指这只。` : '';

    // ===== 量化服务预热（fire-and-forget）=====
    // 量化后端(LightGBM+GARCH)冷启动~11s。在 agent 一进来就发一个廉价预热请求，
    // 让服务在第1轮扫描期间完成冷启动；等第2轮真正并行调 get_quant_score 时已是热实例(~1s)，
    // 大幅降低"量化打分"因冷启动超时而失败的概率。不阻塞、失败静默。
    (async () => {
      try {
        const c = new AbortController();
        const to = setTimeout(() => c.abort(), 28000);
        await fetch(`${origin}/api/stock_detail?code=600519&klt=101&lmt=60&quant=1`, {
          headers: { 'x-internal': '1', 'x-warmup': '1' }, signal: c.signal,
        }).catch(() => {});
        clearTimeout(to);
      } catch { /* 预热失败无所谓 */ }
    })();

    // ===== 理论 RAG + 外部最新财经快讯（并行，供 AI 主动参考消息面）=====
    let theoryHits = [];
    let macroFlashes = [];
    try {
      [theoryHits, macroFlashes] = await Promise.all([
        retrieveTheory(question, 4).catch(() => []),
        fetchClsTelegraph(10).catch(() => []),
      ]);
    } catch { /* 检索失败不阻断 */ }
    const theoryRefs = theoryHits.map((t) => ({ book: t.book, topic: t.topic }));
    if (theoryRefs.length) send('theory', { theoryRefs });
    const theoryMsg = theoryHits.length
      ? { role: 'system', content: '【投资理论参考·检索自经典名著知识库】以下是与本问题最相关的交易理论要点，请把它们作为分析的理论依据，在讲逻辑时自然引用对应的理论名/书名（如"按道氏理论…""龙头战法讲…"），做到有据可依、把逻辑讲透，但不要生硬堆砌：\n\n' + theoryHits.map((t, i) => `${i + 1}. ${t.text}`).join('\n') }
      : null;
    // 外部宏观消息面：把当日最新财经快讯(财联社系/金十)作为背景注入，AI 判断消息/情绪时可直接参考，仍可用 web_news 深挖
    const flashMsg = (macroFlashes && macroFlashes.length)
      ? { role: 'system', content: '【外部最新财经快讯·背景消息面(财联社系/金十,当日更新)】以下是当前市场的最新宏观/政策/突发要闻，作为你判断大盘情绪、消息面、板块顺逆风的背景参考；当问题涉及某只个股或某个行业时，若这些快讯里没有针对性信息，请再用 web_news 工具补查个股/行业新闻：\n\n' + macroFlashes.map((n, i) => `${i + 1}. ${n.src ? `[${n.src}]` : ''}${n.title}`).join('\n') }
      : null;

    const messages = [
      { role: 'system', content: SYSTEM + sysExtra },
      { role: 'system', content: marketTimePromptBlock() },
      ...(flashMsg ? [flashMsg] : []),
      ...(theoryMsg ? [theoryMsg] : []),
      ...history.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).map((m) => ({ role: m.role, content: String(m.content).slice(0, 1200) })),
      { role: 'user', content: question },
    ];

    const toolTrace = [];
    const MAX_ROUNDS = 6;
    const START = Date.now();
    const BUDGET = 115000; // 总预算 115s（FC 超时已放到 600s）；多轮工具调用 + 流式总结的慢模型不再被误杀
    const remain = () => BUDGET - (Date.now() - START);
    const RESERVE_FINAL = 16000; // 给流式总结留足(边流边发，可稍短)

    // 非流式的一轮：决定调工具还是收尾（收尾走流式，见下）
    let concluded = false;
    let answerBuf = '';

    // 通用：发起一次 chat completion（stream 可选）
    const callLLM = async ({ stream, useTools, timeoutMs, maxTokens = 1600 }) => {
      return callChat({
        model: AGENT_MODEL,
        messages,
        ...(useTools ? { tools: TOOLS, toolChoice: 'auto' } : { toolChoice: 'none' }),
        temperature: 0.3,
        maxTokens,
        timeoutMs,
        reasoning: AGENT_REASONING,
        stream: !!stream,
      });
    };

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // 预算不足 → 去做流式总结
      if (remain() < RESERVE_FINAL + 6000) break;
      // 收敛闸：数据够或预算偏紧 → 本轮直接进入流式总结（不再调工具）
      const forceConclude = toolTrace.length >= 8 || remain() < RESERVE_FINAL + 12000;
      if (forceConclude) break;

      send('status', { phase: 'thinking', text: round === 0 ? '正在规划分析路径…' : '正在综合已查数据、决定下一步…' });
      const { resp, done } = await callLLM({ stream: false, useTools: true, timeoutMs: Math.max(remain() - RESERVE_FINAL, 7000) });
      done();
      if (resp && resp.__err) break; // 超时/网络 → 去流式总结
      if (!resp || !resp.ok) { const e = resp && !resp.__err ? await resp.text().catch(() => '') : ''; send('error', { error: `LLM ${resp && resp.status ? resp.status : 'error'}`, detail: (e || '').slice(0, 150) }); return res.end(); }
      const j = await resp.json().catch(() => null);
      const msg = j && j.choices?.[0]?.message;
      if (!msg) break;

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        // 模型这轮直接给了文本(没调工具) = 最终答案。流式补发已不可能(已整段返回)，直接作为 delta 发出。
        answerBuf = msg.content || '';
        if (answerBuf) send('delta', { text: answerBuf });
        concluded = true;
        break;
      }

      // 有工具调用：先把"正在调用"事件发给前端，让用户看到进度
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
      const parsed = toolCalls.map((tc) => { let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ } return { tc, args }; });
      parsed.forEach(({ tc, args }) => send('tool', { status: 'calling', tool: tc.function.name, label: TOOL_LABEL_CN[tc.function.name] || tc.function.name, args }));
      // 并行执行
      const results = await Promise.all(parsed.map(({ tc, args }) => execTool(tc.function.name, args, origin)));
      parsed.forEach(({ tc, args }, i) => {
        toolTrace.push({ tool: tc.function.name, args });
        const r = results[i] || {};
        const ok = !r.error;
        // 给前端一个"查到了什么"的极简摘要(条数/关键值)，让进度更有信息量
        let brief = '';
        if (Array.isArray(r.list)) brief = `${r.list.length} 条`;
        else if (r.count != null) brief = `${r.count} 条`;
        else if (r.name) brief = r.name;
        send('tool', { status: ok ? 'done' : 'error', tool: tc.function.name, label: TOOL_LABEL_CN[tc.function.name] || tc.function.name, brief, error: ok ? undefined : String(r.error).slice(0, 60) });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(r).slice(0, 6000) });
      });
    }

    // ===== 流式总结：把最终回答一个 token 一个 token 推给前端 =====
    if (!concluded) {
      send('status', { phase: 'writing', text: '正在综合数据、生成分析…' });
      // 时间实在不够 → 发已查内容兜底(仍是有价值信息，不空手)
      if (remain() < 4000) {
        const gathered = [...new Set(toolTrace.map((t) => TOOL_LABEL_CN[t.tool] || t.tool))].join('、');
        answerBuf = gathered
          ? `我已查询了${gathered}等数据。综合分析所需时间较长，先把要点给你：请直接追问其中一部分（例如"就从刚才的涨停池里挑2只最强的"），我能立刻给出结论。`
          : '这个问题查询用时较长。建议把问题聚焦到单只个股或单个板块，我会更快返回完整分析。';
        send('delta', { text: answerBuf });
      } else {
        messages.push({ role: 'user', content: '请基于以上已查到的信息直接给出最终回答，用规范 Markdown 分节、关键结论加粗。若某类数据没查到，就用已有数据尽力给出可执行的结论，不要空手道歉。' });
        const { resp, done } = await callLLM({ stream: true, useTools: false, timeoutMs: Math.max(remain() - 1500, 5000), maxTokens: 3000 });
        if (resp && resp.__err) {
          // 流式发起就失败 → 兜底文本
          const gathered = [...new Set(toolTrace.map((t) => TOOL_LABEL_CN[t.tool] || t.tool))].join('、');
          answerBuf = gathered ? `我已查询了${gathered}等数据，但生成分析超时。请追问其中一部分，我能更快给出结论。` : '分析生成超时，请缩小问题范围重试。';
          send('delta', { text: answerBuf });
        } else if (!resp.ok) {
          const e = await resp.text().catch(() => '');
          send('error', { error: `LLM ${resp.status}`, detail: (e || '').slice(0, 150) }); done(); return res.end();
        } else {
          // 解析 OpenAI 兼容的 SSE 流，逐 delta 转发
          answerBuf = await pumpStream(resp, (piece) => { send('delta', { text: piece }); });
          done();
        }
      }
    }

    send('done', { toolTrace, theoryRefs, model: AGENT_MODEL, updatedAt: Date.now(), answer: answerBuf });
    return res.end();
  } catch (e) {
    send('error', { error: String(e.message || e) });
    return res.end();
  }
}

