// ============ 智能交易确认闸门(_confirm)============
// 目的(直接回应用户诉求「上班没空盯盘,到点位别急着推交易提示,先弱提醒、真到时机再强提示」):
//   价格触及 AI 建议的关键价位(买点/止损/止盈/补仓/减仓)只代表「开始盯」,不代表「立刻动手」。
//   本模块在【价已到点(watching)】的前提下,判定「真正的交易时机是否已确认」:
//     · 先算【确定性信号】(基于腾讯公开分时 fetchTrendsTx + 日线 fetchKlineTx,computeTechnicals):
//       买入侧看「止跌企稳/站回均价线/缩量」;卖出侧看「冲高滞涨/跌破均价/放量不涨」;止损侧看「真跌破而非插针」。
//     · 再交给【LLM Judge(role:'judge')】做最终研判,喂它:本次交易意图 + 建议的确认条件(exitTiming)/
//       失效条件(invalidation) + 确定性信号 + 技术面摘要 + 分时快照,产出 {decision, confidence, reason}。
//   decision:
//     'confirm' → 真正时机到了 → 上层发【强交易提示】(✅ 可以买入/可以卖出)。
//     'wait'    → 还在观察 → 维持 watching,不打扰。
//     'invalid' → 逻辑已破坏(如买点但已跌破失效价)→ 上层撤下该点位,别再提示买。
//
// 关键约束:
//   · 绝不触碰量化 /predict(36维OHLCV)模型口径——这里只用公开行情 + 通用技术指标 + LLM。
//   · LLM 不可用/超时/解析失败 → 回退到确定性信号的结论,绝不阻断(宁可 wait,不误发强提示)。
//   · 无状态:每次传入 alert/advice/quote,内部自取盘中数据,不缓存跨请求状态。

import { fetchTrendsTx, fetchKlineTx } from './stock_detail.js';
import { computeTechnicals, techSummaryForAI } from './_ta.js';
import { callChatWithRetry, parseLLMJson } from './_llm.js';
import { getModel, getReasoning } from './_llm_config.js';
import { put, hasStorage } from './_blob.js';
import { marketTimeContext } from './_market_time.js';
import { isConfirmationPhase, isMinuteSnapshotFresh, normalizeConfidence } from '../shared/decisionGuards.js';
import { fuseConfirmation } from '../shared/confirmPolicy.js';
import {
  actionIntentOf,
  actionLabelOf,
  adviceSupportsIntent,
  buildJudgeAdviceContext,
} from '../shared/judgeAdviceContext.js';
import { positionGateForAlert } from '../shared/alertPositionPolicy.js';
import { buildJudgeKnowledgeActionAssessment } from '../shared/knowledgeAction.js';
import { quantJudgeDiscipline } from '../shared/quantAdviceContext.js';

export const JUDGE_MAX_TOKENS = 140;

export function buildJudgeUserPrompt(payload) {
  return '请判断此刻交易时机。数据如下(JSON):\n' + JSON.stringify(payload)
    + '\n输出格式:{"decision":"confirm|wait|invalid","confidence":0-100,"reason":"一句话中文理由"}';
}

// ---- 交易语义分类:把一条价位预警归成 buy / sell / stop 三类 ----
// buy : 买点 / 补仓(回踩到位后想低吸)——确认「止跌企稳」才买。
// sell: 止盈 / 减仓(反弹到位后想高抛)——确认「冲高滞涨/回落」才卖。
// stop: 止损(跌破关键价)——确认「真跌破(放量/持续),非瞬时插针」才离场。
export function sideOf(a) {
  if (!a) return 'buy';
  const note = a.note || '';
  if (a.actKind === 'add') return 'buy';
  if (a.actKind === 'reduce') return 'sell';
  if (/止损/.test(note)) return 'stop';
  if (/止盈|减仓/.test(note)) return 'sell';
  if (/买点|补仓|买入/.test(note)) return 'buy';
  // 无 note:按方向兜底(gte 多为止盈类,lte 多为买入/止损类,归到偏保守的一侧)
  if (a.op === 'gte') return 'sell';
  return 'buy';
}

function round(v, d = 2) {
  if (v == null || isNaN(v)) return null;
  const n = Number(v);
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

// ---- 从分时序列提取「盘中确认原语」----
// trends: [{time, price, volume, avg(VWAP)}] 升序;preClose 昨收。
// 返回一组人类可读 + 机器可判的原语,后续确定性判定与 LLM 都消费它。
export function intradayPrimitives(trends, preClose) {
  const ts = Array.isArray(trends) ? trends.filter((t) => t && Number(t.price) > 0) : [];
  if (ts.length < 5) return null;
  const last = ts[ts.length - 1];
  const price = Number(last.price);
  const vwap = Number(last.avg) > 0 ? Number(last.avg) : null;
  // 近 N 分钟窗口(最多取 10 根)
  const win = ts.slice(-10);
  const prices = win.map((t) => Number(t.price));
  const winLow = Math.min(...prices);
  const winHigh = Math.max(...prices);
  // 最近 5 分钟 vs 前 5 分钟量能(判缩量/放量)
  const recent = ts.slice(-5).reduce((s, t) => s + (Number(t.volume) || 0), 0);
  const prior = ts.slice(-10, -5).reduce((s, t) => s + (Number(t.volume) || 0), 0);
  const volShrink = prior > 0 ? recent < prior * 0.85 : false;   // 明显缩量
  const volSurge = prior > 0 ? recent > prior * 1.5 : false;     // 明显放量
  // 5 分钟动量(正=近 5 分钟在涨)
  const ref5 = prices.length >= 6 ? prices[prices.length - 6] : prices[0];
  const mom5Pct = ref5 > 0 ? round((price - ref5) / ref5 * 100, 2) : 0;
  // 抬高低点 / 压低高点(用窗口前半段与后半段的极值比较)
  const half = Math.floor(win.length / 2);
  const lowA = Math.min(...prices.slice(0, half)), lowB = Math.min(...prices.slice(half));
  const highA = Math.max(...prices.slice(0, half)), highB = Math.max(...prices.slice(half));
  const higherLows = lowB >= lowA;   // 后半段最低点不再创新低 → 止跌迹象
  const lowerHighs = highB <= highA; // 后半段最高点不再创新高 → 滞涨迹象
  const aboveVwap = vwap != null ? price >= vwap : null;
  const recent3 = ts.slice(-3);
  const aboveVwapCount3 = recent3.filter((item) =>
    Number(item.avg) > 0 && Number(item.price) >= Number(item.avg)
  ).length;
  const pctFromPre = preClose > 0 ? round((price - preClose) / preClose * 100, 2) : null;
  const vwapDistancePct = vwap > 0 ? round((price - vwap) / vwap * 100, 2) : null;
  const bounceFromLowPct = winLow > 0 ? round((price - winLow) / winLow * 100, 2) : null;
  const drawdownFromHighPct = winHigh > 0 ? round((price - winHigh) / winHigh * 100, 2) : null;
  return {
    price: round(price), vwap: round(vwap), pctFromPre,
    aboveVwap, mom5Pct, volShrink, volSurge, higherLows, lowerHighs,
    aboveVwapCount3, vwapDistancePct, bounceFromLowPct, drawdownFromHighPct,
    winLow: round(winLow), winHigh: round(winHigh), bars: ts.length,
    lastTime: last.time,
  };
}

// ---- 确定性确认判定:按交易语义(buy/sell/stop)对盘中原语 + 技术面打分 ----
// 返回 { decision:'confirm'|'wait', score, hits:[命中的信号文字] } —— 这是 LLM 不可用时的兜底结论,
// 也作为 LLM 的「客观依据」一并喂给它。此处保守:证据不足一律 wait,绝不轻易 confirm。
export function deterministicJudge(side, prim, tech) {
  const hits = [];
  let score = 0;
  const macd = tech && tech.macd;
  const rsi = tech && typeof tech.rsi === 'number' ? tech.rsi : null;
  if (side === 'buy') {
    if (prim.keyDistancePct <= -1.2 && prim.aboveVwap === false && prim.mom5Pct <= -0.2 && !prim.higherLows) {
      return {
        decision: 'invalid', score: 3,
        hits: [`买点下方${Math.abs(prim.keyDistancePct)}%且仍在走弱，低吸逻辑失效`],
      };
    }
    if (prim.keyDistancePct >= 1.5) {
      return {
        decision: 'invalid', score: 3,
        hits: [`已反弹到买点上方${prim.keyDistancePct}%，继续追入赔率不足`],
      };
    }
    if (prim.higherLows) { score += 1; hits.push('分时低点抬高,止跌迹象'); }
    if (prim.aboveVwap) { score += 1; hits.push('站回分时均价线(VWAP)上方'); }
    if (prim.aboveVwapCount3 === 3) { score += 0.5; hits.push('连续3分钟站在VWAP上方'); }
    if (prim.mom5Pct >= 0.2) { score += 1; hits.push(`近5分钟企稳回升(+${prim.mom5Pct}%)`); }
    if (prim.bounceFromLowPct >= 0.3) { score += 0.5; hits.push(`较窗口低点反弹${prim.bounceFromLowPct}%`); }
    if (prim.sinceTouchPct >= 0.15) { score += 0.5; hits.push(`触价后回升${prim.sinceTouchPct}%`); }
    if (prim.volShrink) { score += 0.5; hits.push('回踩缩量,抛压衰竭'); }
    if (macd && macd.cross === 'gold') { score += 0.5; hits.push('日线MACD金叉'); }
    if (rsi != null && rsi <= 35) { score += 0.5; hits.push(`RSI低位(${rsi})具反弹动能`); }
  } else if (side === 'sell') {
    if (prim.lowerHighs) { score += 1; hits.push('分时高点压低,冲高滞涨'); }
    if (prim.aboveVwap === false) { score += 1; hits.push('跌回分时均价线(VWAP)下方'); }
    if (prim.mom5Pct <= -0.2) { score += 1; hits.push(`近5分钟冲高回落(${prim.mom5Pct}%)`); }
    if (prim.drawdownFromHighPct <= -0.25) { score += 1; hits.push(`较窗口高点回撤${Math.abs(prim.drawdownFromHighPct)}%`); }
    if (prim.sinceTouchPct <= -0.15) { score += 0.5; hits.push(`触价后回落${Math.abs(prim.sinceTouchPct)}%`); }
    if (prim.volSurge && prim.mom5Pct <= 0.1) { score += 1; hits.push('放量不涨,疑似出货'); }
    if (macd && macd.cross === 'dead') { score += 0.5; hits.push('日线MACD死叉'); }
    if (rsi != null && rsi >= 68) { score += 0.5; hits.push(`RSI高位(${rsi})回落风险`); }
  } else { // stop:止损须「真跌破」而非瞬时插针
    if (prim.keyDistancePct <= -0.3) { score += 1; hits.push(`已跌破止损线${Math.abs(prim.keyDistancePct)}%`); }
    if (prim.aboveVwap === false) { score += 1; hits.push('运行在分时均价线下方(弱势)'); }
    if (prim.aboveVwapCount3 === 0) { score += 0.5; hits.push('连续3分钟未站回VWAP'); }
    if (prim.mom5Pct <= -0.3) { score += 1; hits.push(`近5分钟持续走弱(${prim.mom5Pct}%)`); }
    if (prim.sinceTouchPct <= -0.2) { score += 0.5; hits.push(`触价后继续下跌${Math.abs(prim.sinceTouchPct)}%`); }
    if (!prim.higherLows) { score += 1; hits.push('分时不断创新低,未见企稳'); }
    if (prim.volSurge && prim.mom5Pct < 0) { score += 1; hits.push('放量下跌,跌破有效'); }
    if (macd && macd.cross === 'dead') { score += 0.5; hits.push('日线MACD死叉共振'); }
  }
  const threshold = side === 'buy' ? 2.5 : 1.5;
  const decision = score >= threshold ? 'confirm' : 'wait';
  return { decision, score: round(score, 1), hits };
}

// ---- LLM Judge:最终研判闸门 ----
// 喂:交易意图 + 建议的确认条件/失效条件 + 确定性结论 + 技术面摘要 + 分时快照。
// 要求返回严格 JSON:{decision:'confirm'|'wait'|'invalid', confidence:0-100, reason:'一句话'}。
async function llmJudge({ a, name, advice, prim, tech, det, position }) {
  const model = getModel('judge');
  if (!model) return null;   // 未配置 judge 端点/模型 → 跳过 LLM,用确定性结论
  const intent = actionIntentOf(a);
  const sideZh = actionLabelOf(a);
  const adv = buildJudgeAdviceContext({ ...(a.judgeContext || {}), ...(advice || {}) });
  const modelDiscipline = quantJudgeDiscipline(adv.quantContext);
  const sys = '你是严谨的A股短线交易确认闸门。价格已触及关键价位,但「到价≠立刻动手」。'
    + '你的唯一任务:结合盘中走势与建议条件,判断【此刻是否真正到了动手时机】。'
    + '军师建议是本次交易计划的上层约束：必须理解其方向、手数、仓位、盈亏比、止损目标、技术资金消息依据与失效条件；'
    + '不得脱离军师建议单独创造相反动作。单个价格只是进入观察的触发边界，不是固定锚点；'
    + '当前持仓状态由服务端账本核验：无持仓只能买入，绝不能解释为加仓、减仓、卖出或止损；'
    + '必须围绕主计划版本、动态价格带、失效条件和触价后的分时结构判断。加仓尤其禁止下跌摊平，必须是军师仍支持加仓且触价后出现止跌确认。'
    + '买入必须保守，客观止跌信号不足一律wait；止盈要重视触价后的冲高回落，避免利润明显回撤；'
    + '止损要重视持续破位，不能因措辞犹豫而拖延。invalid必须有明确客观失效证据，不能只凭主观感觉。'
    + (modelDiscipline ? `量化模型纪律：${modelDiscipline}` : '')
    + '只输出 JSON,不要多余文字。';
  const payload = {
    股票: `${name || a.code}(${a.code})`,
    本次交易意图: sideZh,
    动作类型: intent,
    观察触发价: a.value,
    动态执行区间: intent === 'add' || intent === 'buy'
      ? adv.addZone
      : intent === 'reduce' || intent === 'sell'
        ? adv.reduceZone
        : adv.stopZone,
    当前价: prim.price,
    服务端实时持仓: position ? {
      当前持仓手数: position.liveQty,
      今日可卖手数: position.sellableToday,
    } : null,
    分时快照: {
      较昨收: prim.pctFromPre != null ? prim.pctFromPre + '%' : null,
      分时均价VWAP: prim.vwap,
      是否站上均价线: prim.aboveVwap,
      近5分钟动量: prim.mom5Pct + '%',
      量能: prim.volSurge ? '放量' : prim.volShrink ? '缩量' : '平稳',
      分时低点是否抬高: prim.higherLows,
      分时高点是否压低: prim.lowerHighs,
      连续3分钟站上VWAP次数: prim.aboveVwapCount3,
      距VWAP: prim.vwapDistancePct != null ? prim.vwapDistancePct + '%' : null,
      较窗口低点反弹: prim.bounceFromLowPct != null ? prim.bounceFromLowPct + '%' : null,
      较窗口高点回撤: prim.drawdownFromHighPct != null ? prim.drawdownFromHighPct + '%' : null,
      距关键价: prim.keyDistancePct != null ? prim.keyDistancePct + '%' : null,
      触价后涨跌: prim.sinceTouchPct != null ? prim.sinceTouchPct + '%' : null,
      已观察分钟: prim.observationAgeMin,
    },
    技术面: techSummaryForAI(tech),
    军师完整建议: adv,
    建议给出的确认条件: adv.exitTiming || adv.actionPlan || '(未提供,按通用纪律判断)',
    建议给出的失效条件: adv.invalidation || '(未提供)',
    确定性信号: { 结论: det.decision, 评分: det.score, 命中: det.hits },
    量化模型纪律: modelDiscipline || null,
  };
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: buildJudgeUserPrompt(payload) },
  ];
  try {
    // Judge 必须及时：总预算 10s 内允许一次故障转移，超时立即回退客观信号。
    const startedAt = Date.now();
    const TIMEOUT_MS = 10000;
    const { resp, done } = await callChatWithRetry({
      role: 'judge', model,
      messages,
      temperature: 0,
      maxTokens: JUDGE_MAX_TOKENS,
      timeoutMs: TIMEOUT_MS,
      responseFormat: { type: 'json_object' },
      reasoning: getReasoning('judge'),
    }, { retries: 1, budgetLeftMs: () => TIMEOUT_MS - (Date.now() - startedAt) });
    try {
      if (!resp || resp.__err || !resp.ok) return null;
      const j = await resp.json().catch(() => null);
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      const { value } = parseLLMJson(content || '');
      if (!value || !value.decision) return null;
      const d = String(value.decision).toLowerCase();
      const decision = ['confirm', 'wait', 'invalid'].includes(d) ? d : 'wait';
      return {
        decision,
        confidence: Math.min(
          normalizeConfidence(value.confidence),
          adv.quantContext?.experimental ? 85 : 100,
        ),
        reason: String(value.reason || '').slice(0, 200),
      };
    } finally { done(); }
  } catch { return null; }
}

// ============ 对外主入口 ============
// judgeConfirmation({ alert, name, advice, quote, position }) → { decision, confidence, reason, side, signals, source }
//   decision: 'confirm' | 'wait' | 'invalid'
//   source:   'llm+ta' | 'ta' (LLM 缺席/失败时的确定性兜底)
// 内部自取分时(fetchTrendsTx)+日线(fetchKlineTx→computeTechnicals);取数失败 → wait(不误发)。
export async function judgeConfirmation({ alert, name, advice, quote, position } = {}) {
  const a = alert;
  if (!a || !a.code) {
    return {
      decision: 'wait',
      reason: '缺少预警对象',
      side: null,
      source: 'ta',
      knowledgeAction: buildJudgeKnowledgeActionAssessment({}),
    };
  }
  const side = sideOf(a);
  const intent = actionIntentOf(a);
  const adviceContext = buildJudgeAdviceContext({ ...(a.judgeContext || {}), ...(advice || {}) });
  const knowledgeAction = buildJudgeKnowledgeActionAssessment(
    adviceContext.knowledgeActionPlan || adviceContext,
  );
  const withKnowledgeAction = (result) => ({
    ...result,
    knowledgeAction: result?.knowledgeAction || knowledgeAction,
  });
  if (position) {
    const positionGate = positionGateForAlert(a, position);
    if (!positionGate.allowed) {
      return withKnowledgeAction({
        decision: positionGate.transient ? 'wait' : 'invalid',
        confidence: 100,
        reason: positionGate.reason,
        side,
        actionIntent: intent,
        source: 'account',
        policy: positionGate.policy,
      });
    }
  }
  if (!adviceSupportsIntent(intent, adviceContext)) {
    return withKnowledgeAction({
      decision: 'invalid',
      confidence: 100,
      reason: `最新军师建议已不再支持${actionLabelOf(a)}，原操作点失效`,
      side,
      actionIntent: intent,
      source: 'advice',
      policy: 'advice-mismatch',
    });
  }
  const timeContext = marketTimeContext();
  if (!isConfirmationPhase(timeContext.phase)) {
    return withKnowledgeAction({
      decision: 'wait',
      reason: `${timeContext.phase}不做盘中确认，等待连续竞价`,
      side,
      source: 'ta',
    });
  }
  // 盘中分时(主依据)
  let trendsData = null;
  try { trendsData = await fetchTrendsTx(a.code); } catch { trendsData = null; }
  const prim = trendsData ? intradayPrimitives(trendsData.trends, trendsData.preClose) : null;
  if (!prim) {
    return withKnowledgeAction({ decision: 'wait', reason: '分时数据不足,继续观察', side, source: 'ta' });
  }
  if (!isMinuteSnapshotFresh(prim.lastTime, timeContext.bjNow)) {
    return withKnowledgeAction({
      decision: 'wait',
      reason: `分时快照已过期(${prim.lastTime || '时间未知'}),等待最新成交`,
      side,
      source: 'ta',
    });
  }
  const quotePrice = Number(quote && quote.price);
  prim.quotePrice = quotePrice > 0 ? quotePrice : null;
  prim.sourceSpreadPct = quotePrice > 0
    ? round((prim.price - quotePrice) / quotePrice * 100, 2)
    : null;
  if (prim.sourceSpreadPct != null && Math.abs(prim.sourceSpreadPct) > 0.8) {
    return withKnowledgeAction({
      decision: 'wait',
      reason: `分时价与实时报价偏差${Math.abs(prim.sourceSpreadPct)}%，等待数据源收敛`,
      side,
      source: 'ta',
    });
  }
  const keyPrice = Number(a.value);
  const watchingPrice = Number(a.watchingPrice);
  const watchingAt = Number(a.watchingAt);
  prim.keyDistancePct = keyPrice > 0 ? round((prim.price - keyPrice) / keyPrice * 100, 2) : null;
  prim.sinceTouchPct = watchingPrice > 0 ? round((prim.price - watchingPrice) / watchingPrice * 100, 2) : null;
  prim.observationAgeMs = watchingAt > 0 ? Math.max(0, Date.now() - watchingAt) : null;
  prim.observationAgeMin = prim.observationAgeMs != null ? round(prim.observationAgeMs / 60000, 1) : null;

  // 最短观察期内不调用 LLM；但买点明确跌破/追高失效可立即撤销。
  const preliminary = deterministicJudge(side, prim, null);
  const early = fuseConfirmation({
    side,
    deterministic: preliminary,
    llm: null,
    observationAgeMs: prim.observationAgeMs,
  });
  if (early.policy === 'observation' || early.decision === 'invalid') {
    const result = {
      ...early,
      side,
      signals: { side, primitives: prim, deterministic: preliminary, techVerdict: null },
      source: 'ta',
    };
    const enriched = withKnowledgeAction(result);
    await logVerdict(a, name, prim, enriched);
    return enriched;
  }

  // 日线技术面(辅助:MACD/RSI/均线)
  let tech = null;
  try {
    const kl = await fetchKlineTx(a.code, '101', 60);
    if (kl && kl.candles) tech = computeTechnicals(kl.candles);
  } catch { tech = null; }

  const det = deterministicJudge(side, prim, tech);
  const signals = { side, primitives: prim, deterministic: det, techVerdict: tech && tech.verdict };

  // 强止损客观信号优先，避免等待 LLM 导致风险继续扩大。
  if (side === 'stop' && det.score >= 3) {
    const fused = fuseConfirmation({
      side,
      deterministic: det,
      llm: null,
      observationAgeMs: prim.observationAgeMs,
    });
    const result = { ...fused, side, signals, source: 'ta' };
    const enriched = withKnowledgeAction(result);
    await logVerdict(a, name, prim, enriched);
    return enriched;
  }

  // LLM 最终闸门(可回退)，最终结果由非对称融合策略裁决。
  const llm = await llmJudge({ side, a, name, advice, prim, tech, det, position });
  const fused = fuseConfirmation({
    side,
    deterministic: det,
    llm,
    observationAgeMs: prim.observationAgeMs,
  });
  const result = {
    ...fused,
    side,
    signals,
    source: llm ? 'llm+ta' : 'ta',
    actionIntent: intent,
    knowledgeAction: llm?.knowledgeAction || knowledgeAction,
  };
  await logVerdict(a, name, prim, result);
  return result;
}

// ---- 可观测性:落一条轻量判定日志到 OSS ----
// 目的:事后回看 judge 判得准不准(积累后可对 {decision,confidence} 与实际后续走势做命中率统计)。
// 存储:每个预警每5分钟一个独立对象；最终决策使用独立时间戳对象。
// 独立对象避免并发 read-modify-write 覆盖；await 确保 FC 响应结束前日志真正落 OSS。
async function logVerdict(a, name, prim, result) {
  if (!hasStorage()) return;
  const now = Date.now();
  const d = new Date(now + 8 * 3600 * 1000);   // 东八区
  const day = d.toISOString().slice(0, 10);
  const alertId = String(a.id || `${a.code}-${a.value}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  const decisive = result.decision === 'confirm' || result.decision === 'invalid';
  const bucket = Math.floor(now / (5 * 60 * 1000));
  const key = `confirm_log/${day}/${alertId}-${decisive ? now : bucket}.json`;
  const entry = {
    ts: now,
    code: a.code,
    name: name || a.code,
    side: result.side,
    op: a.op || null,
    keyPrice: a.value != null ? a.value : null,
    price: prim ? prim.price : null,
    pctFromPre: prim ? prim.pctFromPre : null,
    decision: result.decision,
    confidence: result.confidence,
    source: result.source,
    gated: result.gated || false,
    rawDecision: result.rawDecision || result.decision,
    policy: result.policy || null,
    deterministicScore: result.signals?.deterministic?.score ?? null,
    deterministicHits: result.signals?.deterministic?.hits || [],
    keyDistancePct: prim?.keyDistancePct ?? null,
    sinceTouchPct: prim?.sinceTouchPct ?? null,
    drawdownFromHighPct: prim?.drawdownFromHighPct ?? null,
    bounceFromLowPct: prim?.bounceFromLowPct ?? null,
    observationAgeMin: prim?.observationAgeMin ?? null,
    reason: (result.reason || '').slice(0, 160),
  };
  try {
    await put(key, JSON.stringify(entry), {
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
    });
  } catch { /* 日志失败不阻断判定 */ }
}
