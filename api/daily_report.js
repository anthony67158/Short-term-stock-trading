import { put, list, readJson, hasStorage } from './_blob.js';
import { emGet, num, preflight, applyCors } from './_lib.js';
import { authorizePaidRequest } from './_account_auth.js';
import { marketTimePromptBlock } from './_market_time.js';
import {
  fetchAIndices,
  fetchFinnhubNews,
  fetchMarketFlashes,
  fetchNews,
  fetchOverseas,
  fetchStockNews,
} from './_market_data.js';
import {
  buildDailySummary,
  dailyReportCacheKey,
  isCompleteDailyReport,
} from './_daily_summary.js';
import {
  llmReady,
  makeSSE,
  callChat,
  parseLLMJson,
} from './_llm.js';
import { ensureConfig, getModel } from './_llm_config.js';
import {
  fetchAiSearchReference,
} from './_ai_search.js';
import { ensureAiSearchConfig } from './_ai_search_config.js';
import {
  DAILY_REPORT_SEARCH_PLAN_VERSION,
  buildDailyEvidenceBundle,
  buildDailyReportSearchPlans,
  composeDailyReport,
  dailyReportGroundingIssues,
  generateDailyReportDraft,
  isValuableDailyReport,
} from './_daily_report_content.js';

// ============ 全市场投资策略日报（早/午/晚三场次，SSE 流式 + Blob 缓存）============
// POST /api/daily_report?session=morning|noon|evening[&refresh=1]
// 登录请求从服务端账号读取持仓/自选；可信 Worker 可传 holdings/watchlist。
// 公告、行情、行业新闻和豆包搜索先形成证据包，LLM 只负责受约束的研判。

function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000); }
function bjDayKey() { const d = nowBJ(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function bjMinutes() { const d = nowBJ(); return d.getHours() * 60 + d.getMinutes(); }
// 按当前时刻自动判定默认场次：<11:30 早报 / 11:30-15:00 午报 / >=15:00 晚报
function autoSession() { const hm = bjMinutes(); if (hm < 690) return 'morning'; if (hm < 900) return 'noon'; return 'evening'; }
const SESSION_CN = { morning: '盘前早报', noon: '午间午报', evening: '收盘晚报' };
export function dailyReportAccountNick(accountAuth, body = {}) {
  if (accountAuth?.account?.nick) {
    return String(accountAuth.account.nick).trim();
  }
  if (!accountAuth?.trusted) return '';
  const nick = String(body?.accountNick || '').trim();
  return nick && nick.length <= 80 ? nick : '';
}

function cleanFocusStock(item, scope) {
  const code = String(item?.code || '').trim();
  if (!/^\d{6}$/.test(code)) return null;
  const clean = (value, limit) => String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
  return {
    code,
    name: clean(item?.name || code, 40) || code,
    industry: clean(item?.industry, 40),
    concept: clean(item?.concept, 40),
    scope,
    star: item?.star === true,
  };
}

export function dailyReportFocusStocks(accountAuth, body = {}) {
  const accountData = accountAuth?.account?.data;
  const holdings = accountData
    ? accountData.holding
    : body.holdings;
  const watchlist = accountData
    ? accountData.plan
    : body.watchlist;
  const seen = new Set();
  const result = [];
  const add = (item, scope) => {
    const stock = cleanFocusStock(item, scope);
    if (!stock || seen.has(stock.code)) return;
    seen.add(stock.code);
    result.push(stock);
  };
  (Array.isArray(holdings) ? holdings : []).forEach((item) =>
    add(item, 'holding')
  );
  (Array.isArray(watchlist) ? watchlist : [])
    .slice()
    .sort((left, right) => Number(right?.star) - Number(left?.star))
    .forEach((item) => add(item, 'watchlist'));
  return result.slice(0, 12);
}

// 策略日报使用独立 daily 角色端点，不与智能体助手争抢连接。

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
  const accountAuth = await authorizePaidRequest(req);
  if (!accountAuth.ok) {
    applyCors(res);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(accountAuth.error === '请先登录' ? 401 : 403)
      .send(JSON.stringify({ ok: false, error: accountAuth.error }));
  }
  await ensureConfig();               // 预热运行时配置（前端可改 Base/Key/模型）
  const aiSearchConfig = await ensureAiSearchConfig();
  const MODEL = getModel('daily');
  const { emit, phase, stopHeartbeat } = makeSSE(res); // makeSSE 内已统一应用 CORS
  // 双重 end 兜底:任何分支只要调用 endOnce 即可,重复调用无副作用(避免 "write after end" 崩溃)
  let ended = false;
  const endOnce = () => { if (ended) return; ended = true; try { stopHeartbeat && stopHeartbeat(); } catch { /* ignore */ } try { res.end(); } catch { /* 连接已断 */ } };

  try {
    let body = req.body; if (typeof body === 'string') body = JSON.parse(body || '{}');
    const START = Date.now();
    const BUDGET = 115000;
    const remain = () => BUDGET - (Date.now() - START);
    const focusStocks = dailyReportFocusStocks(accountAuth, body);
    const session = (req.query.session && SESSION_CN[req.query.session]) ? req.query.session : autoSession();
    const refresh = req.query.refresh === '1';
    const day = bjDayKey();
    const hasBlob = hasStorage();
    const accountNick = dailyReportAccountNick(accountAuth, body);
    if (!accountNick) {
      emit('result', {
        ok: false,
        error: '策略日报缺少账号作用域',
      });
      return endOnce();
    }
    const accountCacheKey = dailyReportCacheKey(day, session, accountNick);

    // 1) 命中缓存(同日同场次且非强制刷新)→ 直接返回
    if (hasBlob && !refresh) {
      try {
        const { blobs } = await list({ prefix: accountCacheKey, limit: 5 });
        if (blobs.length) {
          const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
          const cached = await readJson(latest);
          if (
            cached
            && isCompleteDailyReport(cached)
            && cached.searchEnabled === aiSearchConfig.enabled
            && Number(cached.searchConfigUpdatedAt || 0) === Number(aiSearchConfig.updatedAt || 0)
            && Number(cached.searchPlanVersion || 0)
              === DAILY_REPORT_SEARCH_PLAN_VERSION
          ) {
            emit('result', { ok: true, cached: true, ...cached });
            return endOnce();
          }
        }
      } catch { /* 无缓存继续生成 */ }
    }

    const dailyLlmReady = llmReady('daily');

    // 2) 并行抓全市场数据
    phase(
      aiSearchConfig.enabled === true
        && String(aiSearchConfig.apiKey || '').trim()
        ? '正在采集市场数据并调用豆包搜索补盲…'
        : '正在采集 A股板块资金 / 涨停 / 指数…',
    );
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;
    const getJ = (p) => { const c = new AbortController(); const to = setTimeout(() => c.abort(), 8000); return fetch(origin + p, { headers: { 'x-internal': '1' }, signal: c.signal }).then((r) => r.json()).catch(() => null).finally(() => clearTimeout(to)); };
    const searchPlans = buildDailyReportSearchPlans({
      day,
      session,
      focusStocks,
      industries: focusStocks.flatMap((item) => [
        item.industry,
        item.concept,
      ]),
    });

    const [
      sectors,
      aIdx,
      overseas,
      limitPool,
      sectorNews,
      macroNews,
      focusStockNews,
      holdingQuotes,
      marketFlashes,
      finnhubNews,
      searchResults,
    ] = await Promise.all([
      getJ('/api/sectors?type=industry&sort=main'),
      fetchAIndices(emGet, num),
      fetchOverseas(),
      getJ('/api/board?type=limitup&kind=zt'),
      Promise.all(SECTORS.map((sector) =>
        fetchNews(sector.kw, 3).then((news) => ({
          key: sector.key,
          name: sector.name,
          keywords: sector.kw.split(/\s+/).filter(Boolean),
          news,
        }))
      )),
      fetchNews('宏观 政策 央行 A股 美联储 关税', 6),
      focusStocks.length
        ? Promise.all(focusStocks.map((stock) =>
            fetchStockNews(
              stock.name || stock.code,
              5,
              stock.code,
            ).then((news) => ({ ...stock, news }))
          ))
        : Promise.resolve([]),
      focusStocks.length ? getJ(`/api/quote?codes=${focusStocks.map((stock) => stock.code).join(',')}&_t=${Date.now()}`) : Promise.resolve(null),
      fetchMarketFlashes(18),
      fetchFinnhubNews(6),
      Promise.all(searchPlans.map(async (plan) => ({
        ...plan,
        result: await fetchAiSearchReference({
          query: plan.query,
          cacheScope: plan.cacheScope,
          cacheKey: plan.cacheKey,
          cacheMinutes: plan.cacheMinutes,
        }, {
          runtimeConfig: aiSearchConfig,
          topK: plan.topK,
        }),
      }))),
    ]);
    const overseasSafe = (overseas && typeof overseas === 'object') ? overseas : {};
    if (!Array.isArray(overseasSafe.indices)) overseasSafe.indices = [];
    if (!Array.isArray(overseasSafe.commodities)) overseasSafe.commodities = [];

    const slist = (sectors && sectors.list) || [];
    const sSorted = [...slist].sort((a, b) => b.mainInflow - a.mainInflow);
    const yi = (v) => +(v / 1e8).toFixed(2);
    const sectorFlow = {
      top: sSorted.slice(0, 8).map((s) => ({ name: s.name, pct: s.pct, inflowYi: yi(s.mainInflow), lead: s.leadName })),
      bottom: sSorted.slice(-6).reverse().map((s) => ({ name: s.name, pct: s.pct, inflowYi: yi(s.mainInflow) })),
    };
    const limitCount = ((limitPool && limitPool.list) || []).length;

    const hqMap = {};
    const marketNumber = (value) => {
      if (value == null || value === '' || value === '-') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    ((holdingQuotes && holdingQuotes.list) || []).forEach((q) => {
      if (!q || !q.code) return;
      const pct = marketNumber(q.pct);
      hqMap[q.code] = {
        现价: marketNumber(q.price),
        今日涨跌幅: pct,
        状态: q.isLimitUp
          ? '今日涨停'
          : q.isLimitDown
            ? '今日跌停'
            : pct == null
              ? '行情涨跌数据缺失'
              : pct >= 7
                ? '今日大涨'
                : pct <= -7
                  ? '今日大跌'
                  : pct >= 0 ? '今日上涨' : '今日下跌',
        量比: q.volRatio ?? null,
        换手率: q.turnover ?? null,
      };
    });

    const dataBlock = {
      session: SESSION_CN[session], day,
      aIndices: aIdx, overseas: overseasSafe.indices, commodities: overseasSafe.commodities,
      sectorFlow, limitUpCount: limitCount,
      focusStocks: focusStocks.map((stock) => ({
        名称: stock.name,
        代码: stock.code,
        范围: stock.scope === 'holding' ? '持仓' : '自选',
        今日行情: hqMap[stock.code] || null,
      })),
    };
    const evidence = buildDailyEvidenceBundle({
      data: dataBlock,
      stockNews: focusStockNews,
      macroNews,
      marketFlashes: [
        ...(marketFlashes || []),
        ...(finnhubNews || []),
      ],
      sectorNews,
      searchResults,
    });
    const searchItems = evidence.items.filter((item) =>
      item.kind === 'doubao_search'
    );
    const searchReference = searchItems.length
      ? {
          dimension: 'search',
          label: '豆包检索参考',
          status: searchResults
            .map((item) => item.result?.status)
            .filter(Boolean)
            .join(','),
          fetchedAt: new Date().toISOString(),
          sources: searchItems.slice(0, 12),
        }
      : null;
    const sourcePayload = {
      ...dataBlock,
      evidence: evidence.items.map((item) => ({
        id: item.id,
        category: item.categoryLabel,
        title: item.title,
        summary: item.summary,
        source: item.src,
        date: item.date,
        evidenceLevel: item.evidenceLevel,
        stockCode: item.stockCode || undefined,
        sector: item.sector || undefined,
      })),
    };
    const SYS = `你是严谨的A股策略研究员。只依据给定证据撰写短线策略日报，不得补写未提供的事实、价格、公告或事件。公司公告和监管政策为一级证据，行情与权威媒体为交叉证据，豆包搜索摘要只能作为待核验线索。每条事件、个股和行业判断必须引用有效的证据编号E01、E02；证据冲突时明确写出冲突，不强行给方向。红涨绿跌。只输出合法JSON，不要输出markdown或思维链。`;
    const timeCtx = marketTimePromptBlock();
    phase(
      dailyLlmReady
        ? `已整理${evidence.stats.total}条证据，准备分段研判…`
        : `已整理${evidence.stats.total}条证据，正在生成规则化摘要…`,
    );
    const evidenceFor = (categories, limit = 22) =>
      evidence.items
        .filter((item) =>
          categories.includes(item.category)
          || item.evidenceLevel === 'primary'
        )
        .slice(0, limit)
        .map((item) => ({
          id: item.id,
          category: item.categoryLabel,
          title: item.title,
          summary: item.summary,
          source: item.src,
          date: item.date,
          evidenceLevel: item.evidenceLevel,
          stockCode: item.stockCode || undefined,
          sector: item.sector || undefined,
        }));
    const callPart = (
      payload,
      outputShape,
      requirements,
      maxTokens,
      required,
      maxAttempts = 2,
    ) =>
      generateDailyReportDraft(
        async (attempt, previousDraft) => {
          if (remain() < 12000) return null;
          const issues = attempt > 1
            ? dailyReportGroundingIssues(previousDraft, payload)
            : [];
          const retryNote = attempt > 1
            ? `\n上一次输出不合格：${issues.join('、') || '缺少字段'}。完整重写，不得使用证据包之外的数字或编号。`
            : '';
          const prompt = `${timeCtx}
【本期】${SESSION_CN[session]} · ${day}
【证据包】${JSON.stringify(payload)}

输出JSON：${outputShape}
要求：${requirements}
所有判断必须列出evidenceIds；只引用证据包现有编号和数字。${retryNote}`;
          const { resp, done } = await callChat({
            model: MODEL,
            role: 'daily',
            messages: [
              { role: 'system', content: SYS },
              { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            maxTokens,
            timeoutMs: Math.max(
              12000,
              Math.min(attempt === 1 ? 36000 : 28000, remain() - 4000),
            ),
            reasoning: false,
            forceNoReason: true,
            responseFormat: { type: 'json_object' },
          });
          if (!resp || resp.__err || !resp.ok) {
            done(false);
            return null;
          }
          const response = await resp.json().catch(() => null);
          const content = response?.choices?.[0]?.message?.content || '';
          const parsed = content.trim()
            ? parseLLMJson(content).value
            : null;
          const draft = parsed?.report || parsed;
          done(!!draft);
          return draft;
        },
        {
          maxAttempts,
          validate: (draft) =>
            required(draft)
            && dailyReportGroundingIssues(draft, payload).length === 0,
        },
      );
    const emptyGeneration = {
          draft: null,
          complete: false,
          attempts: 0,
          diagnostics: [{
            attempt: 0,
            parsed: false,
            complete: false,
            error: 'daily-role-unavailable',
          }],
        };
    const decisionPayload = {
      session: sourcePayload.session,
      day: sourcePayload.day,
      aIndices: sourcePayload.aIndices,
      overseas: sourcePayload.overseas,
      commodities: sourcePayload.commodities,
      sectorFlow: sourcePayload.sectorFlow,
      limitUpCount: sourcePayload.limitUpCount,
      evidence: evidenceFor(['market', 'macro', 'global'], 20),
    };
    const focusPayload = {
      session: sourcePayload.session,
      day: sourcePayload.day,
      focusStocks: sourcePayload.focusStocks,
      sectorFlow: sourcePayload.sectorFlow,
      evidence: evidenceFor(['company', 'industry'], 24),
    };
    phase(
      dailyLlmReady
        ? '正在核对重点个股公告与行业证据…'
        : '正在整理重点个股与行业证据…',
    );
    const focusGeneration = dailyLlmReady
      ? await callPart(
          focusPayload,
          '{"holdings":[{"code":"股票代码","name":"股票名称","info":"公告和重要信息摘要","impact":"对短线计划的影响","evidenceIds":["E01"]}],"sectors":[{"name":"板块名","rating":"看多|中性|看空","view":"证据结论","strategy":"操作条件","risk":"主要风险","evidenceIds":["E01"]}]}',
          'holdings逐一覆盖focusStocks中的持仓和自选；无新增公告就明确写无新增，不得从公告标题推断未披露的业绩数字或会议内容；行业最多6项。',
          2200,
          (draft) => !!(
            Array.isArray(draft?.sectors)
            && (
              !focusStocks.length
              || Array.isArray(draft?.holdings)
            )
          ),
          1,
        )
      : emptyGeneration;
    phase(
      dailyLlmReady
        ? '重点个股已核对，正在形成市场策略…'
        : '正在生成规则化市场策略…',
    );
    const coreGeneration = dailyLlmReady
      ? await callPart(
          decisionPayload,
          '{"overview":"市场总览","overseas":"海外与商品影响","events":[{"title":"重大事件","category":"公司公告|行业舆情|国内宏观|全球事件","impact":"对A股或相关行业的影响","evidenceIds":["E01"]}],"strategy":"仓位、节奏、主攻与回避条件","risks":["风险1","风险2"]}',
          '筛出最多5项真正影响未来1至5个交易日的事件；盘前核验隔夜与竞价，午间核验上午资金，收盘制定下一交易日预案；不得自创指数点位或仓位比例。',
          1800,
          (draft) => !!(
            String(draft?.overview || '').trim()
            && String(draft?.strategy || '').trim()
            && Array.isArray(draft?.events)
            && Array.isArray(draft?.risks)
          ),
        )
      : emptyGeneration;
    const draft = {
      ...(coreGeneration.complete ? coreGeneration.draft : {}),
      ...(focusGeneration.complete ? focusGeneration.draft : {}),
    };
    const draftResult = {
      draft,
      complete: coreGeneration.complete && focusGeneration.complete,
      attempts: coreGeneration.attempts + focusGeneration.attempts,
      diagnostics: [
        ...coreGeneration.diagnostics.map((item) => ({
          ...item,
          part: 'market',
        })),
        ...focusGeneration.diagnostics.map((item) => ({
          ...item,
          part: 'focus',
        })),
      ],
    };
    const composed = composeDailyReport({
      day,
      session,
      sessionCn: SESSION_CN[session],
      data: dataBlock,
      evidence,
      focusStocks,
      draft,
      generation: draftResult,
    });
    if (!isValuableDailyReport(composed)) {
      emit('result', {
        ok: false,
        code: 'DAILY_EVIDENCE_INSUFFICIENT',
        error: '日报核心证据不足，请稍后重试',
        diagnostics: composed.generation,
      });
      return endOnce();
    }

    const result = {
      ...composed,
      ok: true,
      cached: false,
      updatedAt: Date.now(),
      searchEnabled: aiSearchConfig.enabled === true,
      searchConfigUpdatedAt: Number(aiSearchConfig.updatedAt) || 0,
      searchPlanVersion: DAILY_REPORT_SEARCH_PLAN_VERSION,
      searchReference,
      data: dataBlock,
      newsRefs: evidence.items
        .filter((item) => item.url)
        .slice(0, 24),
    };
    // 精简摘要：供操作建议/复盘复用为"外部市场环境"(阶段2)
    result.summary = buildDailySummary(result);

    // 4) 写缓存
    if (hasBlob) {
      try { await put(`${accountCacheKey}-${Date.now()}.json`, JSON.stringify(result), { access: 'public', contentType: 'application/json', addRandomSuffix: true, cacheControlMaxAge: 0 }); } catch { /* ignore */ }
    }

    emit('result', result);
    return endOnce();
  } catch (e) {
    emit('result', { ok: false, error: String(e.message || e) });
    return endOnce();
  }
}
