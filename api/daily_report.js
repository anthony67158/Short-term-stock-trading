import { put, list, readJson, hasStorage } from './_blob.js';
import { preflight, applyCors } from './_lib.js';
import { authorizePaidRequest } from './_account_auth.js';
import { fetchLhbData, fetchMovers } from './board.js';
import { fetchMarketSnapshot } from './market.js';
import { fetchSectorList } from './sectors.js';
import { fetchKlineTx } from './stock_detail.js';
import { computeTechnicals } from './_ta.js';
import { marketTimePromptBlock } from './_market_time.js';
import {
  fetchFinnhubNews,
  fetchMarketFlashes,
  fetchNews,
  fetchOverseas,
} from './_market_data.js';
import {
  buildDailySummary,
  dailyReportCacheKey,
  getDailyReportSession,
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
  dailyReportGroundingIssues,
  generateDailyReportDraft,
  sanitizeDailyReportDraft,
} from './_daily_report_content.js';
import {
  DAILY_REPORT_SCHEMA_VERSION,
  buildDailyReportV3,
  buildMorningCandidatePools,
  isValuableDailyReportV3,
} from './_daily_report_v3.js';
import { fetchNorthboundData } from './_northbound.js';
import {
  fetchSearxngNews,
  searxngSearchEnabled,
} from './_searxng_search.js';
import { sectorForecastStore } from './_sector_forecast_store.js';

// ============ 全市场投资策略日报（早/午/晚三场次，SSE 流式 + Blob 缓存）============
// POST /api/daily_report?session=morning|noon|evening[&refresh=1]
// 登录信息只用于账号级缓存；v3 不读取持仓/自选，避免重复个股军师。
// 行情、资金、板块前瞻和新闻搜索先形成事实层，LLM 只负责受约束的研判。

function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000); }
function bjDayKey() { const d = nowBJ(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function bjMinutes() { const d = nowBJ(); return d.getHours() * 60 + d.getMinutes(); }
function bjTimeLabel() {
  const d = nowBJ();
  return `${bjDayKey()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// 按当前时刻自动判定默认场次：<11:30 早报 / 11:30-15:00 午报 / >=15:00 晚报
function autoSession() { const hm = bjMinutes(); if (hm < 690) return 'morning'; if (hm < 900) return 'noon'; return 'evening'; }
const SESSION_CN = { morning: '盘前早报', noon: '午间午报', evening: '收盘晚报' };

const SESSION_GENERATION = Object.freeze({
  morning: {
    phase: '正在形成开盘预案与候选池动作…',
    maxTokens: 2600,
    outputShape:
      '{"overview":"隔夜与今日核心判断","transmission":[{"signal":"海外/商品信号","reasoning":"传导到A股的推理","action":"开盘如何验证","evidenceIds":["E01"]}],"sectorViews":[{"name":"候选板块","logic":"催化+资金/模型逻辑","action":"可执行条件","evidenceIds":["E01"]}],"stockViews":[{"code":"候选股代码","logic":"入池逻辑","action":"围绕给定价位的动作","evidenceIds":["E01"]}],"openingPlan":"开盘验证顺序","strategy":"整体执行纪律","risks":["风险"]}',
    requirements:
      '早报只回答今日预判与预案。逐一覆盖给定板块池和个股池；关键价位完全沿用输入，不得输出或改写价格。海外传导、催化、机构观点必须说明推理与开盘验证条件。不得复述用户持仓。',
    required: (draft) => !!(
      String(draft?.overview || '').trim()
      && String(draft?.strategy || '').trim()
      && Array.isArray(draft?.sectorViews)
      && Array.isArray(draft?.stockViews)
    ),
  },
  noon: {
    phase: '正在核验早报并形成午后纠偏动作…',
    maxTokens: 1500,
    outputShape:
      '{"overview":"上午盘面结论","afternoonActions":[{"target":"板块或个股","action":"加|减|观望","condition":"午后执行条件","invalidation":"取消条件","evidenceIds":["E01"]}],"strategy":"午后总策略","risks":["风险"]}',
    requirements:
      '午报只回答确认与纠偏，保持精简。必须基于输入中的早报验证结果、上午量能、资金前五板块和异动股给出加/减/观望条件；不得重新写一份新闻综述。',
    required: (draft) => !!(
      String(draft?.overview || '').trim()
      && String(draft?.strategy || '').trim()
      && Array.isArray(draft?.afternoonActions)
    ),
  },
  evening: {
    phase: '正在复盘早报并形成次日观察清单…',
    maxTokens: 1900,
    outputShape:
      '{"overview":"全天主线与早报得失","nextDayPlan":[{"target":"次日方向","action":"次日动作","trigger":"触发条件","invalidation":"证伪条件","evidenceIds":["E01"]}],"overseasWatch":[{"event":"今晚或明日海外事件","watch":"对A股传导与观察项","evidenceIds":["E01"]}],"strategy":"次日总策略","risks":["风险"]}',
    requirements:
      '晚报只回答复盘与次日预判。结合早报验证、全天量能、板块主线、龙虎榜和北向真实成交数据；北向净买额未披露时不得推断流入流出。龙虎榜单日席位行为只能作为结构证据。',
    required: (draft) => !!(
      String(draft?.overview || '').trim()
      && String(draft?.strategy || '').trim()
      && Array.isArray(draft?.nextDayPlan)
      && Array.isArray(draft?.overseasWatch)
    ),
  },
});

export function dailyReportCachedResponse(cached = {}) {
  return { ...cached, ok: true, cached: true };
}

export function dailyReportAccountNick(accountAuth, body = {}) {
  if (accountAuth?.account?.nick) {
    return String(accountAuth.account.nick).trim();
  }
  if (!accountAuth?.trusted) return '';
  const nick = String(body?.accountNick || '').trim();
  return nick && nick.length <= 80 ? nick : '';
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
            && cached.schemaVersion === DAILY_REPORT_SCHEMA_VERSION
            && cached.searchEnabled === aiSearchConfig.enabled
            && Number(cached.searchConfigUpdatedAt || 0) === Number(aiSearchConfig.updatedAt || 0)
            && cached.searxngEnabled === searxngSearchEnabled()
            && Number(cached.searchPlanVersion || 0)
              === DAILY_REPORT_SEARCH_PLAN_VERSION
          ) {
            emit('result', dailyReportCachedResponse(cached));
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
    const searchPlans = buildDailyReportSearchPlans({
      day,
      session,
    });

    const [
      sectors,
      marketSnapshot,
      overseas,
      sectorForecast,
      morningBaseline,
    ] = await Promise.all([
      fetchSectorList({
        type: 'industry',
        sort: 'main',
      }).catch(() => null),
      fetchMarketSnapshot().catch(() => null),
      fetchOverseas(),
      Promise.all([
        sectorForecastStore.readLatest().catch(() => null),
        sectorForecastStore.readIntraday().catch(() => null),
      ]).then(([latest, intraday]) =>
        session === 'noon' ? (intraday || latest) : latest
      ),
      session === 'morning'
        ? Promise.resolve(null)
        : getDailyReportSession(day, 'morning', accountNick),
    ]);
    phase('核心行情已就绪，正在采集本场资金与事件…');
    const [
      moversInflow,
      moversSpeed,
      moversOutflow,
      lhb,
      northbound,
    ] = await Promise.all([
      session === 'noon'
        ? fetchMovers('inflow').catch(() => null)
        : Promise.resolve(null),
      session === 'noon'
        ? fetchMovers('speed').catch(() => null)
        : Promise.resolve(null),
      session === 'noon'
        ? fetchMovers('outflow').catch(() => null)
        : Promise.resolve(null),
      session === 'evening'
        ? fetchLhbData().catch(() => null)
        : Promise.resolve(null),
      session === 'evening'
        ? fetchNorthboundData()
        : Promise.resolve(null),
    ]);
    phase('硬数据已核对，正在补充政策与事件证据…');
    const [
      sectorNews,
      macroNews,
      marketFlashes,
      finnhubNews,
      searchResults,
    ] = await Promise.all([
      session === 'morning'
        ? Promise.all(SECTORS.map((sector) =>
            fetchNews(sector.kw, 3).then((news) => ({
              key: sector.key,
              name: sector.name,
              keywords: sector.kw.split(/\s+/).filter(Boolean),
              news,
            }))
          ))
        : Promise.resolve([]),
      fetchNews(
        session === 'morning'
          ? '昨晚 今早 宏观 政策 央行 A股 产业催化'
          : session === 'noon'
            ? '今日 上午 A股 政策 突发'
            : '今日 收盘 A股 政策 产业 明日事件',
        session === 'noon' ? 4 : 8,
      ),
      fetchMarketFlashes(18),
      session === 'noon' ? Promise.resolve([]) : fetchFinnhubNews(6),
      Promise.all(searchPlans.flatMap((plan) => [
        fetchAiSearchReference({
          query: plan.query,
          cacheScope: plan.cacheScope,
          cacheKey: plan.cacheKey,
          cacheMinutes: plan.cacheMinutes,
        }, {
          runtimeConfig: aiSearchConfig,
          topK: plan.topK,
        }).then((result) => ({
          ...plan,
          provider: 'doubao-global',
          result,
        })),
        fetchSearxngNews(plan.query, {
          limit: plan.topK,
        }).then((result) => ({
          ...plan,
          provider: 'searxng',
          result,
        })),
      ])),
    ]);
    const overseasSafe = (overseas && typeof overseas === 'object') ? overseas : {};
    if (!Array.isArray(overseasSafe.indices)) overseasSafe.indices = [];
    if (!Array.isArray(overseasSafe.commodities)) overseasSafe.commodities = [];

    const marketNumber = (value) => {
      if (value == null || value === '' || value === '-') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const slist = (sectors && sectors.list) || [];
    const sSorted = [...slist].sort((a, b) =>
      (marketNumber(b.mainInflow) || 0)
      - (marketNumber(a.mainInflow) || 0)
    );
    const yi = (value) => {
      const parsed = marketNumber(value);
      return parsed == null ? null : +(parsed / 1e8).toFixed(2);
    };
    const sectorFlow = {
      top: sSorted
        .filter((item) => marketNumber(item.mainInflow) != null)
        .slice(0, 8)
        .map((item) => ({
          name: item.name,
          pct: marketNumber(item.pct),
          inflowYi: yi(item.mainInflow),
          mainRatio: marketNumber(item.mainRatio),
          amountYi: yi(item.amount),
          lead: item.leadName,
          leadCode: item.leadCode,
        })),
      bottom: sSorted
        .filter((item) => marketNumber(item.mainInflow) != null)
        .slice(-6)
        .reverse()
        .map((item) => ({
          name: item.name,
          pct: marketNumber(item.pct),
          inflowYi: yi(item.mainInflow),
          mainRatio: marketNumber(item.mainRatio),
          amountYi: yi(item.amount),
          lead: item.leadName,
          leadCode: item.leadCode,
        })),
    };
    const limitCount = marketNumber(marketSnapshot?.breadth?.limitUp);

    const basePools = buildMorningCandidatePools({
      sectorForecast,
      sectorFlow,
    });
    const technicalRows = session === 'morning'
      ? await Promise.all(basePools.stocks.map(async (stock) => {
          const detail = await fetchKlineTx(stock.code, '101', 120)
            .catch(() => null);
          return [
            stock.code,
            detail?.candles?.length
              ? computeTechnicals(detail.candles, '日')
              : null,
          ];
        }))
      : [];
    const candidatePools = buildMorningCandidatePools({
      sectorForecast,
      sectorFlow,
      technicalsByCode: Object.fromEntries(technicalRows),
    });
    const dataBlock = {
      session: SESSION_CN[session],
      day,
      asOf: bjTimeLabel(),
      aIndices: marketSnapshot?.indices || [],
      overseas: overseasSafe.indices,
      commodities: overseasSafe.commodities,
      market: session === 'noon'
        ? {
            ...(marketSnapshot?.breadth || {}),
            volVsAvg5: null,
            volLevel: '上午累计',
            volumeBasis: '上午累计成交额，不与近5个完整交易日直接比较',
          }
        : {
            ...(marketSnapshot?.breadth || {}),
            volumeBasis: '全日成交额与近5个完整交易日比较',
          },
      sectorFlow,
      sectorSnapshot: (session === 'morning'
        ? []
        : (sectorForecast?.sectors || []).slice(0, 12))
        .map((item) => ({
          code: item.code,
          name: item.name,
          rank: item.rank,
          actionability: item.actionability,
          raw: {
            currentPct: item.raw?.currentPct,
            mainInflow: item.raw?.mainInflow,
            mainRatio: item.raw?.mainRatio,
          },
        })),
      limitUpCount: limitCount,
      movers: {
        inflow: (moversInflow?.list || []).slice(0, 8),
        speed: (moversSpeed?.list || []).slice(0, 8),
        outflow: (moversOutflow?.list || []).slice(0, 8),
      },
      lhb: lhb?.ok
        ? {
            date: lhb.date,
            updatedAt: lhb.updatedAt,
            stocks: (lhb.stocks || []).slice(0, 12),
            seats: (lhb.seats || []).slice(0, 10),
          }
        : null,
      northbound,
      candidatePools,
    };
    const evidence = buildDailyEvidenceBundle({
      data: dataBlock,
      macroNews,
      marketFlashes: [
        ...(marketFlashes || []),
        ...(finnhubNews || []),
      ],
      sectorNews,
      searchResults,
    });
    const searchItems = evidence.items.filter((item) =>
      ['doubao_search', 'web_search'].includes(item.kind)
    );
    const searchReference = searchItems.length
      ? {
          dimension: 'search',
          label: '网页检索参考',
          status: searchResults
            .map((item) => `${item.provider}:${item.result?.status || 'unknown'}`)
            .filter(Boolean)
            .join(','),
          fetchedAt: new Date().toISOString(),
          sources: searchItems.slice(0, 12),
        }
      : null;
    const evidenceCategories = session === 'morning'
      ? ['macro', 'industry', 'global', 'institution']
      : ['market', 'macro', 'global'];
    const promptEvidence = evidence.items
      .filter((item) =>
        evidenceCategories.includes(item.category)
        || item.evidenceLevel === 'primary'
      )
      .slice(0, session === 'morning' ? 24 : session === 'noon' ? 18 : 22)
      .map((item) => ({
        id: item.id,
        category: item.categoryLabel,
        title: item.title,
        summary: item.summary,
        source: item.src,
        publishedAt: item.publishedAt || item.date,
        evidenceLevel: item.evidenceLevel,
        stockCode: item.stockCode || undefined,
        sector: item.sector || undefined,
      }));
    const sourcePayload = {
      session: dataBlock.session,
      day: dataBlock.day,
      asOf: dataBlock.asOf,
      aIndices: dataBlock.aIndices,
      ...(session === 'morning'
        ? {
            overseas: dataBlock.overseas,
            commodities: dataBlock.commodities,
            candidatePools: dataBlock.candidatePools,
          }
        : session === 'noon'
          ? {
              market: dataBlock.market,
              sectorFlow: dataBlock.sectorFlow,
              sectorSnapshot: dataBlock.sectorSnapshot,
              movers: dataBlock.movers,
            }
          : {
              market: dataBlock.market,
              sectorFlow: dataBlock.sectorFlow,
              sectorSnapshot: dataBlock.sectorSnapshot,
              lhb: dataBlock.lhb,
              northbound: dataBlock.northbound,
            }),
      evidence: promptEvidence,
      morningBaseline: morningBaseline
        ? {
            day: morningBaseline.day,
            overview: morningBaseline.report?.overview,
            sectorPool: morningBaseline.report?.analysis?.sectorPool || [],
            stockPool: morningBaseline.report?.analysis?.stockPool || [],
          }
        : null,
    };
    const SYS = `你是严谨的A股短线策略研究员。硬数据与分析师观点必须分离：输入中的行情、资金、龙虎榜、北向成交和技术价位是只读事实，不得篡改、补写或推算缺失值。网页搜索摘要只用于发现线索，不能替代原文。每个软判断必须给出推理、可执行条件和有效证据编号；没有对应证据时明确写待验证。红涨绿跌。只输出合法JSON，不输出markdown或思维链。`;
    const timeCtx = marketTimePromptBlock();
    const generationConfig = SESSION_GENERATION[session];
    phase(dailyLlmReady
      ? generationConfig.phase
      : '模型暂不可用，正在生成硬数据规则版…');
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
              Math.min(
                attempt === 1 && session === 'morning' ? 60000
                  : attempt === 1 ? 36000 : 30000,
                remain() - 4000,
              ),
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
          const draft = sanitizeDailyReportDraft(
            parsed?.report || parsed,
            payload,
          );
          done(!!draft);
          return draft;
        },
        {
          maxAttempts,
          validate: (draft) => {
            const issues = dailyReportGroundingIssues(draft, payload);
            if (!required(draft)) issues.unshift('missing-required-fields');
            return {
              ok: issues.length === 0,
              issues,
            };
          },
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
    const draftResult = dailyLlmReady
      ? await callPart(
          sourcePayload,
          generationConfig.outputShape,
          generationConfig.requirements,
          generationConfig.maxTokens,
          generationConfig.required,
        )
      : emptyGeneration;
    const composed = buildDailyReportV3({
      day,
      session,
      data: dataBlock,
      evidence,
      morningReport: morningBaseline,
      draft: draftResult.complete ? draftResult.draft : null,
      generation: draftResult,
    });
    if (!isValuableDailyReportV3(composed)) {
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
      searxngEnabled: searxngSearchEnabled(),
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
