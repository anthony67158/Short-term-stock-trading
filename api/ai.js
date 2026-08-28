// AI 分析代理：服务端调用 LLM，Key 从环境变量读取，绝不暴露给前端
// POST body: { mode: 'market'|'sector'|'stock'|'scan', payload: {...} }
import { buildCorpus, retrieve } from './_rag.js';
import { retrieveTheoryKeywords } from './_kb.js';
import {
  backtestSignal,
  computeTechnicals,
  fetchSelectedQuantPredict,
  techSummaryForAI,
} from './_ta.js';
import { fetchKlineTx } from './stock_detail.js';
import { quantModelLabel } from '../shared/modelVersion.js';
import { buildQuantAdviceContext } from '../shared/quantAdviceContext.js';
import { marketTimePromptBlock, marketTimeContext } from './_market_time.js';
import { getLatestDailySummary } from './_daily_summary.js';
import { fetchNews, fetchMarketFlashes } from './_market_data.js';
import {
  buildSearchReference,
  fetchAdvisorSearch,
  fetchAdvisorSearchBundle,
  fetchAiSearchReference,
  fetchIndustrySearchSupplement,
  stripClientSearchFields,
} from './_ai_search.js';
import { ensureAiSearchConfig } from './_ai_search_config.js';
import {
  callChat,
  callChatWithRetry,
  llmReady,
  parseLLMJson,
  pumpChatStream,
} from './_llm.js';
import { ensureConfig, currentConfig, getModel, getReasoning } from './_llm_config.js';
import {
  endpointCountForRole,
  markEndpointUnusable,
} from './_llm_pool.js';
import { applyCors, preflight } from './_lib.js';
import { zhReasonPiece } from './_zh_reason.js';
import {
  SYSTEM_PROMPT,
  ADVISOR_DEEP_SYSTEM,
  ADVISOR_FAST_SYSTEM,
  ADVISOR_SYSTEM,
  advisorOutputSchema,
  buildUserPrompt,
  deepAdvisorFacts,
  isAdvisorMode,
  llmRoleForAdviceMode,
  maxTokensForMode,
} from './_ai_prompts.js';
import { reconcileAdviceNumbers } from '../shared/adviceValidation.js';
import { normalizePickDecision } from '../shared/stockRanking.js';
import {
  canUseQuantModel,
  resolveQuantModelForRequest,
} from './_quant_access.js';
import { authorizePaidRequest } from './_account_auth.js';
import {
  continuityEvidenceFromPayload,
  reconcileAdviceContinuity,
} from '../shared/adviceContinuity.js';
import {
  buildKnowledgeActionPlan,
  scoreKnowledgeActionPlan,
} from '../shared/knowledgeAction.js';
import { isCurrentDailyReportSummary } from '../shared/adviceDailyReportPolicy.js';
import { buildAdviceDecisionContext } from '../shared/adviceModeContext.js';
import {
  attachShortHorizonSummary,
  buildShortHorizonTactical,
  deriveShortHorizonActionPolicy,
} from '../shared/shortHorizonTactical.js';
import { applyPortfolioRiskPolicy } from '../shared/portfolioRiskPolicy.js';
import {
  applyShortHorizonExitPolicy,
} from '../shared/exitManagement.js';
import { applyTActionAdvicePolicy } from '../shared/tAdvicePolicy.js';
import {
  classifyPriceLimit,
  priceLimitRatio,
} from '../shared/priceLimitPolicy.js';
import {
  compactStockFundSnapshot,
  mergeRetailFundFlow,
  normalizeFundNoteHistory,
} from '../shared/retailFundFlow.js';
import {
  attachEvidenceSnapshot,
  createCanonicalEvidenceSnapshot,
  createEvidenceSourceTracker,
  resolveEvidenceAccountRevision,
  sourceTextVersion,
} from '../shared/evidenceSnapshot.js';
import {
  buildRealOutcomeLearning,
  realOutcomeContext,
} from '../shared/realOutcomeLearning.js';
import {
  enforceTriggeredReviewDecisionPlan,
  isTriggeredReviewEvent,
  normalizeTriggeredReviewDecision,
  shouldCollectTriggeredReviewSource,
} from '../shared/triggeredReviewDecision.js';
import {
  buildAdvisorTheoryQuery,
  theoryReferencesOf,
} from '../shared/advisorTheory.js';
import {
  buildReviewReceipt,
  calibrateAdviceTrust,
  evaluateScheduledReview,
} from '../shared/adviceIntelligence.js';
import { deriveMarketRegime } from '../shared/marketRegime.js';
import {
  buildFallbackDecisionAdvice,
  compileDecisionPlan,
} from '../shared/decisionPlan.js';
import {
  accountTradeStateFingerprint,
} from '../shared/accountSync.js';
import { compileExecutionPlan } from '../shared/executionPlan.js';
import {
  evaluateAccountCircuitBreaker,
} from '../shared/accountCircuitBreaker.js';
import {
  compileAdvicePresentationV3,
} from '../shared/advicePresentation.js';
import {
  quantInputReadiness,
  selectFreshestDailyDetail,
} from '../shared/advisorQuantInput.js';
import {
  humanizeAdviceTextFields,
} from '../shared/userFacingLanguage.js';
import {
  buildTGridExperiment,
  evaluateTGridEligibility,
} from '../shared/tGridPolicy.js';
import { internalApiOrigin } from './_internal_origin.js';
import { loadSectorOpportunity } from './_sector_opportunity.js';
import {
  fetchStockFund,
  fundAmountYi,
} from './_stock_fund.js';

export { mapRealtimeStockFund } from './_stock_fund.js';

export function portfolioOpportunityCostForStock(
  accountData = {},
  code = '',
  now = Date.now(),
) {
  const result = accountData?.portfolioAnalysisLatest?.result
  const analysis = result?.analysis || result
  const rotation = analysis?.executionPlan?.primaryRotation
  const sourceCode = String(rotation?.source?.code || '')
  const targetCode = String(rotation?.target?.code || '')
  const generatedAt = Number(
    accountData?.portfolioAnalysisLatest?.generatedAt
    || accountData?.portfolioAnalysisLatest?.completedAt
    || 0,
  )
  if (
    !rotation
    || !/^\d{6}$/.test(sourceCode)
    || !/^\d{6}$/.test(targetCode)
    || sourceCode !== String(code || '')
    || !(generatedAt > 0)
    || Number(now) < generatedAt
    || Number(now) - generatedAt > 24 * 3600 * 1000
  ) return null
  return {
    schemaVersion: 'opportunity-cost.v1',
    status: String(rotation.status || ''),
    actionable: rotation.actionable === true,
    sourceCode,
    targetCode,
    targetName: String(rotation.target.name || targetCode)
      .slice(0, 40),
    edgeScore: Number.isFinite(Number(rotation.comparison?.edgeScore))
      ? Number(rotation.comparison.edgeScore)
      : null,
    tradingCost: Number.isFinite(Number(rotation.costs?.total))
      ? Number(rotation.costs.total)
      : null,
    generatedAt,
  };
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) { if (arr.length < 2) return 0; const m = avg(arr); return Math.sqrt(avg(arr.map((x) => (x - m) ** 2))); }

export function buildScheduledReviewGateResponse({
  mode,
  origin,
  previousDigest,
  snapshot,
  hasPreviousAdvice,
  previousAdvice,
  evaluation,
  reviewReceipt = null,
  meta = {},
  news = [],
  now = Date.now(),
} = {}) {
  const review = evaluation || evaluateScheduledReview({
    origin,
    previousDigest,
    snapshot,
    hasPreviousAdvice,
    previousAdvice,
  });
  if (review.shouldRunLLM) return null;
  return {
    ok: true,
    unchanged: true,
    reviewDisposition: review.disposition,
    reviewReason: review.reason,
    reviewReceipt,
    mode,
    updatedAt: now,
    meta: {
      ...meta,
      reviewDisposition: review.disposition,
      reviewReason: review.reason,
    },
    news,
  };
}

export function resolveAIBudget(_reasoningOn, requestedMs) {
  const fallback = 150000;
  if (requestedMs == null || !Number.isFinite(Number(requestedMs))) return fallback;
  return Math.max(30000, Math.min(fallback, Math.trunc(Number(requestedMs))));
}

export function resolveReasoningMode(configuredReasoning, fastMode = false, forceReasoning = false) {
  if (forceReasoning) return true;
  return !!configuredReasoning && !fastMode;
}

export function shouldRepairAdvisorBody({
  advisor = false,
  aborted = false,
  budgetMs = 0,
  parsed = null,
} = {}) {
  return !!(
    advisor
    && !aborted
    && Number(budgetMs) > 15000
    && (!parsed?.value || parsed?.repaired)
  )
}

export function shouldFailoverAdvisorStream({
  advisor = false,
  canFailover = false,
  requestAborted = false,
  budgetMs = 0,
  responseError = null,
  content = '',
  reasoning = '',
} = {}) {
  if (
    !advisor
    || !canFailover
    || requestAborted
    || Number(budgetMs) <= 12000
  ) return false
  if (responseError) return true
  const contentParsed = content.trim()
    ? parseLLMJson(content)
    : null
  const reasoningParsed = reasoning.trim()
    ? parseLLMJson(reasoning)
    : null
  return !contentParsed?.value && !reasoningParsed?.value
}

export async function resolveAdviceDailySummary(
  payload,
  getSummary = getLatestDailySummary,
  searchConfig = null,
) {
  if (isCurrentDailyReportSummary(payload?.dailyReport, Date.now(), searchConfig)) {
    return payload.dailyReport
  }
  try {
    const summary = await getSummary()
    return isCurrentDailyReportSummary(summary, Date.now(), searchConfig)
      ? summary
      : null
  } catch {
    return null
  }
}

// ============ 个股历史规律画像（做T策略自适应的核心）============
// 输入：近约60日日线 candles（含 open/close/high/low/pct/volume/preClose 或可推）
// 输出：这只股“自己的性格”，用于让 AI 自动选激进/均衡/稳健 + 正T/反T
function computeStockProfile(candles) {
  const cs = (candles || []).filter((c) => c && c.high != null && c.low != null && c.close != null);
  if (cs.length < 10) return null;
  const n = cs.length;
  // 昨收序列（优先用上一根收盘）
  const prevCloseOf = (i) => (i > 0 ? cs[i - 1].close : (cs[i].open || cs[i].close));

  // 1) 日内振幅：每日 (high-low)/prevClose
  const amps = cs.map((c, i) => { const pc = prevCloseOf(i); return pc ? ((c.high - c.low) / pc) * 100 : 0; });
  const avgAmp = +avg(amps).toFixed(2);
  const recentAmp = +avg(amps.slice(-10)).toFixed(2);

  // 2) 波动性：日涨跌幅标准差（性格烈度）
  const pcts = cs.map((c, i) => { if (c.pct != null) return c.pct; const pc = prevCloseOf(i); return pc ? ((c.close - pc) / pc) * 100 : 0; });
  const vol = +std(pcts).toFixed(2);

  // 3) 均值回归 vs 趋势延续：大涨(>+3%)/大跌(<-3%)次日方向
  let bigUp = 0, bigUpRev = 0, bigDn = 0, bigDnRev = 0;
  for (let i = 0; i < n - 1; i++) {
    const today = pcts[i], next = pcts[i + 1];
    if (today > 3) { bigUp++; if (next < 0) bigUpRev++; }
    if (today < -3) { bigDn++; if (next > 0) bigDnRev++; }
  }
  const upRevRate = bigUp ? +(bigUpRev / bigUp).toFixed(2) : null;   // 大涨后回落概率
  const dnRevRate = bigDn ? +(bigDnRev / bigDn).toFixed(2) : null;   // 大跌后反弹概率
  // 回归倾向评分：两者都高=强均值回归（适合高抛低吸做T）
  const revScore = (upRevRate != null && dnRevRate != null) ? +(((upRevRate + dnRevRate) / 2)).toFixed(2) : null;

  // 4) 开盘路径规律：低开走高 / 高开走低 频次（决定正T还是反T更契合这只股）
  let openHighClose = 0, openLowClose = 0, validOpen = 0;
  for (let i = 0; i < n; i++) {
    const pc = prevCloseOf(i); if (!pc || cs[i].open == null) continue; validOpen++;
    const openGap = (cs[i].open - pc) / pc;      // 高开/低开
    const dayMove = (cs[i].close - cs[i].open);  // 日内从开到收
    if (openGap < -0.005 && dayMove > 0) openLowClose++;  // 低开走高 → 利好正T低吸
    if (openGap > 0.005 && dayMove < 0) openHighClose++;  // 高开走低 → 利好反T高抛
  }
  const lowOpenUpRate = validOpen ? +(openLowClose / validOpen).toFixed(2) : null;
  const highOpenDownRate = validOpen ? +(openHighClose / validOpen).toFixed(2) : null;

  // 5) 量价配合：放量日（量>近20日均量1.5倍）里上涨占比
  const vols = cs.map((c) => c.volume || 0);
  const ma20vol = avg(vols.slice(-20));
  let bigVol = 0, bigVolUp = 0;
  for (let i = Math.max(0, n - 20); i < n; i++) { if (ma20vol && vols[i] > ma20vol * 1.5) { bigVol++; if (pcts[i] > 0) bigVolUp++; } }
  const volPriceSync = bigVol ? +(bigVolUp / bigVol).toFixed(2) : null;

  // 6) 近期结构：连阳/连阴、20/60日区间位置
  let streak = 0; for (let i = n - 1; i >= 0; i--) { if (streak === 0) streak = pcts[i] > 0 ? 1 : (pcts[i] < 0 ? -1 : 0); else if ((streak > 0 && pcts[i] > 0) || (streak < 0 && pcts[i] < 0)) streak += streak > 0 ? 1 : -1; else break; }
  const last = cs[n - 1].close;
  const win = (k) => cs.slice(-k);
  const hi = (k) => Math.max(...win(k).map((c) => c.high));
  const lo = (k) => Math.min(...win(k).map((c) => c.low));
  const posIn = (k) => { const H = hi(k), L = lo(k); return H > L ? +(((last - L) / (H - L)) * 100).toFixed(0) : null; };

  // 综合判定：策略性格 + 方向偏好（供 AI 参考，AI 仍可结合当日盘面覆盖）
  let styleSuggest = 'balanced';
  if (vol >= 4 || recentAmp >= 6) styleSuggest = 'aggressive';      // 大波动/大振幅 → 激进博差价
  else if (vol <= 2 && recentAmp <= 3) styleSuggest = 'conservative'; // 温吞 → 稳健小做
  const tradable = recentAmp >= 2.5;  // 振幅太小做T没肉

  let dirBias = 'balanced', dirReason = '';
  if (revScore != null && revScore >= 0.55) { dirBias = 'meanReversion'; dirReason = '强均值回归：大涨常回落、大跌常反弹，正T反T都适合，看当日位置决定先买还是先卖'; }
  // 开盘路径偏好：只有当两者“明显不对称”时才定向，避免因A股普遍低开走高而系统性偏正T
  const loRate = lowOpenUpRate || 0, hoRate = highOpenDownRate || 0;
  if (loRate >= 0.3 && loRate - hoRate >= 0.1) { dirBias = 'positive'; dirReason = `低开走高(${(loRate * 100).toFixed(0)}%)明显多于高开走低(${(hoRate * 100).toFixed(0)}%)，略偏正T低吸`; }
  else if (hoRate >= 0.3 && hoRate - loRate >= 0.1) { dirBias = 'reverse'; dirReason = `高开走低(${(hoRate * 100).toFixed(0)}%)明显多于低开走高(${(loRate * 100).toFixed(0)}%)，略偏反T高抛`; }
  else if (dirBias !== 'meanReversion') { dirBias = 'balanced'; dirReason = '开盘路径无明显偏向，正T/反T均可，以当日分时位置为准'; }

  return {
    days: n,
    avgAmplitude: avgAmp, recentAmplitude: recentAmp,   // 平均/近10日日内振幅%
    volatility: vol,                                    // 日涨跌幅标准差（性格烈度）
    bigUpRevRate: upRevRate, bigDnRevRate: dnRevRate, meanRevScore: revScore, // 均值回归性
    lowOpenUpRate, highOpenDownRate,                    // 开盘路径规律
    volPriceSync,                                       // 放量上涨配合度
    streak,                                             // 当前连阳(+)/连阴(-)根数
    posIn20: posIn(20), posIn60: posIn(Math.min(60, n)),
    styleSuggest, tradable, dirBias, dirReason,
  };
}

// 抓取当日分时（时间,价格,量,均价VWAP），多镜像容错
function toSecid(code) { const c = String(code).trim(); return /^(6|9|5)/.test(c) ? '1.' + c : '0.' + c; }
// 腾讯分时(备用源)：东财 trends2 在 Vercel egress IP 上经常 502/限流,腾讯 gtimg 基本不限流,作为兜底。
// 与 stock_detail.js 的 fetchTrendsTx 同源实现,行格式 "HHMM 价 累计量(手) 累计额(元)",均价=累计额/(累计量×100)。
function toTxCode(code) {
  const c = String(code).trim();
  if (/^(6|9|5)/.test(c)) return 'sh' + c;
  if (/^(0|3|2)/.test(c)) return 'sz' + c;
  if (/^(4|8)/.test(c)) return 'bj' + c;
  return 'sh' + c;
}
async function fetchTrendTx(code, timeoutMs = 6000) {
  const tx = toTxCode(code);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tx}&_=${Date.now()}`, { signal: ctrl.signal, headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    const j = await r.json();
    const root = j && j.data && j.data[tx];
    const node = root && root.data;
    if (!node || !Array.isArray(node.data) || !node.data.length) return null;
    let prevCum = 0;
    return node.data.map((line) => {
      const p = String(line).split(/\s+/);
      const hhmm = p[0];
      const time = /^\d{4}$/.test(hhmm) ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : hhmm;
      const price = Number(p[1]);
      const cumVol = Number(p[2]);            // 累计成交量(手)
      const cumAmt = Number(p[3]);            // 累计成交额(元)
      const avg = cumVol ? +(cumAmt / (cumVol * 100)).toFixed(2) : price; // 真·均价VWAP
      const vol = Math.max(cumVol - prevCum, 0);
      prevCum = cumVol;
      return { time, price, vol, avg };
    }).filter((x) => x.price > 0);
  } catch { return null; }
}
async function fetchTrend(
  code,
  {
    timeoutMs = 6000,
    parallel = false,
    maxHosts = 4,
  } = {},
) {
  const hosts = ['https://push2his.eastmoney.com', 'https://82.push2his.eastmoney.com', 'https://push2.eastmoney.com', 'https://push2delay.eastmoney.com'];
  const path = `/api/qt/stock/trends2/get?secid=${toSecid(code)}&fields1=f1,f2&fields2=f51,f53,f56,f58&iscr=0&ndays=1&forcect=1`;
  const fetchHost = async (host) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetch(host + path, {
        signal: ctrl.signal,
        headers: {
          Referer: 'https://quote.eastmoney.com/',
          'User-Agent': 'Mozilla/5.0',
        },
      });
      const json = await response.json();
      const trends = json?.data?.trends;
      if (!Array.isArray(trends) || !trends.length) {
        throw new Error('empty trends');
      }
      return trends.map((line) => {
        const parts = line.split(',');
        return {
          time: parts[0].slice(11),
          price: Number(parts[1]),
          vol: Number(parts[2]),
          avg: Number(parts[3]),
        };
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const candidates = hosts.slice(
    0,
    Math.max(1, Math.min(hosts.length, Number(maxHosts) || hosts.length)),
  );
  if (parallel) {
    try {
      return await Promise.any(
        candidates.map((host) => fetchHost(host)),
      );
    } catch { /* fall through to Tencent */ }
  } else {
    for (const host of candidates) {
      try {
        return await fetchHost(host);
      } catch { /* try next */ }
    }
  }
  // 东财全镜像失败 → 回退腾讯分时(不限流),确保"分时走势"因子在 Vercel 上也能取到
  return await fetchTrendTx(code, timeoutMs);
}

export function buildAdvisorTodayQuote(
  quote = {},
  {
    code = '',
    name = '',
    marketTime = {},
  } = {},
) {
  const isLive = !!marketTime.isLive;
  const ratio = priceLimitRatio({
    code,
    name: name || quote.name,
  });
  const base = quote.prevClose;
  return {
    live: isLive,
    asOfLabel: marketTime.dataDayLabel,
    phase: marketTime.phase,
    source: quote.source || null,
    tradeDate: quote.tradeDate || null,
    price: quote.price,
    pct: quote.pct,
    amount: quote.amount,
    isLimitUp: isLive && !!quote.isLimitUp,
    isLimitDown: isLive && !!quote.isLimitDown,
    limitUpPrice:
      isLive && base != null
        ? +(base * (1 + ratio)).toFixed(2)
        : null,
    limitDownPrice:
      isLive && base != null
        ? +(base * (1 - ratio)).toFixed(2)
        : null,
    limitRatioPct: +(ratio * 100).toFixed(0),
    high: quote.high,
    low: quote.low,
    open: quote.open,
    prevClose: quote.prevClose,
    turnover: quote.turnover,
    volRatio: quote.volRatio,
    mainNetYi: fundAmountYi(quote.mainInflow),
    retailNetYi: fundAmountYi(quote.retailInflow),
    bigMove:
      isLive
      && quote.pct != null
      && Math.abs(quote.pct) >= 7,
  };
}


// 个股近期龙虎榜 + 买方席位识别（是否知名游资/机构专用席位 = 聪明钱）
const HOT_SEATS = ['章盟主', '赵老哥', '炒股养家', '作手新一', '方新侠', '孙哥', 'UBS', '摩根', '中金', '华鑫', '东方财富', '拉萨', '成都', '深股通', '沪股通', '机构专用', '国泰君安', '中信', '量化'];
async function fetchStockLHB(code) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const flt = encodeURIComponent(`(SECURITY_CODE="${code}")`);
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=SECURITY_CODE,TRADE_DATE,EXPLANATION,BILLBOARD_NET_AMT,CHANGE_RATE&filter=${flt}&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=5&source=WEB&client=WEB`;
    const r = await fetch(url, { signal: ctrl.signal, headers: { Referer: 'https://data.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    const j = await r.json();
    const rows = (j && j.result && j.result.data) || [];
    if (!rows.length) return null;
    const recent = rows[0];
    const lhbDate = String(recent.TRADE_DATE || '').slice(0, 10);
    let seats = [];
    try {
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 6000);
      const flt2 = encodeURIComponent(`(SECURITY_CODE="${code}")(TRADE_DATE='${lhbDate}')`);
      const url2 = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BILLBOARD_DAILYDETAILSBUY&columns=OPERATEDEPT_NAME,BUY,NET&filter=${flt2}&sortColumns=NET&sortTypes=-1&pageSize=5&source=WEB&client=WEB`;
      const r2 = await fetch(url2, { signal: ctrl2.signal, headers: { Referer: 'https://data.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(t2);
      const j2 = await r2.json();
      seats = ((j2 && j2.result && j2.result.data) || []).map((s) => s.OPERATEDEPT_NAME).filter(Boolean);
    } catch { /* ignore */ }
    const smart = seats.filter((nm) => HOT_SEATS.some((h) => nm.includes(h)));
    return {
      onList: true, date: lhbDate, times30d: rows.length,
      reason: recent.EXPLANATION || '',
      netAmount: recent.BILLBOARD_NET_AMT != null ? Number(recent.BILLBOARD_NET_AMT) : null, // 龙虎榜净买额(元),供 eventSignal 判方向
      buySeats: seats.slice(0, 5),
      smartMoney: smart.length > 0,
      smartSeats: smart.slice(0, 3),
    };
  } catch { return null; }
}

// 宏观/国内外重大事件新闻（当日财经要闻）——让军师把大环境纳入分析，而非只看个股技术
function labeledNewsTitle(item) {
  if (!item?.title) return '';
  const type = item.kind === 'announcement'
    ? '公告'
    : item.kind === 'research'
      ? '研报观点'
      : '';
  const source = item.src || type;
  return source ? `[${source}]${item.title}` : item.title;
}

function aiSearchEvidenceText(item) {
  if (!item?.title) return '';
  const scopeLabel = item.searchScope === 'stock'
    ? '豆包个股信息'
    : item.searchScope === 'industry'
      ? '豆包行业资讯'
      : '豆包搜索';
  const source = item.src || scopeLabel;
  const date = item.date || '时间未标注';
  const summary = item.summary ? `。${item.summary}` : '';
  return `【${scopeLabel}待核验·${source}·${date}】${item.title}${summary}`;
}

function searchQueryForMode(mode, payload = {}) {
  if (mode === 'scan_pick' || mode === 'scan') {
    const sectors = [
      ...(payload.investmentConcepts || []),
      ...(payload.sectors || []),
    ]
      .slice(0, 4)
      .map((item) => item?.name)
      .filter(Boolean);
    const stocks = (payload.candidates || [])
      .slice(0, 4)
      .map((item) => item?.name)
      .filter(Boolean);
    return `A股 国家战略 产业趋势 政策 景气 资金 风险 ${sectors.join(' ')} ${stocks.join(' ')}`;
  }
  if (mode === 'stock' && payload.code) {
    return `${payload.name || ''} ${payload.code} 最新公告 行业 舆情 风险`;
  }
  if (mode === 'sector') {
    return `A股 ${payload.name || payload.sector || ''} 行业 最新政策 景气 舆情 风险`;
  }
  if (mode === 'market' || mode === 'daily') {
    return 'A股 今日宏观政策 行业热点 市场舆情 风险';
  }
  return '';
}

// 东财与华尔街见闻双检索；搜索均失败时退化到三路实时快讯。
async function fetchMacroNews() {
  try {
    const kw = '宏观 政策 央行 美股 关税 A股 市场';
    const heads = await fetchNews(kw, 8);
    if (heads.length) return heads;
  } catch { /* 双检索失败后走实时流兜底 */ }
  try {
    const MACRO_RE = /(央行|货币|政策|降准|降息|LPR|财政|关税|美股|美联储|加息|经济|GDP|CPI|PPI|地缘|大盘|A股|外资|人民币|国常会|会议|监管|出口|贸易|指数)/;
    const pool = await fetchMarketFlashes(24);
    let macro = pool.filter((x) => MACRO_RE.test(x.title));
    if (!macro.length) macro = pool; // 关键词一条没命中时退化为最新快讯,总比空缺强
    const heads = macro.slice(0, 8);
    return heads.length ? heads : null;
  } catch { return null; }
}

// 权威财经快讯(财联社系/金十/东财聚合)——供 AI 各流程复用为"外部实时消息面"
// 与 fetchMacroNews(深度稿件) 互补:快讯更新鲜、更贴近盘面异动
async function fetchMacroFlashes(size = 8) {
  try {
    const arr = await fetchMarketFlashes(size);
    return (arr && arr.length)
      ? arr.map(labeledNewsTitle).filter(Boolean).slice(0, size)
      : null;
  } catch { return null; }
}


export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  // 注意：Content-Type 延后设置——流式走 SSE、非流式走 JSON，见下方 streaming 分支

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify({ ok: false, error: 'POST only' }));
  }

  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body || '{}');
  } catch {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(422).send(JSON.stringify({ ok: false, error: '请求格式无效' }));
  }
  if (body?.mode === 'ping') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify({ ok: true, mode: 'ping' }));
  }
  const accountAuth = await authorizePaidRequest(req);
  if (!accountAuth.ok) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const status = accountAuth.error === '请先登录' ? 401 : 403;
    return res.status(status).send(JSON.stringify({
      ok: false,
      error: accountAuth.error,
    }));
  }

  const mode = (body && body.mode) || 'market';
  const useRole = llmRoleForAdviceMode(
    mode,
    body?.payload?.reviewOrigin,
  );
  // 运行时配置优先（前端「AI 模型配置」写入 OSS）：先预热同步缓存，再按角色取端点和模型。
  await ensureConfig();
  const aiSearchConfig = await ensureAiSearchConfig();
  const cfg = currentConfig();
  const effectiveReasoning = (role) => getReasoning(role);
  const MODEL = getModel('agent');
  // 主建议与复核严格分池：首次操作建议走 advisor，定时/Judge 复核走 review。
  const ADVISOR_MODEL = getModel('advisor');
  const REVIEW_MODEL = getModel('review');
  if (!llmReady(useRole)) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify({
      ok: false,
      error: `${useRole} 角色端点未配置`,
    }));
  }

  // 心跳定时器提到 try 外层声明,保证下方 catch 也能兜底清理(异常绕过 finish 时不泄漏 interval)
  let hbTimer = null;
  try {
    const payload = stripClientSearchFields((body && body.payload) || {});
    delete payload.strategyGate;
    delete payload.strategyRoute;
    delete payload.opportunityCost;
    if (isAdvisorMode(mode) && accountAuth.account?.data) {
      const opportunityCost = portfolioOpportunityCostForStock(
        accountAuth.account.data,
        payload.code,
      );
      if (opportunityCost) payload.opportunityCost = opportunityCost;
    }
    if (
      isAdvisorMode(mode)
      && !payload.realOutcomeLearning
      && accountAuth.account?.data
    ) {
      payload.realOutcomeLearning = buildRealOutcomeLearning(
        accountAuth.account.data,
      );
    }
    const streaming = !!(body && body.stream); // 客户端可选开启 SSE 进度流
    const triggeredPriceReview = isTriggeredReviewEvent(
      payload.reviewEvent,
    );
    const evidenceAccountRevision = resolveEvidenceAccountRevision(
      payload,
      accountAuth.account,
    );
    const sourceTracker = createEvidenceSourceTracker();
    if (isAdvisorMode(mode) && payload.code) {
      const sectorOpportunity = await loadSectorOpportunity(
        payload.code,
      ).catch(() => null);
      if (sectorOpportunity) {
        payload.sectorOpportunity = sectorOpportunity;
        if (sectorOpportunity.matched) {
          payload.sectorContext = {
            ...(payload.sectorContext || {}),
            breadth: sectorOpportunity.sector?.breadth ?? null,
            code: sectorOpportunity.sector?.code || null,
            name: sectorOpportunity.sector?.name || null,
            actionability:
              sectorOpportunity.sector?.actionability || null,
          };
        }
      }
    }
    let evidenceSnapshot = null;
    const ensureEvidenceSnapshot = () => {
      if (!isAdvisorMode(mode) || !payload.code) return null;
      if (!evidenceSnapshot) {
        evidenceSnapshot = createCanonicalEvidenceSnapshot({
          mode,
          payload,
          accountRevision: evidenceAccountRevision,
          promptVersion: sourceTextVersion('advisor', ADVISOR_SYSTEM),
          sourceTrace: sourceTracker.snapshot(),
        });
      }
      return evidenceSnapshot;
    };

    // SSE 进度流：数据采集阶段(查大盘/资金/分时/龙虎榜/量化…)对用户是"黑盒卡住"，
    // 开启后把每个采集里程碑实时推给前端(查大盘✓ 查资金✓ 量化打分✓ 生成建议中…)，
    // 最后再推一个 result 事件带完整结构化结果。非流式调用保持原样(整段 JSON)，向后兼容。
    if (streaming) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      // ★iOS Safari 修复①:阿里云 FC 平台层会给响应注入 `Content-Disposition: attachment`,
      //   iOS Safari 见到 attachment 会把这条 SSE 当成「文件下载」而非「持续流」——于是只收到
      //   一段就断、result 事件永远收不到 → 前端 result=null → "分析未返回结果/生成失败"。
      //   显式覆盖为 inline,强制按内联流处理。
      res.setHeader('Content-Disposition', 'inline');
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    // 统一出口：流式用 SSE 事件，非流式回退为一次性 JSON
    const emit = (event, data) => { if (streaming) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 断连 */ } } };
    // ★iOS Safari 修复②:深度思考模式下 result 事件要 ~137s 才在流末尾到达,期间若某段
    //   静默过久(移动网络/运营商代理/iOS 空闲回收)连接就被掐断,前端拿不到 result → 生成失败。
    //   每 10s 发一个 SSE 注释心跳(`: hb`),保持连接活跃、刷掉中间层缓冲。注释行不触发前端事件。
    if (streaming) {
      hbTimer = setInterval(() => { try { res.write(`: hb ${Date.now()}\n\n`); } catch { /* 断连 */ } }, 10000);
      if (hbTimer && typeof hbTimer.unref === 'function') hbTimer.unref();
    }
    const stopHeartbeat = () => { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } };
    const finish = (obj) => {
      stopHeartbeat();
      const snapshot = ensureEvidenceSnapshot();
      let finalized = obj;
      if (
        isAdvisorMode(mode)
        && payload.code
        && obj?.ok === false
        && !payload.previousAdvice
      ) {
        const { error, ...rest } = obj;
        finalized = {
          ...rest,
          ok: true,
          degraded: true,
          fallbackOnly: true,
          warning: error || '解释服务未返回完整结果',
          result: buildFallbackDecisionAdvice({
            mode,
            payload,
            evidenceSnapshot: snapshot,
            error,
          }),
        };
      }
      const output = attachEvidenceSnapshot(finalized, snapshot);
      if (streaming) { emit('result', output); return res.end(); }
      return res.status(200).send(JSON.stringify(output));
    };
    // 采集里程碑进度事件
    const phase = (text, key) => emit('phase', { text, key });
    const quantModelVersion = await resolveQuantModelForRequest(
      req,
      payload.quantModelVersion,
      { account: accountAuth.account },
    );
    payload.quantModelVersion = quantModelVersion;
    if (!(await canUseQuantModel(req, quantModelVersion))) {
      return finish({
        ok: false,
        error: `${quantModelLabel(quantModelVersion)}需要已登录且当前账号已选择该版本`,
      });
    }

    // ===== 全局时间预算:前端浏览器直连阿里云 FC(超时 600s),不受 Vercel 60s 限制 =====
    // 数据采集阶段(补大盘/资金/分时/量化…)可能耗时 15~20s,之后 LLM 生成又要时间。
    // 开启【深度思考(reasoning)】后模型要先跑思维链再输出,军师级复杂题实测可达 120s+,
    // 故 reasoning 开启时把总预算与下方 LLM 超时上限整体放大,避免思维链未完就被掐断降级。
    const START = Date.now();
    const fastMode = body?.fastMode === true && isAdvisorMode(mode);
    const forceReasoning = body?.forceReasoning === true && isAdvisorMode(mode);
    if (isAdvisorMode(mode)) {
      payload.generationProfile = fastMode ? 'FAST' : 'DEEP';
    }
    const configuredReasoning = effectiveReasoning(useRole);
    const reasoningOn = resolveReasoningMode(configuredReasoning, fastMode, forceReasoning);
    // 紧凑事实投影下使用有界预算；超过窗口就快速整理或失败，不占满 FC 600s。
    const BUDGET = resolveAIBudget(reasoningOn, body && body.runtimeBudgetMs);
    const remain = () => BUDGET - (Date.now() - START);
    // stock 模式：接入 RAG（近5日走势+主营+联网新闻）
    let ragText = '';
    let newsRefs = [];
    let searchReference = null;
    let theoryHits = [];
    let theoryRefs = [];
    if (mode === 'stock' && payload.code) {
      try {
        const corpus = await buildCorpus(payload.code, { name: payload.name });
        const hits = await retrieve(
          `${corpus.name} 短线 资金 走势 消息面 基本面`,
          corpus.docs,
          7
        );
        ragText = hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n');
        newsRefs = (corpus.news || []).filter((n) => n.url).slice(0, 5);
      } catch (e) {
        // RAG 失败不阻断主分析
      }
    }

    // t_advice / plan / price / hold_advice / buy_advice / review 模式：服务端补齐"大盘情绪+资金流向+个股历史走势+分时+量化"，让建议有据可依
    if ((mode === 't_advice' || mode === 'plan' || mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') && payload.code) {
      try {
        phase(
          triggeredPriceReview
            ? '正在快速核对实时价格 / 分时 / 主力与散户资金…'
            : '正在采集大盘 / 资金 / 分时 / 龙虎榜 / 量化数据…',
          'collect',
        );
        const origin = internalApiOrigin(req);
        const getJ = (p) => {
          // 内部 API 调用加超时保护(原来无超时——某个内部接口卡住会拖垮整个数据采集、烧光预算)
          const c = new AbortController();
          const to = setTimeout(
            () => c.abort(),
            triggeredPriceReview ? 3500 : 15000,
          );
          return fetch(origin + p, { signal: c.signal })
            .then((r) => {
              if (!r.ok) {
                const error = new Error(`HTTP ${r.status}`);
                error.name = 'HTTPError';
                error.code = `HTTP_${r.status}`;
                throw error;
              }
              return r.json();
            })
            .finally(() => clearTimeout(to));
        };
        // ★采集透明化:每个数据源各自 settle 时立即推 source 事件(名称+成功/失败),
        //   让前端把"黑盒卡住"变成可见的勾选清单(查大盘✓ 查资金✓ 龙虎榜— …)。okFn 判定该源是否取到有效数据。
        const track = (
          key,
          label,
          promise,
          okFn,
          dataAsOf = () => null,
        ) => sourceTracker.track(key, label, promise, {
          isAvailable: okFn,
          dataAsOf,
        }).then(
          (value) => {
            const trace = sourceTracker.snapshot().at(-1);
            emit('source', {
              label,
              ok: trace?.status === 'OK',
              status: trace?.status,
              durationMs: trace?.durationMs,
              dataAsOf: trace?.dataAsOf,
            });
            return value;
          },
          (error) => {
            const trace = sourceTracker.snapshot().at(-1);
            emit('source', {
              label,
              ok: false,
              status: trace?.status || 'ERROR',
              durationMs: trace?.durationMs,
            });
            return null;
          },
        );
        const collect = (
          key,
          label,
          create,
          okFn,
          dataAsOf = () => null,
        ) => {
          if (!shouldCollectTriggeredReviewSource(
            payload.reviewEvent,
            key,
          )) {
            sourceTracker.skip(
              key,
              label,
              'TRIGGERED_REVIEW_FAST_PATH',
            );
            return Promise.resolve(null);
          }
          return track(key, label, create(), okFn, dataAsOf);
        };
        const dailyDetailPromise = triggeredPriceReview
          ? getJ(
            `/api/stock_detail?code=${payload.code}&klt=101&lmt=60`,
          ).then((primary) =>
            selectFreshestDailyDetail(
              primary,
              null,
              { computeTechnicals },
            )
          )
          : Promise.allSettled([
            getJ(
              `/api/stock_detail?code=${payload.code}&klt=101&lmt=60`,
            ),
            fetchKlineTx(payload.code, '101', 120),
          ]).then(([primaryResult, backupResult]) =>
            selectFreshestDailyDetail(
              primaryResult.status === 'fulfilled'
                ? primaryResult.value
                : null,
              backupResult.status === 'fulfilled'
                ? backupResult.value
                : null,
              { computeTechnicals },
            )
          );

        const [mkt, sec, detail, trend, stockFund, lhb, corpus, macroNews, todayQ, dailySummary, macroFlashes] = await Promise.all([
          collect('market', '大盘情绪', () => getJ('/api/market'), (v) => v && v.ok !== false),
          collect('sectorFlow', '板块资金', () => getJ('/api/sectors?type=industry&sort=main'), (v) => v && v.list && v.list.length),
          collect(
            'dailyCandles',
            '个股K线',
            () => dailyDetailPromise,
            (v) => v && v.ok !== false && v.candles && v.candles.length,
            (v) => v?.dailyAsOf || v?.candles?.at(-1)?.date || null,
          ),
          collect('intraday', '分时走势', () => fetchTrend(
            payload.code,
            triggeredPriceReview
              ? {
                  timeoutMs: 1800,
                  parallel: true,
                  maxHosts: 2,
                }
              : undefined,
          ), (v) => Array.isArray(v) && v.length > 0, (v) => v?.at(-1)?.time || null),
          collect(
            'stockFunds',
            '个股资金流',
            () => fetchStockFund(payload.code, {
              timeoutMs: triggeredPriceReview ? 2500 : 7000,
              preferRealtime: triggeredPriceReview,
            }),
            (v) => v != null,
            (v) => v?.asOfDate || null,
          ),
          collect('dragonTiger', '龙虎榜', () => fetchStockLHB(payload.code), (v) => v != null, (v) => v?.date || null),
          collect('stockNews', '消息面/公告', () => buildCorpus(payload.code, { name: payload.name }), (v) => v && v.docs && v.docs.length),
          collect('macroNews', '宏观要闻', () => fetchMacroNews(), (v) => v && v.length),
          collect('quote', '今日实时行情', () => getJ(`/api/quote?codes=${payload.code}&_t=${Date.now()}`), (v) => v && v.list && v.list.length, (v) => v?.list?.[0]?.tradeDate || null),
          collect('dailyReport', '策略日报摘要', () => resolveAdviceDailySummary(
            payload,
            getLatestDailySummary,
            aiSearchConfig,
          ), (v) => v && v.text, (v) => v?.day || null),
          collect('macroFlashes', '财经快讯', () => fetchMacroFlashes(8), (v) => v && v.length),
        ]);
        // ★外部市场环境：把当天策略日报摘要注入，让个股建议结合大盘/板块/海外环境判断
        if (dailySummary && dailySummary.text) payload.dailyReport = dailySummary;
        // ★今日实时行情：这是"当下事实"，优先级高于昨日收盘的 tech/资金
        {
          const q0 = todayQ && todayQ.list && todayQ.list[0];
          if (q0 && q0.price != null) {
            // ★时效闸门:盘前(<9:15)/盘后/休市 时 /api/quote 返回的是【上一交易日收盘快照】,
            //   绝不能当"今日实时行情"。用 marketTimeContext().isLive 判定:
            //   isLive=true(集合竞价/盘中/午间/午盘) → 真·实时行情,可算今日合法价带;
            //   isLive=false(盘前未开盘/盘后/休市) → 昨日收盘口径,不算"今日"涨跌停价(否则会错一天)。
            const mtc = marketTimeContext();
            payload.todayQuote = buildAdvisorTodayQuote(q0, {
              code: payload.code,
              name: payload.name,
              marketTime: mtc,
            });
          }
        }
        if (macroNews && macroNews.length) {
          payload.macroNews = macroNews.map(labeledNewsTitle).filter(Boolean).slice(0, 6);
        }
        if (macroFlashes && macroFlashes.length) payload.macroFlashes = macroFlashes.slice(0, 8);
        phase(
          triggeredPriceReview
            ? '关键实时证据已就位，正在形成终局结论…'
            : '行情 / 资金 / 消息面已就位，正在量化打分…',
          'quant',
        );
        // 消息面：直接取新闻/公告/基本面文档(不做向量检索，省3~5s，避免函数超时)
        if (corpus && corpus.docs && corpus.docs.length) {
          payload.newsDigest = corpus.docs
            .filter((d) => d.type === 'news' || d.type === 'profile' || d.type === 'summary')
            .map((d) => d.text).slice(0, 6);
          if (corpus.news && corpus.news.length) {
            payload.newsHeadlines = corpus.news
              .slice(0, 6)
              .map(labeledNewsTitle)
              .filter(Boolean);
            newsRefs = corpus.news.filter((n) => n.url).slice(0, 5);  // 供前端引用消息来源
          }
        }
        // 行业资讯统一使用豆包搜索。旧定向新闻接口在 FC 云出口持续返回空，
        // 豆包行业结果按四小时缓存并单飞合并，自动复核仍只读缓存。
        const industry = corpus && corpus.profile && corpus.profile.industry;
        const dailyCandles = detail?.ok && Array.isArray(detail.candles)
          ? detail.candles
          : [];
        const hasCandles = dailyCandles.length >= 25;
        const quantReadiness = quantInputReadiness(
          quantModelVersion,
          dailyCandles,
          { allowMinuteBackfill: true },
        );
        // ★让量化模型"基于现在预测未来":盘中把实时价/量并入送模型的最后一根K线。
        //   stock_detail 的日K末根盘中虽是"进行中"的今日bar,但其收盘价可能滞后于 /api/quote 的最新价;
        //   盘中仅覆盖正在形成的今日末根；盘前/盘后/休市不使用实时价覆盖，
        //   由日K主/备源与完整5分钟聚合共同保证末根是最近完整交易时段。
        let quantCandles = dailyCandles;
        let quantRealtime = null;
        if (
          payload.todayQuote
          && payload.todayQuote.live
          && payload.todayQuote.price != null
        ) {
          const tq = payload.todayQuote;
          quantRealtime = {
            price: tq.price, pct: tq.pct, turnover: tq.turnover, volRatio: tq.volRatio,
            asOf: tq.asOfLabel || null, live: true, phase: tq.phase || null,
            marketVolLevel: (mkt && mkt.ok && mkt.breadth) ? mkt.breadth.volLevel : null,
          };
          if (hasCandles) {
            const lastBar = dailyCandles.at(-1);
            const merged = {
              ...lastBar,
              close: tq.price,
              high: Math.max(
                lastBar.high != null ? lastBar.high : tq.price,
                tq.high != null ? tq.high : tq.price,
                tq.price,
              ),
              low: Math.min(
                lastBar.low != null ? lastBar.low : tq.price,
                tq.low != null ? tq.low : tq.price,
                tq.price,
              ),
              open: tq.open != null ? tq.open : lastBar.open,
            };
            quantCandles = [
              ...dailyCandles.slice(0, -1),
              merged,
            ];
          }
        }
        const quantPromise = triggeredPriceReview
          ? (() => {
            sourceTracker.skip(
              'quant',
              '量化预测',
              'TRIGGERED_REVIEW_REUSE_PREVIOUS',
            );
            return Promise.resolve(null);
          })()
          : quantReadiness.ready
          ? track(
            'quant',
            '量化预测',
            fetchSelectedQuantPredict(
              quantModelVersion,
              payload.code,
              quantCandles,
              (payload.holdCost ? {
                cost: payload.holdCost,
                qty: payload.holdQty,
              } : null),
              12000,
              quantRealtime,
              { refreshDailyFromMinutes: true },
            ),
            (value) => !!value?.ok,
            (value) => value?.inputAsOf || value?.asOf || null,
          )
          : (() => {
            sourceTracker.skip(
              'quant',
              '量化预测',
              quantReadiness.reason,
            );
            return Promise.resolve(null);
          })();
        const searchAvailable = (value) =>
          Array.isArray(value?.items) && value.items.length > 0;
        const searchAsOf = (value) => value?.items
          ?.map((item) => item.date)
          .filter(Boolean)
          .sort()
          .at(-1) || null;
        const advisorSearchPromise = triggeredPriceReview
          ? (() => {
            sourceTracker.skip(
              'stockSearch',
              '豆包个股信息',
              'TRIGGERED_REVIEW_REUSE_PREVIOUS',
            );
            sourceTracker.skip(
              'industrySearch',
              '豆包行业资讯',
              'TRIGGERED_REVIEW_REUSE_PREVIOUS',
            );
            return Promise.resolve({
              items: [],
              status: 'skipped',
              billed: false,
              enabled: false,
              stock: {
                items: [],
                status: 'skipped',
                billed: false,
                enabled: false,
              },
              industry: null,
            });
          })()
          : aiSearchConfig.enabled && aiSearchConfig.apiKey
            ? fetchAdvisorSearchBundle({
              code: payload.code,
              name: payload.name || corpus?.name || '',
              industry,
              reviewOrigin: payload.reviewOrigin,
              includeIndustry: !!industry,
            }, {
              stockFetcher: (input) => track(
                'stockSearch',
                '豆包个股信息',
                fetchAdvisorSearch(input, {
                  runtimeConfig: aiSearchConfig,
                }),
                searchAvailable,
                searchAsOf,
              ),
              industryFetcher: (input) => track(
                'industrySearch',
                '豆包行业资讯',
                fetchIndustrySearchSupplement(input, {
                  runtimeConfig: aiSearchConfig,
                }),
                searchAvailable,
                searchAsOf,
              ),
            })
            : Promise.resolve({
              items: [],
              status: 'disabled',
              billed: false,
              enabled: false,
              stock: {
                items: [],
                status: 'disabled',
                billed: false,
                enabled: false,
              },
              industry: null,
            });
        const [quant, advisorSearch] = await Promise.all([
          quantPromise,
          advisorSearchPromise,
        ]);
        const industrySearch = advisorSearch?.industry;
        if (
          !triggeredPriceReview
          && quantModelVersion !== 'default'
          && !quant
        ) {
          return finish({
            ok: false,
            error: `${quantModelLabel(quantModelVersion)}服务未运行或预测不可用，请先开启服务后重试`,
            quantModelVersion,
          });
        }
        if (industry && industrySearch?.items?.length) {
          payload.industry = industry;
          payload.industryNews = industrySearch.items
            .map((item) => aiSearchEvidenceText({
              ...item,
              searchScope: 'industry',
            }))
            .filter(Boolean)
            .slice(0, 5);
          payload.industryNewsSource = 'doubao-search';
        }
        if (advisorSearch?.enabled !== false) {
          payload.aiSearchMeta = {
            provider: 'doubao-global',
            status: advisorSearch?.status || 'unavailable',
            billed: advisorSearch?.billed === true,
            count: advisorSearch?.items?.length || 0,
            fetchedAt: advisorSearch?.fetchedAt || null,
            requestId: advisorSearch?.requestId || null,
            errorCode: advisorSearch?.errorCode ?? null,
            industryProvider: industry ? 'doubao-global' : null,
            stockStatus: advisorSearch?.stock?.status || 'unavailable',
            stockCount: advisorSearch?.stock?.items?.length || 0,
            stockBilled: advisorSearch?.stock?.billed === true,
            industryStatus: industrySearch?.status || (
              industry ? 'unavailable' : 'not-needed'
            ),
            industryCount: industrySearch?.items?.length || 0,
            industryBilled: industrySearch?.billed === true,
          };
        }
        if (advisorSearch?.items?.length) {
          searchReference = buildSearchReference(advisorSearch);
          payload.aiSearchEvidence = advisorSearch.items
            .map(aiSearchEvidenceText)
            .filter(Boolean)
            .slice(0, 8);
          const seenUrls = new Set(newsRefs.map((item) => item?.url).filter(Boolean));
          for (const item of advisorSearch.items) {
            if (!item.url || seenUrls.has(item.url)) continue;
            seenUrls.add(item.url);
            newsRefs.push(item);
            if (newsRefs.length >= 8) break;
          }
        }
        if (lhb) payload.lhb = lhb;
        // 信号回测：用历史K线检验该股"金叉后上涨"的命中率，给预测一个可信度自评(纯计算,无网络)
        if (detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length >= 40) {
          try { const bt = backtestSignal(detail.candles, 5); if (bt) payload.backtest = bt; } catch { /* ignore */ }
        }
        // 量化预测已在上面与行业新闻并行取到(quant)——此处不再重复请求。

        // 大盘情绪
        if (mkt && mkt.ok) {
          const b = mkt.breadth || {};
          payload.market = {
            indices: (mkt.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
            up: b.up, down: b.down, limitUp: b.limitUp, limitDown: b.limitDown,
            upDownRatio: b.down ? +(b.up / b.down).toFixed(2) : null,
            breadthComplete: b.complete !== false,
            amountYi: b.amountYi,        // ★两市实时成交额(亿元)
            volVsAvg5: b.volVsAvg5,      // ★较近5日均量的偏离%
            volLevel: b.volLevel,        // ★放量/平量/缩量
            volumeComparable: b.volumeComparable === true,
            volumeTradeDate: b.volumeTradeDate || null,
            sentiment: mkt.sentiment || null,
          };
        }
        // ★事件确认高把握层(P2:正交高精度筛子)。优先用【离线权威标记】——qlib-service 每日
        //   拉 Tushare limit_list_d/top_list,按高纯度规则(连板≥2 / 涨停封单强 / 龙虎榜净买>0)逐票判定,
        //   holdout 样本外精度 89%~98%,与信号头【并列】给军师。拿不到权威标记时(首日/服务未热更)
        //   回落到基于K线的粗估(pct≥9.8 数连板),保证向后兼容、绝不阻断。
        {
          const ev = {};
          const authTag = (quant && quant.ok && quant.eventTag) ? quant.eventTag : null;
          if (authTag && authTag.confirmed) {
            // 权威口径:真实 Tushare 连板数/封单强度/龙虎榜净买 + 历史精度参考
            ev.source = 'offline';
            if (authTag.streak >= 2) ev.limitStreak = authTag.streak;
            if (authTag.streak >= 1) ev.limitUpToday = true;
            ev.fdStrong = !!authTag.fdStrong;
            if (authTag.lhbNetYi != null) {
              ev.lhbNetYi = authTag.lhbNetYi;
              ev.lhbNetDir = authTag.lhbNetYi > 0 ? '净买入' : authTag.lhbNetYi < 0 ? '净卖出' : '持平';
            }
            ev.reasons = authTag.reasons || [];
            ev.precisionRef = authTag.precisionRef ?? null;
            ev.tradeDate = authTag.tradeDate ?? null;
            ev.highConf = `事件确认命中${ev.reasons.length ? '(' + ev.reasons.join('、') + ')' : ''}` +
              `${ev.precisionRef != null ? `·历史样本外精度约${ev.precisionRef}%` : ''}`;
          } else {
            // 回落:基于已取到的 todayQuote(涨停)与 lhb(龙虎榜)的粗估(无真实连板/封单强度)
            ev.source = 'estimate';
            const tq = payload.todayQuote;
            if (tq && tq.live && tq.isLimitUp) {
              ev.limitUpToday = true;
              const cs = (detail && detail.ok && detail.candles) || [];
              let streak = 0;
              for (let i = cs.length - 1; i >= 0; i--) {
                const state = classifyPriceLimit({
                  code: payload.code,
                  name: payload.name,
                  pct: cs[i]?.pct,
                });
                if (!state.isLimitUp) break;
                streak++;
              }
              ev.limitStreak = streak + 1;  // 含今日
            }
            if (lhb && (lhb.netAmount != null || lhb.net != null)) {
              const net = lhb.netAmount != null ? lhb.netAmount : lhb.net;
              ev.lhbNetYi = +(net / 1e8).toFixed(2);
              ev.lhbNetDir = net > 0 ? '净买入' : net < 0 ? '净卖出' : '持平';
            }
            if (ev.limitStreak >= 2) ev.highConf = `连板≥2梯队(历史样本外次日上涨命中率约87.5%)`;
          }
          if (Object.keys(ev).length > 1 || ev.highConf) {
            payload.eventSignal = ev;
          }
        }
        // 大盘资金流向（板块前3流入/后3流出 + 全市场净额）
        if (sec && sec.ok && Array.isArray(sec.list)) {
          const sorted = [...sec.list].sort((a, b2) => b2.mainInflow - a.mainInflow);
          const yi = (v) => +(v / 1e8).toFixed(1);
          const net = sec.list.reduce((a, s) => a + s.mainInflow, 0);
          payload.marketFlow = {
            netYi: yi(net),
            topInflow: sorted.slice(0, 3).map((s) => ({ name: s.name, inflowYi: yi(s.mainInflow) })),
            topOutflow: sorted.slice(-3).map((s) => ({ name: s.name, inflowYi: yi(s.mainInflow) })),
          };
        }
        // 个股近20日走势（简化：近20日涨跌幅序列 + 均线位置 + 阶段高低）
        if (detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length) {
          const cs = detail.candles;
          const closes = cs.map((c) => c.close);
          const last = closes[closes.length - 1];
          const ma5 = avg(closes.slice(-5)), ma10 = avg(closes.slice(-10)), ma20 = avg(closes.slice(-20));
          const hi20 = Math.max(...cs.slice(-20).map((c) => c.high));
          const lo20 = Math.min(...cs.slice(-20).map((c) => c.low));
          payload.history = {
            last5Pct: cs.slice(-5).map((c) => +c.pct.toFixed(2)),
            ma5: +ma5.toFixed(2), ma10: +ma10.toFixed(2), ma20: +ma20.toFixed(2),
            vsMa5: last >= ma5 ? '站上5日线' : '跌破5日线',
            vsMa20: last >= ma20 ? '在20日线上方(中期偏多)' : '在20日线下方(中期偏弱)',
            high20: +hi20.toFixed(2), low20: +lo20.toFixed(2),
            posInRange: hi20 > lo20 ? +(((last - lo20) / (hi20 - lo20)) * 100).toFixed(0) : null, // 现价在20日区间的位置%
          };
          // 个股历史规律画像（近60日）——做T/建仓/减仓/持仓建议/复盘自动选价的核心依据
          if (mode === 't_advice' || mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') {
            const prof = computeStockProfile(cs);
            if (prof) payload.stockProfile = prof;
          }
          // 专业技术指标摘要（ATR/布林/RSI/KDJ/MACD + 买卖价位锚）——所有定价场景都引用
          if (detail.tech) {
            const t = techSummaryForAI(detail.tech);
            if (t) payload.tech = t;
          }
        }
        // 量化模型打分（CloudBase 微服务，多因子融合）——配置了才有，作为更专业的一层参考
        if (quant && quant.ok) {
          payload.quant = {
            score: quant.score, bias: quant.bias, tDir: quant.tDir,
            forecast: quant.forecast,   // {upProb,expRet,targetLow/Mid/High,direction,confidence}
            nextTradeDayForecast: quant.nextTradeDayForecast || null,
            currentTradingDayForecast:
              quant.currentTradingDayForecast || null,
            forecastAvailability: quant.forecastAvailability || null,
            hitProb: quant.hitProb,     // LGB达标概率(0~1,原始分辨力,未做isotonic校准)
            reads: quant.reads, asOf: quant.asOf,
            inputAsOf: quant.inputAsOf || quant.asOf || null,
            inputSource: quant.inputSource || null,
            inputBarCount: quant.inputBarCount || null,
            modelVersion: quant.modelVersion || 'default',
            selectedModelVersion: quant.selectedModelVersion
              || quantModelVersion,
            runtimeModelVersion: quant.runtimeModelVersion || null,
            modelLabel: quant.modelLabel || '当前生产模型',
            v2: quant.v2 || null,
            v21: quant.v21 || null,
            fallback: quant.fallback || null,
            reliability: quant.reliability || null,
            experimental: quant.experimental === true,
          };
          // ★高把握买点信号头(isotonic校准 + gate≥85%闸门):只有 fired=true 才是"校准后高可信"信号。
          //   连同买入/止盈/止损价一并透传给军师,支撑其"把握闸+赔率闸"双闸门判断(P0"少出手"纪律)。
          const hcs = quant.highConfSignal;
          if (hcs && typeof hcs === 'object') {
            payload.quant.highConfSignal = {
              fired: !!hcs.fired,
              credibility: hcs.credibility ?? null,             // 校准后可信度%
              gate: hcs.gate != null ? Math.round(hcs.gate * 100) : null,
              buyPrice: hcs.buyPrice ?? null,
              takeProfit: hcs.takeProfit ?? null,
              stopLoss: hcs.stopLoss ?? null,
              label: hcs.label ?? null,
            };
          }
          // ★量化透明化:把量化模型的打分/走势方向/概率/目标价/校准信号推给前端展示,
          //   让用户在军师推理前先看到"量化模型给出了什么结论",军师也会显式引用它。
          {
            const f = payload.quant.forecast || {};
            const next = payload.quant.nextTradeDayForecast || {};
            const current = payload.quant.currentTradingDayForecast || {};
            const parts = [];
            if (payload.quant.score != null) parts.push(`综合分${payload.quant.score}${payload.quant.bias ? `(${payload.quant.bias})` : ''}`);
            if (current.direction) parts.push(`今日整日${current.direction}`);
            if (current.upProb != null) parts.push(`今日整日上涨概率${current.upProb}%`);
            if (next.direction) parts.push(`次日${next.direction}`);
            if (next.upProb != null) parts.push(`次日上涨概率${next.upProb}%`);
            if (next.targetLow != null || next.targetHigh != null) {
              parts.push(`次日区间${next.targetLow ?? '—'}~${next.targetHigh ?? '—'}`);
            }
            if (f.horizon) parts.push(`窗口${f.horizon}`);
            if (f.direction) parts.push(`走势${f.direction}`);
            if (f.upProb != null) parts.push(`上涨概率${f.upProb}%`);
            if (f.expRet != null) parts.push(`预期${f.expRet >= 0 ? '+' : ''}${f.expRet}%`);
            if (f.targetLow != null || f.targetHigh != null) parts.push(`目标价${f.targetLow ?? '—'}~${f.targetHigh ?? '—'}${f.targetMid != null ? `(中枢${f.targetMid})` : ''}`);
            const hc = payload.quant.highConfSignal;
            if (hc) parts.push(hc.fired ? `高把握信号✅已触发(可信度${hc.credibility ?? '—'}%)` : `高把握信号未触发(可信度${hc.credibility ?? '—'}%)`);
            emit('quant', {
              score: payload.quant.score ?? null,
              bias: payload.quant.bias || '',
              direction: f.direction ?? null,
              upProb: f.upProb ?? null,
              expRet: f.expRet ?? null,
              targetLow: f.targetLow ?? null,
              targetMid: f.targetMid ?? null,
              targetHigh: f.targetHigh ?? null,
              horizon: f.horizon ?? null,
              nextTradeDayForecast: payload.quant.nextTradeDayForecast || null,
              currentTradingDayForecast:
                payload.quant.currentTradingDayForecast || null,
              forecastAvailability: payload.quant.forecastAvailability || null,
              executionReference: payload.quant.v2?.executionReference || null,
              reads: payload.quant.reads || null,
              inputAsOf: payload.quant.inputAsOf || null,
              inputSource: payload.quant.inputSource || null,
              highConfFired: hc ? !!hc.fired : null,
              highConfCredibility: hc ? (hc.credibility ?? null) : null,
              summary: parts.join(' · '),
            });
          }
        }
        // 当日分时结构（VWAP均价、日内高低、当前节奏、现价相对均价/高低的位置）
        if (trend && trend.length) {
          const prices = trend.map((t) => t.price)
          const now = prices[prices.length - 1]
          const vwap = trend[trend.length - 1].avg // 东财分时自带均价即VWAP
          const dHi = Math.max(...prices), dLo = Math.min(...prices)
          // 节奏：比较最近30分钟与前段
          const seg = Math.min(30, Math.floor(prices.length / 3))
          const recent = prices.slice(-seg)
          const earlier = prices.slice(-seg * 2, -seg)
          const rAvg = avg(recent), eAvg = earlier.length ? avg(earlier) : rAvg
          let rhythm = '横盘震荡'
          if (rAvg > eAvg * 1.006) rhythm = '尾段拉升'
          else if (rAvg < eAvg * 0.994) rhythm = '尾段跳水/回落'
          // 分时形态
          const nearLow = now <= dLo * 1.005
          const nearHigh = now >= dHi * 0.995
          payload.intraday = {
            now: +now.toFixed(2), vwap: +vwap.toFixed(2),
            dayHigh: +dHi.toFixed(2), dayLow: +dLo.toFixed(2),
            vsVwap: now >= vwap ? '现价在均价线上方(日内偏强)' : '现价在均价线下方(日内偏弱)',
            posInDay: dHi > dLo ? +(((now - dLo) / (dHi - dLo)) * 100).toFixed(0) : 50, // 现价在当日区间位置%
            rhythm,
            atDayLow: nearLow, atDayHigh: nearHigh,
          }
        }
        // 个股资金面：小单净额只作为散户行为代理，与主力、价格和量能合参。
        const mergedStockFund = mergeRetailFundFlow(
          stockFund || payload.stockFund,
          payload.todayQuote,
        );
        if (mergedStockFund) payload.stockFund = mergedStockFund;
        // 交易时段标记：非交易时段时，分时/盘口为最后收盘数据，模型据此参考"收盘后"口径
        {
          const nb = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
          const wd = nb.getUTCDay(), hm = nb.getUTCHours() * 60 + nb.getUTCMinutes();
          const trading = wd >= 1 && wd <= 5 && ((hm >= 570 && hm <= 690) || (hm >= 780 && hm <= 900));
          payload.marketPhase = trading ? '盘中(实时数据)' : '非交易时段(以下分时/盘口/资金为最近收盘数据，请按收盘后口径分析，为下一交易时段做准备)';
        }
        // 统一市场状态：军师、组合分析和今日决策共用同一确定性口径。
        if (payload.market) {
          payload.marketEnv = deriveMarketRegime(payload.market);
        }
        // 逆势强票识别(D)：个股相对大盘的强弱——大盘跌它抗跌/资金逆势流入/创近期新高
        {
          const idxAvg = payload.market && (payload.market.indices || []).length ? avg(payload.market.indices.map((i) => i.pct || 0)) : 0;
          // 个股当日涨跌幅：优先今日实时行情，否则用最近日K的 pct
          let stkPct = null;
          if (payload.todayQuote && payload.todayQuote.pct != null) stkPct = payload.todayQuote.pct;
          else if (detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length) {
            const lc = detail.candles[detail.candles.length - 1];
            if (lc && lc.pct != null) stkPct = lc.pct;
          }
          const sf = payload.stockFund;
          const flags = [];
          // 抗跌/强于大盘：大盘跌但个股跌得少或翻红
          if (stkPct != null && idxAvg < -0.3 && stkPct > idxAvg + 0.5) flags.push('强于大盘(抗跌/逆势翻红)');
          // 资金逆势流入：大盘弱但主力近5日净流入
          if (sf && sf.main5dYi != null && sf.main5dYi > 0 && idxAvg < 0) flags.push('资金逆势净流入');
          // 技术创新高/多头：多头排列 + 站上20日线
          const t2 = payload.tech;
          if (t2 && String(t2.maTrend).includes('多头')) flags.push('均线多头(强势结构)');
          if (t2 && t2.boll && t2.boll.pctB != null && t2.boll.pctB >= 80) flags.push('逼近布林上轨(强势)');
          if (flags.length >= 2) payload.counterTrend = { isStrong: true, flags, note: `逆势强票信号:[${flags.join('、')}]。弱市中这类是资金抱团方向，应优先给"小仓做多"而非观望。` };
          else if (flags.length === 1) payload.counterTrend = { isStrong: false, flags, note: `部分强势:[${flags.join('、')}]` };
        }
        // 信号共振计分（0~6）：技术金叉多头 / 主力真流入 / 量化看涨 / 消息面无雷 / 逆势强票 / 龙虎榜聪明钱
        {
          let score = 0; const hit = [];
          const t2 = payload.tech;
          if (t2 && (String(t2.maCross).includes('金叉') || String(t2.maTrend).includes('多头') || (t2.bull != null && t2.bear != null && t2.bull - t2.bear >= 2))) { score++; hit.push('技术偏多(金叉/多头)'); }
          const sf = payload.stockFund;
          if (sf && ((sf.mainNetYi != null && sf.mainNetYi > 0) || (sf.main5dYi != null && sf.main5dYi > 0))) { score++; hit.push('主力资金净流入'); }
          const q2 = payload.quant && payload.quant.forecast;
          if (q2 && ((q2.upProb != null && q2.upProb >= 52) || String(q2.direction).includes('涨'))) { score++; hit.push('量化看涨'); }
          // 消息面无雷（无减持/问询/立案/解禁等负面词）
          const negWords = ['减持', '问询', '立案', '违规', '解禁', '亏损', '预亏', '诉讼', '质押', 'ST', '退市'];
          const newsBlob = [...(payload.newsHeadlines || []), ...(payload.newsDigest || [])].join(' ');
          const hasNeg = negWords.some((w) => newsBlob.includes(w));
          if (newsBlob && !hasNeg) { score++; hit.push('消息面暂无明显利空'); }
          else if (hasNeg) { hit.push('⚠消息面有潜在利空'); }
          // 逆势强票加分(D)：不再因大盘弱扣分，改为个股强则加分
          if (payload.counterTrend && payload.counterTrend.isStrong) { score++; hit.push('逆势强票(抗跌/资金逆流入)'); }
          else if (payload.marketEnv && !payload.marketEnv.weak) { score++; hit.push('大盘不逆风'); }
          if (payload.lhb && payload.lhb.smartMoney) { score = Math.min(6, score + 1); hit.push('龙虎榜有知名游资/机构'); }
          payload.resonance = { score: Math.min(6, score), max: 6, hits: hit, hasNegNews: hasNeg };
        }
        // 综合可信度(0~100)：共振(45%) + 信号回测(20%) + 大盘环境(15%) + 消息面(10%) + 军师历史真实胜率(10%)
        {
          const rez = payload.resonance ? payload.resonance.score / (payload.resonance.max || 6) : 0.4;
          const bt = payload.backtest && payload.backtest.hitRate != null ? payload.backtest.hitRate / 100 : 0.5;
          const env = payload.marketEnv ? payload.marketEnv.score / 100 : 0.5;
          const news = (payload.resonance && payload.resonance.hasNegNews) ? 0.2 : 0.9;
          // 军师历史真实胜率：优先本类胜率，否则综合胜率；样本不足则中性0.5
          const at = payload.advisorTrack;
          const trackWr = at ? (at.modeWinRate != null && at.modeTotal >= 5 ? at.modeWinRate : at.overallWinRate) : null;
          const track = trackWr != null ? Math.max(0, Math.min(1, trackWr / 100)) : 0.5;
          let conf = Math.round((rez * 0.45 + bt * 0.20 + env * 0.15 + news * 0.10 + track * 0.10) * 100);
          // 历史胜率过低(<40%)时进一步压制信心上限，避免"越错越自信"
          if (trackWr != null && trackWr < 40) conf = Math.min(conf, 55);
          conf = Math.min(95, Math.max(15, conf)); // 永远不给100%,也不低于15
          const calibration = calibrateAdviceTrust(conf, at?.trustBands);
          conf = calibration.score;
          let band = conf >= 68 ? '较可信' : conf >= 48 ? '中等' : '低(仅参考)';
          payload.trustScore = {
            score: conf,
            band,
            calibrated: calibration.calibrated,
            calibrationSamples: calibration.sampleSize,
            historicalWinRate: calibration.historicalWinRate,
            note: calibration.calibrated
              ? `已按同信心档${calibration.sampleSize}次历史结果校准，非胜率承诺`
              : '综合共振/信号回测/大盘环境/消息面/军师历史真实胜率得出，非胜率承诺',
          };
        }
        // 风格
        payload.style = payload.style || 'balanced'
      } catch (e) {
        // 补数据失败不阻断
      }
    }

    if (!isAdvisorMode(mode)) {
      const query = searchQueryForMode(mode, payload);
      if (query) {
        const genericSearch = await fetchAiSearchReference({
          query,
          cacheScope: mode === 'scan_pick' ? 'scan' : `ai-${mode}`,
          cacheMinutes: mode === 'daily' ? 60 : 30,
        }, { runtimeConfig: aiSearchConfig });
        searchReference = buildSearchReference(genericSearch);
        if (searchReference) {
          payload.aiSearchEvidence = genericSearch.items
            .map(aiSearchEvidenceText)
            .filter(Boolean)
            .slice(0, 6);
          payload.aiSearchMeta = {
            provider: 'doubao-global',
            status: genericSearch.status,
            billed: genericSearch.billed === true,
            count: genericSearch.items.length,
            fetchedAt: genericSearch.fetchedAt || null,
            requestId: genericSearch.requestId || null,
            errorCode: genericSearch.errorCode ?? null,
          };
          for (const item of genericSearch.items) {
            if (!item.url || newsRefs.some((existing) => existing?.url === item.url)) continue;
            newsRefs.push(item);
            if (newsRefs.length >= 8) break;
          }
        }
      }
    }

    const isAdvisor = isAdvisorMode(mode);
    if (isAdvisor) {
      const tactical = buildShortHorizonTactical(payload);
      payload.shortHorizonTactical = {
        ...tactical,
        actionPolicy: deriveShortHorizonActionPolicy({
          mode,
          tactical,
          reviewEvent: payload.reviewEvent,
        }),
      };
    }
    if (isAdvisor && payload.realOutcomeLearning) {
      payload.realOutcomeContext = realOutcomeContext(
        payload.realOutcomeLearning,
        {
          mode,
          marketRegime: payload.marketEnv?.level,
          tacticalState:
            payload.shortHorizonTactical?.timing?.state,
        },
      );
    }
    const currentEvidenceSnapshot = isAdvisor && payload.code
      ? ensureEvidenceSnapshot()
      : null;
    const useModel = isAdvisor
      ? (useRole === 'review' ? REVIEW_MODEL : ADVISOR_MODEL)
      : MODEL;
    // —— 编排层须与底层实际下发的 reasoning_effort 对齐 ——
    // 深度思考开关既可开在全局(config.reasoning[role]),也可开在【端点级】(ep.reasoning[role])。
    // poolFetch/reasoningForEndpoint 会按端点把有界 reasoning_effort 真实发给上游,但本文件的超时预算、
    // maxTokens、强制中文思维链指令(zhTail)此前只读全局 getReasoning → 端点级开启时三者全按"不思考"跑,
    // 导致军师思维链还没吐完就被短超时掐断、且不回显。此处改为读【真实生效值】:全局开 OR 任一承接该
    // 角色的端点开 → 视为开,撑起长超时+大 token+中文思维链指令,思维链才能完整生成并回显。
    const useReasoning = resolveReasoningMode(effectiveReasoning(useRole), fastMode, forceReasoning);
    const sysPrompt = isAdvisor
      ? (
          fastMode
            ? ADVISOR_FAST_SYSTEM
            : forceReasoning
              ? ADVISOR_DEEP_SYSTEM
              : ADVISOR_SYSTEM
        )
      : SYSTEM_PROMPT;

    // 已采集到的数据 meta——即便 LLM 超时降级，也把这些"确定性数据"回传前端展示(有价值、不空手)
    const collectedMeta = {
      resonance: payload.resonance || null,
      counterTrend: payload.counterTrend || null,
      trustScore: payload.trustScore || null,
      marketEnv: payload.marketEnv || null,
      backtest: payload.backtest || null,
      lhb: payload.lhb ? { onList: true, date: payload.lhb.date, times30d: payload.lhb.times30d, smartMoney: payload.lhb.smartMoney, smartSeats: payload.lhb.smartSeats, buySeats: payload.lhb.buySeats } : null,
      hasNegNews: payload.resonance ? payload.resonance.hasNegNews : null,
      newsHeadlines: payload.newsHeadlines || null,
      macroNews: payload.macroNews || null,
      aiSearch: payload.aiSearchMeta || null,
      fundAsOf: payload.stockFund ? {
        date: payload.stockFund.asOfDate,
        historical: payload.stockFund.isHistorical,
        source: payload.stockFund.source || null,
        fetchedAt: payload.stockFund.fetchedAt || null,
        main5dAvg: payload.stockFund.main5dAvgYi,
        retail5dAvg: payload.stockFund.retail5dAvgYi,
        inflowDays: payload.stockFund.inflowDays,
        retailInflowDays: payload.stockFund.retailInflowDays,
        mainStreak: payload.stockFund.mainStreak ?? null,
        retailStreak: payload.stockFund.retailStreak ?? null,
        historyDayCount:
          payload.stockFund.historyDayCount ?? null,
        historyComplete:
          payload.stockFund.historyComplete === true,
        retailNetYi: payload.stockFund.retailNetYi ?? null,
        retailRelation: payload.stockFund.retailFlow?.relation || null,
      } : null,
      marketPhase: payload.marketPhase || null,
      todayQuote: payload.todayQuote || null,
      dailyReport: payload.dailyReport ? { sessionCn: payload.dailyReport.sessionCn, day: payload.dailyReport.day } : null,
      quantResult: payload.quant || null,
      sectorOpportunity: payload.sectorOpportunity || null,
    };
    const scheduledReviewEvaluation = evaluateScheduledReview({
      origin: payload.reviewOrigin,
      previousDigest: payload.previousEvidenceDigest,
      snapshot: currentEvidenceSnapshot,
      hasPreviousAdvice: !!payload.previousAdvice,
      previousAdvice: payload.previousAdvice,
    });
    const reviewReceipt = buildReviewReceipt({
      previousDigest: payload.previousEvidenceDigest,
      snapshot: currentEvidenceSnapshot,
      previousAdvice: payload.previousAdvice,
      evaluation: scheduledReviewEvaluation,
    });
    const scheduledReviewResponse = buildScheduledReviewGateResponse({
      mode,
      origin: payload.reviewOrigin,
      previousDigest: payload.previousEvidenceDigest,
      snapshot: currentEvidenceSnapshot,
      hasPreviousAdvice: !!payload.previousAdvice,
      previousAdvice: payload.previousAdvice,
      evaluation: scheduledReviewEvaluation,
      reviewReceipt,
      meta: collectedMeta,
      news: newsRefs,
    });
    if (scheduledReviewResponse) {
      phase(
        scheduledReviewResponse.reviewDisposition === 'insufficient'
          ? '关键证据不完整，保留上一版计划'
          : '证据无实质变化，维持上一版计划',
        'review-gate',
      );
      return finish(scheduledReviewResponse);
    }
    if (
      isAdvisor
      && payload.code
      && payload.generationProfile === 'DEEP'
    ) {
      phase('正在提炼短线实战经验…', 'theory');
      const theoryQuery = buildAdvisorTheoryQuery(mode, payload);
      try {
        theoryHits = await sourceTracker.track(
          'theoryKnowledge',
          '短线经验库',
          Promise.resolve(retrieveTheoryKeywords(theoryQuery, 6)),
          {
            isAvailable: (value) =>
              Array.isArray(value) && value.length > 0,
          },
        );
        theoryRefs = theoryReferencesOf(theoryHits);
      } catch {
        theoryHits = [];
        theoryRefs = [];
      }
      const theoryTrace = sourceTracker.snapshot()
        .findLast((item) => item.key === 'theoryKnowledge');
      emit('source', {
        label: '短线经验库',
        ok: theoryRefs.length > 0,
        status: theoryTrace?.status || 'ERROR',
        durationMs: theoryTrace?.durationMs,
      });
      collectedMeta.theoryRefs = theoryRefs;
    }
    // 数据采集后剩余时间不足 → 直接降级返回(不硬闯 LLM 被平台强杀)。带 meta 让前端仍能展示已查到的确定性数据。
    if (remain() < 9000) {
      return finish({
        ok: false, degraded: true, mode, model: useModel, updatedAt: Date.now(),
        error: '数据采集用时较长，本次分析未能在限定时间内完成，请稍后重试。',
        meta: collectedMeta, news: newsRefs,
      });
    }

    phase(
      forceReasoning
        ? '数据齐全，正在形成候选方案…'
        : '数据齐全，正在生成操作建议…',
      'llm',
    );
    // LLM 超时按【剩余预算】动态给：预留 2.5s 兜底返回时间，最少给 8s。
    // 军师模式(t_advice/hold_advice/buy_advice/review/price/plan)走深度研判模型,实测常需 47s+;
    // 开启深度思考(reasoning)后需先跑思维链,参考内容多时军师级复杂题可远超 2 分钟——
    // 深度军师给主判断 90s，并为快速终稿和发布预留独立窗口。
    const llmCap = useReasoning
      ? (isAdvisor ? 140000 : 120000)
      : (isAdvisor ? 120000 : 90000);
    const deepAdvisorMainCap = isAdvisor && useReasoning
      ? 90000
      : llmCap;
    const canFailover = streaming && isAdvisor && endpointCountForRole(cfg, useRole) > 1;
    const retryReserve = canFailover ? Math.min(60000, Math.max(30000, Math.floor(remain() * 0.3))) : 0;
    const llmTimeout = Math.max(
      8000,
      Math.min(
        llmCap,
        deepAdvisorMainCap,
        remain() - retryReserve - 2500,
      ),
    );

    let content = '';
    let finishReason = '';
    let usage = null;
    let streamedReasoning = '';   // 流式路径捕获的思维链原文：模型 JSON 里没吐 reasoning 字段时,用它兜底填充,保证"军师推理过程"持久可见
    let selectedModel = useModel;
    let selectedEndpoint = '';
    // 思维链语言:reasoning 模型的思维链标题默认英文,system + 用户开头指令都压不住时,
    //   在用户消息【末尾】(recency 权重最高)再钉一条最强中文指令,连思维链小标题都要求中文。
    const zhTail = useReasoning
      ? '\n\n【最终要求】内部核验最多五步，每步一句并使用简体中文；不要展开长篇思维链。尽快输出完整JSON。'
      : '';
    const userPrompt = buildUserPrompt(
      mode,
      payload,
      ragText,
      theoryHits,
    ) + zhTail;
    if (streaming) {
      // reasoning 增量做轻量节流:攒到 ~40 字或遇换行再下发,避免事件风暴
      let rbuf = '';
      let lastVisibleReasoning = '';
      const flushR = () => {
        if (!rbuf) return;
        const visible = zhReasonPiece(rbuf);
        if (visible && visible !== lastVisibleReasoning) {
          emit('reasoning', { text: visible });
          lastVisibleReasoning = visible;
        }
        rbuf = '';
      };
      const runStreamFailover = async () => {
        phase('当前端点响应异常，正在切换备用端点快速重试…', 'failover');
        const fallbackTimeout = Math.max(
          8000,
          Math.min(45000, remain() - 3000),
        );
        const fallback = await callChat({
          model: useModel,
          role: useRole,
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'system', content: marketTimePromptBlock() },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          maxTokens: maxTokensForMode(mode, false),
          timeoutMs: fallbackTimeout,
          reasoning: false,
          forceNoReason: true,
          signal: req.signal,
          responseFormat: { type: 'json_object' },
          stream: true,
        });
        if (
          !fallback.resp
          || fallback.resp.__err
          || !fallback.resp.ok
        ) {
          fallback.done(false);
          return false;
        }
        selectedModel = fallback.selectedModel || selectedModel;
        selectedEndpoint = fallback.endpoint || selectedEndpoint;
        emit('model', {
          model: selectedModel,
          endpoint: selectedEndpoint,
        });
        const retried = await pumpChatStream(fallback.resp, {
          onReasoning: (piece) => {
            rbuf += piece;
            if (
              rbuf.length >= 40
              || /[\n。！？]/.test(piece)
            ) flushR();
          },
        }).catch(() => ({
          content: '',
          reasoning: '',
          finishReason: '',
        }));
        flushR();
        content = retried.content || '';
        streamedReasoning = retried.reasoning || '';
        finishReason = retried.finishReason || '';
        const valid = !shouldFailoverAdvisorStream({
          advisor: isAdvisor,
          canFailover: true,
          budgetMs: remain(),
          content,
          reasoning: streamedReasoning,
        });
        fallback.done(valid);
        return valid;
      };
      // ★流式路径(客户端开了 SSE):以 stream:true 调上游,把模型【思维链 reasoning_content】
      //   增量实时推为 reasoning 事件(军师在想什么),正文 content 累积到流结束后再统一解析。
      //   代价是放弃 callChatWithRetry 的一次快速重试——换取"推理过程可见"的实时体验;
      //   失败仍走下方统一降级(带已采集 meta),不会白屏。
      const routed = await callChat({
        model: useModel,
        role: useRole,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'system', content: marketTimePromptBlock() },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        maxTokens: maxTokensForMode(mode, useReasoning),
        timeoutMs: llmTimeout,
        reasoning: useReasoning,
        reasoningEffort: 'medium',
        forceNoReason: fastMode,
        forceReason: forceReasoning,
        signal: req.signal,
        responseFormat: { type: 'json_object' },
        stream: true,
      });
      const { resp, done } = routed;
      selectedModel = routed.selectedModel || useModel;
      selectedEndpoint = routed.endpoint || '';
      emit('model', { model: selectedModel, endpoint: selectedEndpoint });
      if (resp && resp.__err) {
        done(false);
        const timedOut = resp.__err.name === 'AbortError';
        if (!req.signal?.aborted && routed.endpointId) {
          markEndpointUnusable(routed.endpointId);
        }
        const recovered = shouldFailoverAdvisorStream({
          advisor: isAdvisor,
          canFailover,
          requestAborted: req.signal?.aborted,
          budgetMs: remain(),
          responseError: resp.__err,
        }) && await runStreamFailover();
        if (!recovered) {
          return finish({
            ok: false, degraded: true, mode, model: useModel, updatedAt: Date.now(),
            error: timedOut ? '分析生成超时，可稍后重试；如反复超时请缩小问题范围。' : ('网络异常：' + String(resp.__err.message || resp.__err)),
            meta: collectedMeta, news: newsRefs,
          });
        }
      } else if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        done(false);
        return finish({ ok: false, error: `LLM ${resp.status}`, detail: errText.slice(0, 200), meta: collectedMeta });
      } else {
        const pumped = await pumpChatStream(resp, {
          onReasoning: (piece) => {
            rbuf += piece;
            if (
              rbuf.length >= 40
              || /[\n。！？]/.test(piece)
            ) flushR();
          },
        }).catch(() => ({
          content: '',
          reasoning: '',
          finishReason: '',
        }));
        flushR();
        content = pumped.content;
        finishReason = pumped.finishReason;
        streamedReasoning = pumped.reasoning || '';
        const needsFailover = shouldFailoverAdvisorStream({
          advisor: isAdvisor,
          canFailover,
          requestAborted: req.signal?.aborted,
          budgetMs: remain(),
          content,
          reasoning: streamedReasoning,
        });
        done(!needsFailover);
        if (needsFailover) {
          await runStreamFailover();
        }
      }
      // 军师长 JSON 在深度/普通模式都可能达到输出上限。正文为空、不可解析或靠补括号
      // 才解析成功时，立即关闭思考并重新输出完整对象；仍不完整则由任务层拒绝完成并重试。
      const bodyProbe = content.trim()
        ? parseLLMJson(content)
        : { value: null };
      if (shouldRepairAdvisorBody({
        advisor: isAdvisor,
        aborted: req.signal?.aborted,
        budgetMs: remain(),
        parsed: bodyProbe,
      })) {
          phase('模型正文不完整，正在重新整理完整结论…', 'llm');
          const salvTimeout = Math.max(8000, Math.min(45000, remain() - 3000));
          // 补生成是终稿器，不得再次带入整份深度提示词，否则会重走一轮长推理，
          // 耗尽最后的发布窗口。仅提供字段契约、关键事实和已生成尾段。
          const priorTail = (
            streamedReasoning
            || content
            || ''
          ).slice(-2000);
          const repairFacts = deepAdvisorFacts(payload);
          const salvMessages = [
            {
              role: 'system',
              content: '你是军师的最终JSON整理器。禁止分析、禁止思考过程、禁止复述，只输出一个完整闭合的JSON对象。',
            },
            {
              role: 'user',
              content: `上轮深度研判的最终JSON被截断。现在立刻生成完整终稿；没有可靠事实的字段填null，不能省略字段，不能输出markdown。\n\n字段契约：\n${advisorOutputSchema(mode)}\n\n关键事实：\n${JSON.stringify(repairFacts)}\n\n已截断输出尾段：\n${priorTail || '无可用尾段'}`,
            },
          ];
          const salv = await callChat({
            model: useModel,
            role: useRole,
            messages: salvMessages,
            temperature: 0.2,
            maxTokens: maxTokensForMode(mode, false),
            timeoutMs: salvTimeout,
            reasoning: false,                            // 尽力关思维链
            forceNoReason: true,                         // ★硬关端点级/全局 reasoning 注入
            signal: req.signal,
            responseFormat: { type: 'json_object' },
            stream: true,                                // ★关键:流式,partial 存活 + 进度可见
          });
          if (salv.resp && !salv.resp.__err && salv.resp.ok) {
            let sc = '', sr = '';
            const sp = await pumpChatStream(salv.resp, {
              onReasoning: (piece) => { rbuf += piece; if (rbuf.length >= 40 || /[\n。！？]/.test(piece)) flushR(); },
              onContent: (piece) => { sc += piece; },
            }).catch(() => ({ content: '', reasoning: '', finishReason: '' }));
            flushR();
            sc = sp.content || sc;
            sr = sp.reasoning || '';
            if (sc.trim()) {
              content = sc;
              finishReason = sp.finishReason || finishReason;
            } else if (sr.trim()) {
              // 补生成又把正文写进思维链通道 → 从中抠 JSON
              const pr = parseLLMJson(sr);
              if (pr && pr.value) content = JSON.stringify(pr.value);
            }
          }
          salv.done();
      }
    } else {
      const routed = await callChatWithRetry({
        model: useModel,
        role: useRole,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'system', content: marketTimePromptBlock() },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,   // JSON 结构化输出：低温提升稳定性与可解析率，减少字段漂移
        maxTokens: maxTokensForMode(mode, useReasoning),
        timeoutMs: llmTimeout,
        reasoning: useReasoning,
        reasoningEffort: 'medium',
        forceNoReason: fastMode,
        forceReason: forceReasoning,
        signal: req.signal,
        responseFormat: { type: 'json_object' },
      }, { budgetLeftMs: () => remain() - 2500 });  // 上游抖动/5xx 且预算足够时快速重试一次；abort/网络错误不抛出 → 转入降级返回
      const { resp, done } = routed;
      selectedModel = routed.selectedModel || useModel;
      selectedEndpoint = routed.endpoint || '';
      done();

      // LLM 超时/网络错误 → 结构化降级返回(带已采集 meta)，前端可提示"重试/缩小范围"而非"服务不可用"
      if (resp && resp.__err) {
        const timedOut = resp.__err.name === 'AbortError';
        return finish({
          ok: false, degraded: true, mode, model: useModel, updatedAt: Date.now(),
          error: timedOut ? '分析生成超时，可稍后重试；如反复超时请缩小问题范围。' : ('网络异常：' + String(resp.__err.message || resp.__err)),
          meta: collectedMeta, news: newsRefs,
        });
      }

      if (!resp.ok) {
        const errText = await resp.text();
        return finish({ ok: false, error: `LLM ${resp.status}`, detail: errText.slice(0, 200), meta: collectedMeta });
      }

      const j = await resp.json().catch(() => null);
      if (!j) {
        return finish({
          ok: false, degraded: true, mode, model: useModel, updatedAt: Date.now(),
          error: '模型返回解析失败，请稍后重试。', meta: collectedMeta, news: newsRefs,
        });
      }
      content = j.choices?.[0]?.message?.content || '';
      finishReason = j.choices?.[0]?.finish_reason || '';
      usage = j.usage || null;
    }

    // ★通道兜底(实测线上真凶):部分 OpenAI 兼容网关(如 gpt-5.6-terra)在深度思考时
    //   会把【完整的正文 JSON 整个写进 reasoning_content 思维链通道】,而 delta.content 全程为空。
    //   现象="思考完了→前端却报生成失败/不展示"(content 空命中下方降级,或解析不出)。
    //   兜底策略:正文为空、或正文里根本抠不出合法 JSON 时,回到思维链原文里再抠一次——
    //   实测能从思维链救回完整 31 字段建议(见诊断)。streamedReasoning 仅流式路径有;
    //   非流式路径正文本就不空,不受影响。
    const salvageFromReasoning = () => {
      if (!streamedReasoning || !streamedReasoning.trim()) return null;
      const pr = parseLLMJson(streamedReasoning);
      return pr && pr.value ? pr : null;
    };

    // 解析模型返回的 JSON（容错：剥离 ```json 包裹 + 截断补齐）
    let parsed = content.trim() ? parseLLMJson(content) : { value: null, salvaged: false, repaired: false };
    // 正文抠不出对象(空正文 / 只解析出 null) → 从思维链通道兜底救 JSON
    if (!parsed.value) {
      const rescued = salvageFromReasoning();
      if (rescued) {
        parsed = rescued;
        // 思维链已被当作正文消费,别再把整段思维链回填成 reasoning 字段(会把 JSON 原文塞进展示)
        streamedReasoning = '';
      }
    }
    // 兜底后仍无任何可用对象 → 才真正判定"模型未返回有效内容"
    if (!parsed.value && !content.trim()) {
      return finish({
        ok: false, degraded: true, mode, model: useModel, updatedAt: Date.now(),
        error: '模型未返回有效内容，请稍后重试。', meta: collectedMeta, news: newsRefs,
      });
    }
    // ★truncated 判定(既不误报、也绝不漏报):
    //   ① 正文 JSON 完全解析不出(value=null)→ 只能落 raw 兜底 → 一定是残缺,truncated=true;
    //   ② parseLLMJson 走了【截断补齐】路径(parsed.repaired,补了引号/括号才解析成功)→ 正文尾部真被截断,truncated=true;
    //   ③ 一次干净解析成功,或仅"从前后噪声里抠出一个【完整闭合】对象"(salvaged=true 但 repaired=false)
    //      → 对象本身完整,不算截断。即便 finish_reason=length(深度思考网关把思维链 token 计入 max_tokens
    //      触发 length,但正文 JSON 已闭合)也不误报"建议被截断"。
    const truncated = !parsed.value || !!parsed.repaired;
    let result = parsed.value || { raw: content, truncated };
    if (mode === 'scan_pick' && result && typeof result === 'object' && !result.raw) {
      const allowedCodes = (payload.candidates || []).map((item) => item && item.code).filter(Boolean);
      result = normalizePickDecision(result, allowedCodes, payload.candidates || []);
    }
    if (
      ['buy_advice', 'hold_advice', 'review'].includes(mode)
      && result
      && typeof result === 'object'
      && !result.raw
    ) {
      const continuityResult = reconcileAdviceContinuity({
        code: payload.code,
        previous: payload.previousAdvice,
        next: result,
        evidence: continuityEvidenceFromPayload(payload),
        stabilityMode: payload.reviewOrigin === 'auto' ? 'scheduled' : '',
      });
      result = continuityResult.advice;
    }
    if (!streaming) res.status(200);
    // ★服务端兜底纠偏(hold_advice / review / t_advice):LLM 偶尔无视手数上限/合法价带,
    //   这里强制拉回,避免给出"清仓4手(实际只持3手)"或"止损价低于跌停价"这类不可执行的建议。
    if ((mode === 'hold_advice' || mode === 'review' || mode === 't_advice') && result && typeof result === 'object' && !result.raw) {
      try {
        const hq = Number(payload.holdQty);
        const tq = payload.todayQuote || {};
        // 只有实时(盘中)且给了合法价带时才做价格夹取;盘前/盘后 limit* 为 null,
        //   Number(null)===0 会被误判为有限值把价格夹到 0,故用 == null 显式排除。
        const lo = (tq.limitDownPrice == null) ? NaN : Number(tq.limitDownPrice);
        const hi = (tq.limitUpPrice == null) ? NaN : Number(tq.limitUpPrice);
        const notes = [];
        // (1) 手数不得超过实际持仓
        const clampQtyField = (field) => {
          if (!(Number.isFinite(hq) && hq > 0 && typeof result[field] === 'string')) return;
          const m = result[field].match(/(\d+)\s*手/);
          if (!m) return;
          const n = parseInt(m[1], 10);
          const isClear = /清仓/.test(result[field]);
          if (isClear && n !== hq) {
            result[field] = result[field].replace(/\d+\s*手/, hq + '手');
            notes.push(`已按你的真实持仓${hq}手校正清仓数量`);
          } else if (!isClear && n > hq) {
            result[field] = result[field].replace(/\d+\s*手/, hq + '手');
            notes.push(`卖出手数不能超过持仓${hq}手,已校正`);
          }
        };
        // opQty(hold_advice/review 文案手数)
        clampQtyField('opQty');
        // (1b) 底仓为 0(反T已全部卖出未接回):绝对不能再出现任何"卖出/减仓/清仓X手"的建议。
        //   LLM 仍可能把之前卖掉的手数当成还持有("剩余X手拿到收盘/X手清掉"),这里强制纠偏。
        if (Number.isFinite(hq) && hq === 0) {
          const openT = Number(payload.openTNet) || 0; // 负=反T卖出未接回手数
          const soldBack = Math.abs(openT);
          const scrub = (field) => {
            if (typeof result[field] !== 'string') return;
            // 命中"卖/减/清仓...手""拿到收盘""继续持有""让利润跑"等基于"手上有货"的错误指令 → 改写为"接回"口径
            if (/(卖出|减仓|清仓|减半|拿到收盘|拿到尾盘).*?手|清掉|清仓|继续持有|保留持有|让利润(跑|奔跑)|封住.*持有|持有\s*\d+\s*手/.test(result[field])) {
              result[field] = soldBack > 0
                ? `底仓已被反T全部卖出、当前0手在手，无可卖/可持底仓；应择机把之前卖出的${soldBack}手在更低价接回(先买)以完成这笔反T`
                : `当前0手在手，无可卖底仓，不宜再做卖出操作`;
              notes.push('底仓为0(反T未接回),已纠正持有/卖出类指令为接回口径');
            }
          };
          ['opQty', 'actionPlan', 'nextAction', 'headline', 'title', 'reason', 'plain', 'keyLevel', 'invalidation'].forEach(scrub);
          // review:底仓0时 stance 不能是"持有/减仓/清仓",强制拉到"加仓"(接回也算加仓方向)或"观望"
          if (mode === 'review' && soldBack > 0 && /持有|减仓|清仓/.test(String(result.stance || ''))) {
            result.stance = '加仓';
            result.tone = 'red';
            notes.push('底仓为0(反T未接回),stance已从持有/减仓类改为加仓(接回)');
          }
          // review opQty 若仍是"持有/减仓/清仓X手",直接改写为接回口径
          if (mode === 'review' && soldBack > 0 && typeof result.opQty === 'string' && /持有|减仓|清仓/.test(result.opQty)) {
            result.opQty = `接回${soldBack}手`;
          }
          // t_advice:底仓0时禁止反T(先卖),方向只能是正向接回
          if (mode === 't_advice' && result.dir === 'reverse') {
            result.dir = 'positive';
            if (result.dirLabel) result.dirLabel = '接回未平反T(先买)';
            notes.push('底仓为0,反T方向已改为先买接回');
          }
        }
        // t_advice 反T卖出腿手数:suggestQty 是数字,反T时不能超过持仓
        if (mode === 't_advice' && Number.isFinite(hq) && result.dir === 'reverse'
            && result.suggestQty != null && Number(result.suggestQty) > hq) {
          result.suggestQty = hq;
          notes.push(`反T先卖手数不能超过持仓${hq}手,已校正`);
        }
        // (2) 越界价格直接作废，禁止把模型错误值静默改造成另一个可执行价。
        const validatePx = (v, label) => {
          const x = Number(v);
          if (!Number.isFinite(x)) return v;
          if (Number.isFinite(lo) && x < lo) { notes.push(`${label}低于跌停价,已作废`); return null; }
          if (Number.isFinite(hi) && x > hi) { notes.push(`${label}高于涨停价,已作废`); return null; }
          return x;
        };
        // hold_advice / review 共用价格字段
        if (result.addPrice != null) result.addPrice = validatePx(result.addPrice, '加仓价');
        if (result.reducePrice != null) result.reducePrice = validatePx(result.reducePrice, '减仓价');
        if (result.stopPrice != null) result.stopPrice = validatePx(result.stopPrice, '止损价');
        if (result.targetPrice != null) result.targetPrice = validatePx(result.targetPrice, '目标价');
        // t_advice 两腿价
        if (result.leg1Price != null) result.leg1Price = validatePx(result.leg1Price, '第一腿价');
        if (result.leg2Price != null) result.leg2Price = validatePx(result.leg2Price, '第二腿价');
        // review 关键价 support/resistance 不改(仅为参考位),但 keyLevel 是文案,不做数字夹取

        // (3) ★金额严格重算·不信任模型心算★
        //   资金额恒等于:手数 × 100股/手 × 参考价。模型常犯"15手×50.5元算成7575元(漏了×10)"这类错。
        //   这里按结构化字段重算 opAmount/planAmount,并把 actionPlan/nextAction 文案里的"约用XXXX元"就地改对。
        try {
          const round0 = (n) => Math.round(n);
          // 解析一段文字里的手数(取第一处"N手")
          const handsIn = (s) => { const m = typeof s === 'string' && s.match(/(\d+(?:\.\d+)?)\s*手/); return m ? parseFloat(m[1]) : null; };
          // 结构化动作 → 该用哪个参考价
          const act = String(result.action || result.stance || '');
          const isBuySide = /加仓|买入|买回|接回|试仓|试错|回调.*买|立即买/.test(act) || /买回|接回|加仓|买入/.test(String(result.opQty || ''));
          const isSellSide = /减仓|清仓|卖出/.test(act) || /减仓|清仓|卖/.test(String(result.opQty || ''));
          // buy_advice 用 buyPrice/planQty;hold_advice/review 用 add/reduce + opQty
          const refPxStruct = mode === 'buy_advice'
            ? Number(result.buyPrice)
            : (isBuySide ? Number(result.addPrice) : isSellSide ? Number(result.reducePrice) : NaN);
          const handsStruct = mode === 'buy_advice'
            ? Number(result.planQty)
            : (handsIn(result.opQty));
          // 3a. 重算结构化金额字段(opAmount / planAmount)
          const amtField = mode === 'buy_advice' ? 'planAmount' : 'opAmount';
          if (Number.isFinite(refPxStruct) && refPxStruct > 0 && Number.isFinite(handsStruct) && handsStruct > 0) {
            const correct = round0(handsStruct * 100 * refPxStruct);
            const prev = result[amtField];
            const prevNum = typeof prev === 'string' ? parseFloat(String(prev).replace(/[^\d.]/g, '')) : Number(prev);
            if (!Number.isFinite(prevNum) || Math.abs(prevNum - correct) > Math.max(1, correct * 0.02)) {
              result[amtField] = String(correct);
              notes.push(`资金额已按 ${handsStruct}手×100×${refPxStruct}元=${correct}元 严格重算`);
            }
          }
          // 3b. 修正文案里的"约用/约需/回笼 XXXX 元"——用文案自身的"N手"与"按X元"重算,避免漏乘/多乘
          const fixMoneyInText = (field) => {
            const t = result[field];
            if (typeof t !== 'string') return;
            const hands = handsIn(t);
            // 文案里的参考价:优先"按X元(估算/计算/挂单)",否则用结构化参考价
            let px = null;
            const pm = t.match(/按\s*([\d.]+)\s*元/);
            if (pm) px = parseFloat(pm[1]);
            else if (Number.isFinite(refPxStruct)) px = refPxStruct;
            if (!(hands > 0 && px > 0)) return;
            const correct = round0(hands * 100 * px);
            // 命中"(约|共|需|用|花|回笼|支出|买入|卖出)...数字元"里的金额并纠正(排除百分比/价位本身)
            result[field] = t.replace(/((?:约(?:需|用|花|支出|回笼)?|共|需|回笼|合计)\s*)([\d,]{3,})(\s*元)/g, (full, pre, num, suf) => {
              const v = parseFloat(num.replace(/,/g, ''));
              // 只纠"资金总额"量级(≥1000元且与正确值偏差>2%);价位类小数字不动
              if (Number.isFinite(v) && v >= 1000 && Math.abs(v - correct) > Math.max(1, correct * 0.02)) {
                notes.push(`${field}资金额 ${v}→${correct}(按${hands}手×100×${px}元严格重算)`);
                return pre + correct + suf;
              }
              return full;
            });
          };
          if (isBuySide || isSellSide) {
            ['actionPlan', 'nextAction', 'reason', 'positionNote', 'plain'].forEach(fixMoneyInText);
          }
        } catch { /* 金额重算失败不影响主流程 */ }

        if (notes.length) result.serverAdjust = notes.join('；');
      } catch { /* 兜底纠偏失败不影响主流程 */ }
    }
    if (['buy_advice', 'hold_advice', 'review', 't_advice'].includes(mode) && result && typeof result === 'object' && !result.raw) {
      result = reconcileAdviceNumbers({ mode, result, payload }).result;
    }
    if (
      ['buy_advice', 'hold_advice'].includes(mode)
      && result
      && typeof result === 'object'
      && !result.raw
    ) {
      result = applyPortfolioRiskPolicy({ mode, result, payload }).result;
    }
    if (
      ['t_advice', 'hold_advice', 'review'].includes(mode)
      && result
      && typeof result === 'object'
      && !result.raw
    ) {
      result = applyTActionAdvicePolicy({ mode, result, payload });
    }
    if (
      ['hold_advice', 'review'].includes(mode)
      && result
      && typeof result === 'object'
      && !result.raw
    ) {
      result = applyShortHorizonExitPolicy({
        mode,
        result,
        payload,
      });
    }
    if (
      ['buy_advice', 'hold_advice', 'review'].includes(mode)
      && result
      && typeof result === 'object'
      && !result.raw
      && payload.reviewEvent
    ) {
      result = normalizeTriggeredReviewDecision({
        mode,
        result,
        payload,
      });
    }
    if (
      ['buy_advice', 'hold_advice'].includes(mode)
      && result
      && typeof result === 'object'
      && !result.raw
    ) {
      result.decisionContext = buildAdviceDecisionContext(mode, payload);
    }
    if (
      isAdvisorMode(mode)
      && result
      && typeof result === 'object'
      && !result.raw
    ) {
      result = attachShortHorizonSummary(
        result,
        payload.shortHorizonTactical,
      );
      result.quantContext = buildQuantAdviceContext(
        payload.quant,
        quantModelVersion,
      );
      result.fundContext = compactStockFundSnapshot(payload.stockFund);
      result.knowledgeActionPlan = buildKnowledgeActionPlan(result, { mode });
      result.knowledgeActionScore = scoreKnowledgeActionPlan(
        result.knowledgeActionPlan,
      );
      const accountCircuitBreaker = evaluateAccountCircuitBreaker({
        account: {
          ...(accountAuth.account?.data?.account || {}),
          ...(payload.account || {}),
        },
        portfolio: {
          position: payload.account?.position,
          industryWeights: payload.account?.industryWeights || [],
        },
        closed: accountAuth.account?.data?.closed || [],
        executionPlans:
          accountAuth.account?.data?.executionPlans || [],
      });
      result.decisionPlan = compileDecisionPlan({
        mode,
        advice: result,
        payload,
        evidenceSnapshot: currentEvidenceSnapshot,
        accountCircuitBreaker,
      });
      const terminalAlignment = enforceTriggeredReviewDecisionPlan({
        mode,
        result,
      });
      if (terminalAlignment.changed) {
        result = terminalAlignment.result;
        result.decisionPlan = compileDecisionPlan({
          mode,
          advice: result,
          payload,
          evidenceSnapshot: currentEvidenceSnapshot,
          accountCircuitBreaker,
        });
      }
      result.priceContract = result.decisionPlan.priceContract;
      result.executionPlan = compileExecutionPlan({
        decisionPlan: result.decisionPlan,
        code: payload.code,
        name: payload.name,
        accountRevision: evidenceAccountRevision,
        accountTradeFingerprint: accountTradeStateFingerprint(
          accountAuth.account?.data || {},
        ),
        adv20:
          payload.liquidity?.adv20
          ?? payload.todayQuote?.amount
          ?? null,
        urgency: ['EXIT', 'REDUCE'].includes(
          result.decisionPlan.action,
        ) ? 'HIGH' : 'NORMAL',
      });
      if (['hold_advice', 't_advice'].includes(mode)) {
        const currentPrice = Number(
          payload.todayQuote?.price
          ?? payload.intraday?.now
          ?? payload.currentPrice,
        );
        const atr = Number(
          payload.tech?.atr?.atr
          ?? payload.tech?.atr,
        );
        const atrPct = Number(payload.tech?.atrPct)
          || (
            Number.isFinite(atr)
            && atr > 0
            && Number.isFinite(currentPrice)
            && currentPrice > 0
              ? atr / currentPrice * 100
              : null
          );
        const dayHigh = Number(
          payload.todayQuote?.high
          ?? payload.intraday?.dayHigh,
        );
        const dayLow = Number(
          payload.todayQuote?.low
          ?? payload.intraday?.dayLow,
        );
        const amplitudePct = (
          Number.isFinite(dayHigh)
          && Number.isFinite(dayLow)
          && Number.isFinite(currentPrice)
          && currentPrice > 0
        ) ? (dayHigh - dayLow) / currentPrice * 100 : null;
        const tEligibility = evaluateTGridEligibility({
          marketRegime: payload.marketEnv?.regime || 'UNKNOWN',
          hasBasePosition: Number(payload.holdQty) > 0,
          sellableLots: Number(payload.sellableTodayQty) || 0,
          adv20:
            payload.liquidity?.adv20
            ?? payload.todayQuote?.amount
            ?? 0,
          atrPct,
          amplitudePct,
          materialNegativeNews:
            payload.resonance?.hasNegNews === true,
          isLimitDown: payload.todayQuote?.isLimitDown === true,
          completedToday:
            Number(payload.tContext?.completedTodayCount) || 0,
          netBuyLots: Math.max(0, Number(payload.openTNet) || 0),
        });
        result.tGridExperiment = buildTGridExperiment({
          eligibility: tEligibility,
          referencePrice: currentPrice,
          baseLots: Number(payload.holdQty) || 0,
          maxNetBuyLots: 1,
          atrPct,
        });
      }
      collectedMeta.accountCircuitBreaker = {
        schemaVersion: accountCircuitBreaker.schemaVersion,
        allowRiskIncrease:
          accountCircuitBreaker.allowRiskIncrease,
        riskBudgetMultiplier:
          accountCircuitBreaker.riskBudgetMultiplier,
        riskBudgetReason:
          accountCircuitBreaker.riskBudgetReason,
        blockerCodes: accountCircuitBreaker.blockerCodes,
        reservedBuyCash: accountCircuitBreaker.reservedBuyCash,
      };
    }
    // 明确输出「买入手数」的规范化整数字段:planQty 原文常为 "5手"/"约5手"/"5~8手" 等字符串,
    // 这里抽取首个整数为 planQtyNum,供自选卡「买入手数」直接消费,避免 Number() 得 NaN。
    if (mode === 'buy_advice' && result && result.planQty != null && result.planQtyNum == null) {
      const m = String(result.planQty).match(/-?\d+(?:\.\d+)?/);
      if (m) { const n = Math.trunc(Number(m[0])); if (Number.isFinite(n)) result.planQtyNum = n; }
    }
    // ★思维链持久化:流式路径把模型思维链实时推给了前端(reasoning 事件),但生成结束、卡片落库后,
    //   前端展示的是最终 result.reasoning。若模型没在 JSON 里单独吐 reasoning 字段(多数网关只把思维链
    //   走 reasoning_content / <think>,不会重复进 JSON),就用本次流式捕获的思维链原文兜底填充,
    //   保证"军师推理过程"在生成完成后依然可见(修复端点+深度思考场景下推理消失)。
    if (result && typeof result === 'object' && !result.raw
        && (!result.reasoning || !String(result.reasoning).trim())
        && streamedReasoning && streamedReasoning.trim()) {
      result.reasoning = zhReasonPiece(streamedReasoning.trim());
    } else if (result && typeof result === 'object' && !result.raw && result.reasoning) {
      result.reasoning = zhReasonPiece(String(result.reasoning));
    }
    if (result && typeof result === 'object' && !result.raw) {
      if (isAdvisorMode(mode) && result.fundNote) {
        result.fundNote = normalizeFundNoteHistory(
          result.fundNote,
          payload.stockFund,
        );
      }
      if (searchReference) result.searchReference = searchReference;
      else delete result.searchReference;
      result.theoryRefs = theoryRefs;
      result = humanizeAdviceTextFields(result);
      if (isAdvisorMode(mode)) {
        result.presentation = compileAdvicePresentationV3(result);
      }
    }
    return finish({
      ok: true,
      mode,
      model: selectedModel,
      endpoint: selectedEndpoint,
      updatedAt: Date.now(),
      result,
      truncated,
      news: newsRefs,
      searchReference,
      reviewDisposition: scheduledReviewEvaluation.disposition,
      reviewReason: scheduledReviewEvaluation.reason,
      reviewReceipt,
      // 可信度元信息：供前端展示共振灯/环境/龙虎榜/消息面(不依赖模型自报)
      meta: collectedMeta,
      usedRag: !!ragText,
      usage: usage || null,
    });
  } catch (e) {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (res.headersSent || (res.getHeader && String(res.getHeader('Content-Type') || '').includes('event-stream'))) {
      try { res.write(`event: result\ndata: ${JSON.stringify({ ok: false, error: String(e.message || e) })}\n\n`); } catch { /* ignore */ }
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}
