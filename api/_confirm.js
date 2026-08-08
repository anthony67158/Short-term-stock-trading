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
import { callChat, parseLLMJson } from './_llm.js';
import { getModel, getReasoning } from './_llm_config.js';

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
function intradayPrimitives(trends, preClose) {
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
  const pctFromPre = preClose > 0 ? round((price - preClose) / preClose * 100, 2) : null;
  return {
    price: round(price), vwap: round(vwap), pctFromPre,
    aboveVwap, mom5Pct, volShrink, volSurge, higherLows, lowerHighs,
    winLow: round(winLow), winHigh: round(winHigh), bars: ts.length,
    lastTime: last.time,
  };
}

// ---- 确定性确认判定:按交易语义(buy/sell/stop)对盘中原语 + 技术面打分 ----
// 返回 { decision:'confirm'|'wait', score, hits:[命中的信号文字] } —— 这是 LLM 不可用时的兜底结论,
// 也作为 LLM 的「客观依据」一并喂给它。此处保守:证据不足一律 wait,绝不轻易 confirm。
function deterministicJudge(side, prim, tech) {
  const hits = [];
  let score = 0;
  const macd = tech && tech.macd;
  const rsi = tech && typeof tech.rsi === 'number' ? tech.rsi : null;
  if (side === 'buy') {
    if (prim.higherLows) { score += 1; hits.push('分时低点抬高,止跌迹象'); }
    if (prim.aboveVwap) { score += 1; hits.push('站回分时均价线(VWAP)上方'); }
    if (prim.mom5Pct >= 0.2) { score += 1; hits.push(`近5分钟企稳回升(+${prim.mom5Pct}%)`); }
    if (prim.volShrink) { score += 0.5; hits.push('回踩缩量,抛压衰竭'); }
    if (macd && macd.cross === 'gold') { score += 1; hits.push('日线MACD金叉'); }
    if (rsi != null && rsi <= 35) { score += 0.5; hits.push(`RSI低位(${rsi})具反弹动能`); }
  } else if (side === 'sell') {
    if (prim.lowerHighs) { score += 1; hits.push('分时高点压低,冲高滞涨'); }
    if (prim.aboveVwap === false) { score += 1; hits.push('跌回分时均价线(VWAP)下方'); }
    if (prim.mom5Pct <= -0.2) { score += 1; hits.push(`近5分钟冲高回落(${prim.mom5Pct}%)`); }
    if (prim.volSurge && prim.mom5Pct <= 0.1) { score += 1; hits.push('放量不涨,疑似出货'); }
    if (macd && macd.cross === 'dead') { score += 1; hits.push('日线MACD死叉'); }
    if (rsi != null && rsi >= 68) { score += 0.5; hits.push(`RSI高位(${rsi})回落风险`); }
  } else { // stop:止损须「真跌破」而非瞬时插针
    if (prim.aboveVwap === false) { score += 1; hits.push('运行在分时均价线下方(弱势)'); }
    if (prim.mom5Pct <= -0.3) { score += 1; hits.push(`近5分钟持续走弱(${prim.mom5Pct}%)`); }
    if (!prim.higherLows) { score += 1; hits.push('分时不断创新低,未见企稳'); }
    if (prim.volSurge && prim.mom5Pct < 0) { score += 1; hits.push('放量下跌,跌破有效'); }
    if (macd && macd.cross === 'dead') { score += 0.5; hits.push('日线MACD死叉共振'); }
  }
  // 阈值:≥2.5 视为确定性证据充分 → confirm;否则 wait
  const decision = score >= 2.5 ? 'confirm' : 'wait';
  return { decision, score: round(score, 1), hits };
}

// ---- LLM Judge:最终研判闸门 ----
// 喂:交易意图 + 建议的确认条件/失效条件 + 确定性结论 + 技术面摘要 + 分时快照。
// 要求返回严格 JSON:{decision:'confirm'|'wait'|'invalid', confidence:0-100, reason:'一句话'}。
async function llmJudge({ side, a, name, advice, prim, tech, det }) {
  const model = getModel('judge');
  if (!model) return null;   // 未配置 judge 端点/模型 → 跳过 LLM,用确定性结论
  const sideZh = side === 'buy' ? '买入(低吸/补仓)' : side === 'sell' ? '卖出(止盈/减仓)' : '止损离场';
  const adv = advice || {};
  const sys = '你是严谨的A股短线交易确认闸门。价格已触及关键价位,但「到价≠立刻动手」。'
    + '你的唯一任务:结合盘中走势与建议条件,判断【此刻是否真正到了动手时机】。'
    + '保守优先:证据不足则 wait;若交易逻辑已被破坏(如买点却已放量跌破失效价)则 invalid。'
    + '只输出 JSON,不要多余文字。';
  const payload = {
    股票: `${name || a.code}(${a.code})`,
    本次交易意图: sideZh,
    关键价位: a.value,
    当前价: prim.price,
    分时快照: {
      较昨收: prim.pctFromPre != null ? prim.pctFromPre + '%' : null,
      分时均价VWAP: prim.vwap,
      是否站上均价线: prim.aboveVwap,
      近5分钟动量: prim.mom5Pct + '%',
      量能: prim.volSurge ? '放量' : prim.volShrink ? '缩量' : '平稳',
      分时低点是否抬高: prim.higherLows,
      分时高点是否压低: prim.lowerHighs,
    },
    技术面: techSummaryForAI(tech),
    建议给出的确认条件: adv.exitTiming || adv.actionPlan || '(未提供,按通用纪律判断)',
    建议给出的失效条件: adv.invalidation || '(未提供)',
    确定性信号: { 结论: det.decision, 评分: det.score, 命中: det.hits },
  };
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: '请判断此刻交易时机。数据如下(JSON):\n' + JSON.stringify(payload)
      + '\n\n输出格式:{"decision":"confirm|wait|invalid","confidence":0-100,"reason":"一句话中文理由(点明关键依据)"}' },
  ];
  try {
    const { resp, done } = await callChat({
      role: 'judge', model,
      messages,
      temperature: 0,
      maxTokens: 320,
      timeoutMs: 15000,
      responseFormat: { type: 'json_object' },
      reasoning: getReasoning('judge'),
    });
    try {
      if (!resp || resp.__err || !resp.ok) return null;
      const j = await resp.json().catch(() => null);
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      const { value } = parseLLMJson(content || '');
      if (!value || !value.decision) return null;
      const d = String(value.decision).toLowerCase();
      const decision = ['confirm', 'wait', 'invalid'].includes(d) ? d : 'wait';
      return { decision, confidence: Number(value.confidence) || null, reason: String(value.reason || '').slice(0, 200) };
    } finally { done(); }
  } catch { return null; }
}

// ============ 对外主入口 ============
// judgeConfirmation({ alert, name, advice, quote }) → { decision, confidence, reason, side, signals, source }
//   decision: 'confirm' | 'wait' | 'invalid'
//   source:   'llm+ta' | 'ta' (LLM 缺席/失败时的确定性兜底)
// 内部自取分时(fetchTrendsTx)+日线(fetchKlineTx→computeTechnicals);取数失败 → wait(不误发)。
export async function judgeConfirmation({ alert, name, advice, quote } = {}) {
  const a = alert;
  if (!a || !a.code) return { decision: 'wait', reason: '缺少预警对象', side: null, source: 'ta' };
  const side = sideOf(a);
  // 盘中分时(主依据)
  let trendsData = null;
  try { trendsData = await fetchTrendsTx(a.code); } catch { trendsData = null; }
  const prim = trendsData ? intradayPrimitives(trendsData.trends, trendsData.preClose) : null;
  if (!prim) {
    return { decision: 'wait', reason: '分时数据不足,继续观察', side, source: 'ta' };
  }
  // 日线技术面(辅助:MACD/RSI/均线)
  let tech = null;
  try {
    const kl = await fetchKlineTx(a.code, '101', 60);
    if (kl && kl.candles) tech = computeTechnicals(kl.candles);
  } catch { tech = null; }

  const det = deterministicJudge(side, prim, tech);
  const signals = { side, primitives: prim, deterministic: det, techVerdict: tech && tech.verdict };

  // LLM 最终闸门(可回退)
  const llm = await llmJudge({ side, a, name, advice, prim, tech, det });
  if (llm) {
    return {
      decision: llm.decision,
      confidence: llm.confidence,
      reason: llm.reason || (det.hits[0] || '综合研判'),
      side, signals, source: 'llm+ta',
    };
  }
  // 回退:纯确定性结论(不产出 invalid,保守只在 confirm/wait 间取)
  return {
    decision: det.decision,
    confidence: null,
    reason: det.hits.length ? det.hits.join('、') : '证据不足,继续观察',
    side, signals, source: 'ta',
  };
}
