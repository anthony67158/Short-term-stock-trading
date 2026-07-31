import { emGet, num } from './_lib.js';
import { buildCorpus } from './_rag.js';
import { retrieveTheory } from './_kb.js';
import { screenStocks } from './_screen.js';

// ============ 股票 Agent：工具增强的智能体 ============
// LLM 自主调用 skill 工具（查行情/选股/板块/涨停/异动/新闻…）多轮后综合作答
// 用支持 function calling 的模型（Qwen3-Max-A）

const AGENT_MODEL = process.env.AGENT_MODEL || 'Qwen3-Max-A';

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
  const call = async (pathname) => {
    const r = await fetch(origin + pathname, { headers: { 'x-internal': '1' } });
    return r.json();
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
      const j = await call(`/api/stock_detail?code=${args.code}&klt=101&lmt=60&quant=1`);
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(200).send(JSON.stringify({ ok: false, error: 'POST only' }));

  const BASE = process.env.LLM_BASE_URL;
  const KEY = process.env.LLM_API_KEY;
  if (!BASE || !KEY) return res.status(200).send(JSON.stringify({ ok: false, error: 'LLM 未配置' }));

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const question = (body.question || '').trim();
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    const focusStock = body.stock; // 可选：当前聚焦个股 {code,name}
    if (!question) return res.status(200).send(JSON.stringify({ ok: false, error: '缺少 question' }));

    // 内部 API origin（同域）
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;

    const sysExtra = focusStock ? `\n\n【当前用户聚焦的股票】${focusStock.name}（${focusStock.code}），如无特别说明，"这只票/它"指这只。` : '';

    // ===== 理论 RAG：检索相关投资理论/名著知识块，注入对话 =====
    let theoryHits = [];
    try { theoryHits = await retrieveTheory(question, 4); } catch { /* 检索失败不阻断 */ }
    const theoryMsg = theoryHits.length
      ? {
          role: 'system',
          content:
            '【投资理论参考·检索自经典名著知识库】以下是与本问题最相关的交易理论要点，请把它们作为分析的理论依据，'
            + '在讲逻辑时自然引用对应的理论名/书名（如"按道氏理论…""龙头战法讲…"），做到有据可依、把逻辑讲透，但不要生硬堆砌：\n\n'
            + theoryHits.map((t, i) => `${i + 1}. ${t.text}`).join('\n'),
        }
      : null;

    const messages = [
      { role: 'system', content: SYSTEM + sysExtra },
      ...(theoryMsg ? [theoryMsg] : []),
      ...history.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).map((m) => ({ role: m.role, content: String(m.content).slice(0, 1200) })),
      { role: 'user', content: question },
    ];

    const toolTrace = []; // 记录调用了哪些工具，回传前端展示
    const theoryRefs = theoryHits.map((t) => ({ book: t.book, topic: t.topic })); // 命中的理论，回传前端
    // 复杂选股/遍览类问题需要更多步(板块→涨停→异动→筛选→逐只量化)，轮次给足；
    // 靠"同一轮工具并行 + 缩短最终总结预留"把时间挤出来，而不是靠减轮次。
    const MAX_ROUNDS = 6;

    // ===== 全局时间预算：Vercel maxDuration=60s，留足余量在 56s 内必须返回 JSON =====
    const START = Date.now();
    const BUDGET = 56000;           // 总预算
    const remain = () => BUDGET - (Date.now() - START);
    const RESERVE_FINAL = 14000;    // 为"最终总结"预留(单次总结一般 8~12s，14s 足够且不浪费轮次)

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // 预算不足以再跑一轮带工具的对话（需给最终总结留时间）→ 提前跳出去做总结
      if (remain() < RESERVE_FINAL + 6000) break;

      // 收敛闸：已积累足够数据(≥8次工具调用)或预算偏紧时，本轮禁用工具、强制模型出结论，
      // 避免"无止境地再查一点"把时间耗光，导致复杂问题永远等不到最终答案。
      const forceConclude = toolTrace.length >= 8 || remain() < RESERVE_FINAL + 14000;

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), Math.max(remain() - RESERVE_FINAL, 7000));
      const resp = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AGENT_MODEL,
          messages,
          ...(forceConclude ? { tool_choice: 'none' } : { tools: TOOLS, tool_choice: 'auto' }),
          temperature: 0.3,
          max_tokens: 1600,
        }),
      }).catch((e) => ({ __err: e })); // abort/网络错误不抛出，转入最终总结兜底
      clearTimeout(t);
      if (resp && resp.__err) break; // 本轮超时/失败 → 跳出用已有信息总结
      if (!resp.ok) {
        const e = await resp.text();
        return res.status(200).send(JSON.stringify({ ok: false, error: `LLM ${resp.status}`, detail: e.slice(0, 150) }));
      }
      const j = await resp.json();
      const msg = j.choices?.[0]?.message;
      if (!msg) return res.status(200).send(JSON.stringify({ ok: false, error: '无返回' }));

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        // 无工具调用 = 最终回答
        return res.status(200).send(JSON.stringify({
          ok: true, answer: msg.content || '', toolTrace, theoryRefs, model: AGENT_MODEL, updatedAt: Date.now(),
        }));
      }

      // 有工具调用：把本轮所有工具【并行】执行(选股类一轮常并发查多只票/多个榜单，
      // 并行相比串行能省数倍时间，换来更多可用轮次)，全部完成后塞回对话继续下一轮。
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
      const parsed = toolCalls.map((tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        return { tc, args };
      });
      const results = await Promise.all(parsed.map(({ tc, args }) => execTool(tc.function.name, args, origin)));
      parsed.forEach(({ tc, args }, i) => {
        toolTrace.push({ tool: tc.function.name, args });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(results[i]).slice(0, 6000),
        });
      });
    }

    // 达到最大轮次或预算不足，用剩余时间强制让模型基于已查信息总结（不再给工具）
    // 已调用过的工具清单——即便总结超时，也能告诉用户"已经查到了什么"，而非纯道歉。
    const gathered = [...new Set(toolTrace.map((t) => TOOL_LABEL_CN[t.tool] || t.tool))].join('、');
    const partialHint = gathered
      ? `我已查询了${gathered}等数据，但综合分析用时超出限制未能完成。你可以直接追问其中一部分（比如"就从刚才的涨停池里挑2只最强的"），我能更快给出结论。`
      : '这个问题查询用时较长，分析未能在限定时间内完成。建议把问题聚焦到单只个股或单个板块，我会更快返回完整分析。';
    if (remain() < 4000) {
      // 时间已所剩无几，直接返回带"已查内容"的兜底文本，避免被平台强杀返回非 JSON
      return res.status(200).send(JSON.stringify({
        ok: true, answer: partialHint, toolTrace, theoryRefs, model: AGENT_MODEL, updatedAt: Date.now(),
      }));
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(remain() - 1500, 4000));
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AGENT_MODEL, messages: [...messages, { role: 'user', content: '请基于以上已查到的信息直接给出最终回答，用规范 Markdown 分节，关键结论加粗。若某类数据没查到，就用已有数据尽力给出可执行的结论，不要空手道歉。' }], temperature: 0.3, max_tokens: 1600 }),
    }).catch((e) => ({ __err: e }));
    clearTimeout(t);
    if (resp && resp.__err) {
      return res.status(200).send(JSON.stringify({
        ok: true, answer: partialHint, toolTrace, theoryRefs, model: AGENT_MODEL, updatedAt: Date.now(),
      }));
    }
    const j = await resp.json();
    return res.status(200).send(JSON.stringify({
      ok: true, answer: j.choices?.[0]?.message?.content || '（信息较多，请缩小问题范围再试）', toolTrace, theoryRefs, model: AGENT_MODEL, updatedAt: Date.now(),
    }));
  } catch (e) {
    res.status(200).send(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}
