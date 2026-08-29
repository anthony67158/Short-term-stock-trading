// ============ 智能交易确认闸门(_confirm)============
// 目的:价格触及 AI 建议的关键价位后立即做一次限时终局判断，禁止围绕同一价格反复复核。
//   价格触及关键价位(买点/止损/止盈/补仓/减仓)后，在当前分时窗口内直接判定:
//     · 先算【确定性信号】(基于腾讯公开分时 fetchTrendsTx + 日线 fetchKlineTx,computeTechnicals):
//       买入侧看「止跌企稳/站回均价线/缩量」;卖出侧看「冲高滞涨/跌破均价/放量不涨」;止损侧看「真跌破而非插针」。
//     · 再交给【LLM Judge(role:'judge')】做最终研判,喂它:本次交易意图 + 建议的确认条件(exitTiming)/
//       失效条件(invalidation) + 确定性信号 + 技术面摘要 + 分时快照,产出 {decision, confidence, reason}。
//   decision:
//     'confirm' → 立即执行买入/加仓/减仓/锁利润等明确动作。
//     'wait'    → 本次终态维持观望/持有，原触发价结束，不再循环。
//     'invalid' → 放弃本次操作，原计划失效，不再围绕该价纠缠。
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
import {
  confirmationPolicy,
  fuseConfirmation,
  shouldCallLlmJudge,
} from '../shared/confirmPolicy.js';
import {
  actionIntentOf,
  actionLabelOf,
  adviceSupportsIntent,
  buildJudgeAdviceContext,
} from '../shared/judgeAdviceContext.js';
import {
  adviceObservationLevels,
  advicePriceLevel,
  advicePriceLevelForIntent,
  priceMatchesAdviceContract,
  sanitizedAdvicePriceContract,
} from '../shared/advicePriceContract.js';
import { positionGateForAlert } from '../shared/alertPositionPolicy.js';
import { buildJudgeKnowledgeActionAssessment } from '../shared/knowledgeAction.js';
import { quantJudgeDiscipline } from '../shared/quantAdviceContext.js';
import {
  compactStockFundSnapshot,
  compareStockFundSnapshots,
  mergeRetailFundFlow,
} from '../shared/retailFundFlow.js';
import {
  fetchResilientStockFund,
  fundAmountYi,
} from './_stock_fund.js';

export const JUDGE_MAX_TOKENS = 260;

export function buildJudgeUserPrompt(payload) {
  const intent = String(payload?.动作类型 || '');
  const outcomes = intent === 'buy'
    ? '立即买入|维持观望|放弃买入'
    : intent === 'add'
      ? '立即加仓|维持持有|放弃加仓'
      : intent === 'stop'
        ? '立即止损|维持持有|放弃本次操作'
        : '立即减仓|锁定利润|维持持有';
  return '请判断此刻交易时机。数据如下(JSON):\n' + JSON.stringify(payload)
    + `\n本次终局结论只能从“${outcomes}”中选择。`
    + '\n输出格式:{"decision":"confirm|wait|invalid","terminalInstruction":"明确操作结论","priceLow":数字或null,"priceHigh":数字或null,"quantity":整数手数或0,"basisType":"已验证理论|实时资金与价格|重大催化","basis":"一句话可追溯依据","confidence":0-100,"reason":"一句话中文理由"}';
}

function compactText(value, maximum = 240) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

export function buildJudgeFundContext(currentInput, baselineInput) {
  const current = compactStockFundSnapshot(currentInput);
  const baseline = compactStockFundSnapshot(baselineInput);
  return {
    available: !!current,
    current,
    baseline,
    change: compareStockFundSnapshots(current, baseline),
  };
}

function lotsOf(value) {
  const match = String(value ?? '').match(/\d+(?:\.\d+)?/)
  const number = match ? Number(match[0]) : Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.trunc(number)
    : 0
}

function terminalOutcome(intent, decision, note = '') {
  if (intent === 'buy') {
    return decision === 'confirm'
      ? ['立即买入', '买入']
      : decision === 'invalid'
        ? ['放弃买入', '不操作']
        : ['维持观望', '不操作']
  }
  if (intent === 'add') {
    return decision === 'confirm'
      ? ['立即加仓', '加仓']
      : decision === 'invalid'
        ? ['放弃加仓', '不操作']
        : ['维持持有', '不操作']
  }
  if (intent === 'stop') {
    return decision === 'confirm'
      ? ['立即止损', '减仓']
      : decision === 'invalid'
        ? ['放弃本次操作', '不操作']
        : ['维持持有', '不操作']
  }
  if (decision === 'confirm') {
    return /止盈|锁利/.test(String(note || ''))
      ? ['锁定利润', '锁利润']
      : ['立即减仓', '减仓']
  }
  return decision === 'invalid'
    ? ['放弃本次操作', '不操作']
    : ['维持持有', '不操作']
}

function decisionRange(value, fallback) {
  const low = Number(value?.low ?? value?.priceLow)
  const high = Number(value?.high ?? value?.priceHigh)
  const point = Number(fallback)
  const left = Number.isFinite(low) && low > 0
    ? low
    : Number.isFinite(point) && point > 0 ? point : null
  const right = Number.isFinite(high) && high > 0
    ? high
    : left
  if (left == null || right == null) return { low: null, high: null }
  return left <= right
    ? { low: round(left, 3), high: round(right, 3) }
    : { low: round(right, 3), high: round(left, 3) }
}

function rangeLabel(range = {}) {
  if (!(range.low > 0) || !(range.high > 0)) return ''
  return range.low === range.high
    ? `${range.low}元`
    : `${range.low}–${range.high}元`
}

function attachTerminalInstruction({
  result = {},
  alert = {},
  intent = '',
  advice = {},
  primitives = {},
  position = null,
} = {}) {
  const [outcome, operation] = terminalOutcome(
    intent,
    result.decision,
    alert.note,
  )
  const zone = intent === 'buy' || intent === 'add'
    ? advice.addZone
    : intent === 'stop'
      ? advice.stopZone
      : advice.reduceZone
  const range = decisionRange(
    result.executionRange || {
      priceLow: result.priceLow,
      priceHigh: result.priceHigh,
    },
    primitives.price ?? alert.decisionPrice ?? alert.value,
  )
  if (
    range.low == null
    && zone
    && Number(zone.low) > 0
    && Number(zone.high) > 0
  ) {
    range.low = round(zone.low, 3)
    range.high = round(zone.high, 3)
  }
  const requested = lotsOf(
    result.quantity
    || alert.opQty
    || advice.opQty,
  )
  const sellable = Math.max(
    0,
    Math.trunc(Number(position?.sellableToday) || 0),
  )
  const quantity = ['sell', 'stop'].includes(intent)
    ? Math.min(requested || sellable, sellable)
    : requested
  const execute = result.decision === 'confirm'
  const theoryBasis = compactText(
    advice.knowledgeActionPlan?.principle,
    240,
  )
  const execution = execute
    ? [
        outcome,
        quantity > 0 ? `${quantity}手` : '',
        rangeLabel(range) ? `执行区间${rangeLabel(range)}` : '',
      ].filter(Boolean).join('，')
    : `${outcome}；本次触发结束，不新增复核价`
  return {
    ...result,
    // 终态指令由服务端根据 decision、方向、区间和手数重建，
    // 不直接信任模型自由文本，避免夹带新观察价或下一轮复核。
    terminalInstruction: execution,
    reviewDecision: {
      schemaVersion: 'triggered-review-decision.v1',
      terminal: true,
      outcome,
      operation,
      priceLow: execute ? range.low : null,
      priceHigh: execute ? range.high : null,
      quantity: execute ? quantity : 0,
      basisType:
        compactText(result.basisType, 40)
        || (theoryBasis ? '已验证理论' : '实时资金与价格'),
      basis:
        compactText(result.basis, 240)
        || theoryBasis
        || compactText(result.reason, 240)
        || '依据原军师计划与本轮触价后的分时结构判断',
    },
  }
}

export function judgePriceContractGate(alert = {}, advice = {}) {
  const contract = sanitizedAdvicePriceContract(advice);
  if (!contract) {
    if (alert.candCode || alert.actCode) {
      return {
        allowed: false,
        reason: '旧建议缺少已验证价格契约，请先复核',
        expectedPrice: null,
      };
    }
    return { allowed: true, reason: '', expectedPrice: null };
  }
  const intent = actionIntentOf(alert);
  const contractAdvice = { priceContract: contract };
  const note = String(alert.note || '');
  const level = alert.reviewOnly
    ? (
        alert.reviewKey
          ? advicePriceLevel(contractAdvice, alert.reviewKey)
          : adviceObservationLevels(contractAdvice).find((item) =>
              Number(item.price) === Number(alert.value)
              && (
                !alert.op
                || alert.op === (
                  item.direction === 'LTE' ? 'lte' : 'gte'
                )
              )
            )
      )
    : alert.actKind === 'add'
      ? advicePriceLevel(contractAdvice, 'add')
        || advicePriceLevel(contractAdvice, 'entry')
      : alert.actKind === 'reduce'
        ? advicePriceLevel(contractAdvice, 'reduce')
          || advicePriceLevel(contractAdvice, 'target')
        : /止损/.test(note)
          ? advicePriceLevel(contractAdvice, 'stop')
          : /止盈/.test(note)
            ? advicePriceLevel(contractAdvice, 'target')
            : advicePriceLevelForIntent(contractAdvice, intent);
  if (!level || !priceMatchesAdviceContract(
    { priceContract: contract },
    level.key,
    alert.value,
  )) {
    return {
      allowed: false,
      reason: '预警价与已验证价格契约不一致',
      expectedPrice: level?.price ?? null,
    };
  }
  const expectedOp = level.direction === 'GTE'
    ? 'gte'
    : level.direction === 'LTE' ? 'lte' : '';
  if (expectedOp && String(alert.op || '') !== expectedOp) {
    return {
      allowed: false,
      reason: '预警方向与已验证价格契约不一致',
      expectedPrice: level.price,
    };
  }
  return {
    allowed: true,
    reason: '',
    expectedPrice: level.price,
  };
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

function minuteOfDay(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

function continuousSessionOf(minute) {
  if (minute >= 9 * 60 + 30 && minute <= 11 * 60 + 30) return 'morning';
  if (minute >= 13 * 60 && minute <= 15 * 60) return 'afternoon';
  return null;
}

function beijingStamp(epoch) {
  const value = Number(epoch);
  if (!Number.isFinite(value) || value <= 0) return null;
  const iso = new Date(value + 8 * 60 * 60 * 1000).toISOString();
  return {
    day: iso.slice(0, 10),
    minuteOfDay: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)),
  };
}

// ---- 从分时序列提取「盘中确认原语」----
// trends: [{time, price, volume, avg(VWAP)}] 升序;preClose 昨收。
// 返回一组人类可读 + 机器可判的原语,后续确定性判定与 LLM 都消费它。
export function intradayPrimitives(
  trends,
  preClose,
  { watchingAt = null, now = Date.now() } = {},
) {
  const ts = Array.isArray(trends) ? trends.filter((t) => t && Number(t.price) > 0) : [];
  if (ts.length < 5) return null;
  const last = ts[ts.length - 1];
  const price = Number(last.price);
  const vwap = Number(last.avg) > 0 ? Number(last.avg) : null;
  const touch = beijingStamp(watchingAt);
  const current = beijingStamp(now);
  const touchMinute = touch && current && touch.day === current.day
    ? touch.minuteOfDay
    : null;
  const currentSession = continuousSessionOf(minuteOfDay(last.time));
  const sessionTrends = currentSession
    ? ts.filter((item) =>
        continuousSessionOf(minuteOfDay(item.time)) === currentSession
      )
    : ts;
  const touchInCurrentSession = touchMinute != null
    && continuousSessionOf(touchMinute) === currentSession;
  const postTouch = !touchInCurrentSession
    ? sessionTrends
    : sessionTrends.filter((item) => {
        const minute = minuteOfDay(item.time);
        return minute != null && minute >= touchMinute;
      });
  if (!postTouch.length) return null;
  // 形态、动量和量能只使用触价后的分钟线，避免用触价前走势确认未来动作。
  const win = postTouch.slice(-10);
  const prices = win.map((t) => Number(t.price));
  const winLow = Math.min(...prices);
  const winHigh = Math.max(...prices);
  // 至少积累4根触价后分钟线才比较前后半段量能，样本不足不加分。
  const volumeWindow = win.length >= 4 ? win : [];
  const volumeHalf = Math.floor(volumeWindow.length / 2);
  const priorVolumes = volumeWindow.slice(0, volumeHalf);
  const recentVolumes = volumeWindow.slice(-volumeHalf);
  const averageVolume = (items) => items.length
    ? items.reduce((sum, item) => sum + (Number(item.volume) || 0), 0) / items.length
    : 0;
  const prior = averageVolume(priorVolumes);
  const recent = averageVolume(recentVolumes);
  const volShrink = prior > 0 ? recent < prior * 0.85 : false;
  const volSurge = prior > 0 ? recent > prior * 1.5 : false;
  // 5 分钟动量(正=近 5 分钟在涨)
  const ref5 = prices.length >= 6 ? prices[prices.length - 6] : prices[0];
  const mom5Pct = prices.length >= 2 && ref5 > 0
    ? round((price - ref5) / ref5 * 100, 2)
    : 0;
  // 抬高低点 / 压低高点(用窗口前半段与后半段的极值比较)
  const half = Math.floor(win.length / 2);
  const enoughForStructure = win.length >= 4;
  const lowA = enoughForStructure ? Math.min(...prices.slice(0, half)) : null;
  const lowB = enoughForStructure ? Math.min(...prices.slice(half)) : null;
  const highA = enoughForStructure ? Math.max(...prices.slice(0, half)) : null;
  const highB = enoughForStructure ? Math.max(...prices.slice(half)) : null;
  const higherLows = enoughForStructure ? lowB >= lowA : null;
  const lowerHighs = enoughForStructure ? highB <= highA : null;
  const aboveVwap = vwap != null ? price >= vwap : null;
  const recent3 = win.slice(-3);
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
    postTouchBars: win.length, analysisStartTime: win[0]?.time || null,
    observedTradingMs: Math.max(0, win.length - 1) * 60 * 1000,
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
    if (prim.keyDistancePct <= -1.2 && prim.aboveVwap === false && prim.mom5Pct <= -0.2 && prim.higherLows === false) {
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
    if (prim.postTouchBars >= 3 && prim.aboveVwapCount3 === 3) { score += 0.5; hits.push('连续3分钟站在VWAP上方'); }
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
    if (prim.postTouchBars >= 3 && prim.aboveVwapCount3 === 0) { score += 0.5; hits.push('连续3分钟未站回VWAP'); }
    if (prim.mom5Pct <= -0.3) { score += 1; hits.push(`近5分钟持续走弱(${prim.mom5Pct}%)`); }
    if (prim.sinceTouchPct <= -0.2) { score += 0.5; hits.push(`触价后继续下跌${Math.abs(prim.sinceTouchPct)}%`); }
    if (prim.higherLows === false) { score += 1; hits.push('分时不断创新低,未见企稳'); }
    if (prim.volSurge && prim.mom5Pct < 0) { score += 1; hits.push('放量下跌,跌破有效'); }
    if (macd && macd.cross === 'dead') { score += 0.5; hits.push('日线MACD死叉共振'); }
  }
  const threshold = confirmationPolicy(side).deterministicConfirm;
  const decision = score >= threshold ? 'confirm' : 'wait';
  return { decision, score: round(score, 1), hits };
}

// ---- LLM Judge:最终研判闸门 ----
// 喂:交易意图 + 建议的确认条件/失效条件 + 确定性结论 + 技术面摘要 + 分时快照。
// 要求返回严格 JSON:{decision:'confirm'|'wait'|'invalid', confidence:0-100, reason:'一句话'}。
async function llmJudge({
  a,
  name,
  advice,
  prim,
  tech,
  det,
  position,
  fundContext,
  deadlineAt,
}) {
  const model = getModel('judge');
  if (!model) return null;   // 未配置 judge 端点/模型 → 跳过 LLM,用确定性结论
  const intent = actionIntentOf(a);
  const sideZh = actionLabelOf(a);
  const adv = buildJudgeAdviceContext({ ...(a.judgeContext || {}), ...(advice || {}) });
  const modelDiscipline = quantJudgeDiscipline(adv.quantContext);
  const sys = '你是顶尖的A股短线操盘手，负责价格触发后的10秒终局确认。'
    + '价格已经到达军师预设点位，你必须基于原军师计划和最新分时证据立即拍板，不得重新选价、不得延后到下一轮。'
    + '军师建议是本次交易计划的上层约束：先核对其方向、手数、仓位、盈亏比、止损目标、技术资金消息依据与失效条件；'
    + 'priceContract是服务端校验后的唯一权威价格契约，禁止改价或另造价位。'
    + '当前持仓状态由服务端账本核验：无持仓只能买入，绝不能解释为加仓、减仓、卖出或止损；'
    + '加仓必须确认原军师仍支持且触价后承接有效；减仓和锁利润要结合冲高回落、VWAP与量能；硬止损优先。'
    + '本轮服务端最新资金是实时判断依据：必须同时分析主力与散户代理资金，并对比原军师生成时的资金基准；'
    + '若资金关系由正面转为背离或主力转流出，必须降低买入/加仓把握；资金不可用时明确降级，不得沿用旧资金冒充实时。'
    + '不要求所有指标同时同向：只要至少一类可追溯依据成立（已验证理论、实时资金与价格、重大催化）即可综合决断。'
    + 'wait是本次触发的终态“维持观望/维持持有”，不是继续围绕该价格循环复核；invalid是放弃本次操作。'
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
    本轮服务端最新资金: fundContext?.current || {
      available: false,
    },
    原军师资金基准: fundContext?.baseline || null,
    相对原军师资金变化: fundContext?.change || {
      status: 'UNAVAILABLE',
      summary: '本次未取得有效的最新主力与散户资金快照',
    },
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
    const remainingMs = Number(deadlineAt) > 0
      ? Number(deadlineAt) - startedAt
      : 10000;
    if (remainingMs < 1000) return null;
    const TIMEOUT_MS = Math.max(
      1200,
      Math.min(10000, remainingMs),
    );
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
        terminalInstruction: compactText(
          value.terminalInstruction,
          160,
        ),
        priceLow: Number.isFinite(Number(value.priceLow))
          ? Number(value.priceLow)
          : null,
        priceHigh: Number.isFinite(Number(value.priceHigh))
          ? Number(value.priceHigh)
          : null,
        quantity: lotsOf(value.quantity),
        basisType: compactText(value.basisType, 40),
        basis: compactText(value.basis, 240),
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
export async function judgeConfirmation({
  alert,
  name,
  advice,
  quote,
  position,
  providers = {},
} = {}) {
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
  const finalize = (result, primitives = {}) =>
    attachTerminalInstruction({
      result: withKnowledgeAction(result),
      alert: a,
      intent,
      advice: adviceContext,
      primitives: {
        price: Number(quote?.price) || null,
        ...primitives,
      },
      position,
    });
  const priceContractGate = judgePriceContractGate(a, adviceContext);
  if (!priceContractGate.allowed) {
    return finalize({
      decision: 'invalid',
      confidence: 100,
      reason: priceContractGate.reason,
      side,
      actionIntent: intent,
      source: 'price-contract',
      policy: 'price-contract-mismatch',
    });
  }
  if (position) {
    const positionGate = positionGateForAlert(a, position);
    if (!positionGate.allowed) {
      return finalize({
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
    return finalize({
      decision: 'invalid',
      confidence: 100,
      reason: `最新军师建议已不再支持${actionLabelOf(a)}，原操作点失效`,
      side,
      actionIntent: intent,
      source: 'advice',
      policy: 'advice-mismatch',
    });
  }
  const timeContext = typeof providers.marketTimeContext === 'function'
    ? providers.marketTimeContext()
    : marketTimeContext();
  if (!isConfirmationPhase(timeContext.phase)) {
    return finalize({
      decision: 'wait',
      reason: `${timeContext.phase}不做盘中确认，等待连续竞价`,
      side,
      source: 'ta',
    });
  }
  // 分时与资金并行拉取。资金只信任服务端本轮新取值，不使用客户端传入值。
  const observedAt = typeof providers.now === 'function'
    ? Number(providers.now()) || Date.now()
    : Date.now();
  const fetchTrends = providers.fetchTrendsTx || fetchTrendsTx;
  const fetchFunds = providers.fetchStockFund || fetchResilientStockFund;
  const [trendsResult, fundResult] = await Promise.allSettled([
    fetchTrends(a.code),
    fetchFunds(a.code, {
      preferRealtime: true,
      timeoutMs: 2200,
      fetchedAt: observedAt,
    }),
  ]);
  const trendsData = trendsResult.status === 'fulfilled'
    ? trendsResult.value
    : null;
  const currentFund = mergeRetailFundFlow(
    fundResult.status === 'fulfilled' ? fundResult.value : null,
    {
      live: timeContext.isLive === true,
      tradeDate: quote?.tradeDate || null,
      asOfLabel: quote?.tradeDate || null,
      source: quote?.source || null,
      mainNetYi: fundAmountYi(quote?.mainInflow),
      retailNetYi: fundAmountYi(quote?.retailInflow),
      main5dYi: fundAmountYi(quote?.main5dInflow),
      retail5dYi: fundAmountYi(quote?.retail5dInflow),
    },
  );
  const fundContext = buildJudgeFundContext(
    currentFund,
    adviceContext.fundContext,
  );
  const prim = trendsData ? intradayPrimitives(
    trendsData.trends,
    trendsData.preClose,
    { watchingAt: a.watchingAt, now: observedAt },
  ) : null;
  if (!prim) {
    return finalize({
      decision: 'wait',
      reason: '分时数据不足，本次维持原计划且不新增复核价',
      side,
      source: 'ta',
      signals: { funds: fundContext },
    });
  }
  if (!isMinuteSnapshotFresh(prim.lastTime, timeContext.bjNow)) {
    return finalize({
      decision: 'wait',
      reason: `分时快照已过期(${prim.lastTime || '时间未知'})，本次维持原计划`,
      side,
      source: 'ta',
      signals: { funds: fundContext },
    }, prim);
  }
  const quotePrice = Number(quote && quote.price);
  prim.quotePrice = quotePrice > 0 ? quotePrice : null;
  prim.sourceSpreadPct = quotePrice > 0
    ? round((prim.price - quotePrice) / quotePrice * 100, 2)
    : null;
  if (prim.sourceSpreadPct != null && Math.abs(prim.sourceSpreadPct) > 0.8) {
    return finalize({
      decision: 'wait',
      reason: `分时价与实时报价偏差${Math.abs(prim.sourceSpreadPct)}%，本次不执行`,
      side,
      source: 'ta',
      signals: { funds: fundContext },
    }, prim);
  }
  const keyPrice = Number(a.value);
  const watchingPrice = Number(a.watchingPrice);
  const watchingAt = Number(a.watchingAt);
  prim.keyDistancePct = keyPrice > 0 ? round((prim.price - keyPrice) / keyPrice * 100, 2) : null;
  prim.sinceTouchPct = watchingPrice > 0 ? round((prim.price - watchingPrice) / watchingPrice * 100, 2) : null;
  const wallObservationMs = watchingAt > 0
    ? Math.max(0, observedAt - watchingAt)
    : null;
  prim.observationAgeMs = wallObservationMs == null
    ? null
    : Math.min(wallObservationMs, Number(prim.observedTradingMs) || 0);
  prim.observationAgeMin = prim.observationAgeMs != null ? round(prim.observationAgeMs / 60000, 1) : null;

  // 到价后立即进入终局判断；确定性失效直接结束，其余交给 Judge 快速拍板。
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
      signals: {
        side,
        primitives: prim,
        deterministic: preliminary,
        techVerdict: null,
        funds: fundContext,
      },
      source: 'ta',
    };
    const enriched = finalize(result, prim);
    await logVerdict(a, name, prim, enriched);
    return enriched;
  }

  // 日线技术面(辅助:MACD/RSI/均线)
  let tech = null;
  try {
    const fetchKline = providers.fetchKlineTx || fetchKlineTx;
    const kl = await fetchKline(a.code, '101', 60);
    if (kl && kl.candles) tech = computeTechnicals(kl.candles);
  } catch { tech = null; }

  const det = deterministicJudge(side, prim, tech);
  const signals = {
    side,
    primitives: prim,
    deterministic: det,
    techVerdict: tech && tech.verdict,
    funds: fundContext,
  };

  // 强止损客观信号优先，避免等待 LLM 导致风险继续扩大。
  if (side === 'stop' && det.score >= 3) {
    const fused = fuseConfirmation({
      side,
      deterministic: det,
      llm: null,
      observationAgeMs: prim.observationAgeMs,
    });
    const result = { ...fused, side, signals, source: 'ta' };
    const enriched = finalize(result, prim);
    await logVerdict(a, name, prim, enriched);
    return enriched;
  }

  if (!shouldCallLlmJudge(side, det)) {
    const fused = fuseConfirmation({
      side,
      deterministic: det,
      llm: null,
      observationAgeMs: prim.observationAgeMs,
    });
    const result = {
      ...fused,
      side,
      signals,
      source: 'ta',
      actionIntent: intent,
      knowledgeAction,
    };
    await logVerdict(a, name, prim, result);
    return result;
  }

  // LLM 最终闸门(可回退)，最终结果由非对称融合策略裁决。
  const callJudge = providers.llmJudge || llmJudge;
  const llm = await callJudge({
    side,
    a,
    name,
    advice,
    prim,
    tech,
    det,
    position,
    fundContext,
    deadlineAt: observedAt + 10000,
  });
  const fused = fuseConfirmation({
    side,
    deterministic: det,
    llm,
    observationAgeMs: prim.observationAgeMs,
  });
  const result = {
    ...fused,
    terminalInstruction: llm?.terminalInstruction || '',
    priceLow: llm?.priceLow ?? null,
    priceHigh: llm?.priceHigh ?? null,
    quantity: llm?.quantity ?? 0,
    basisType: llm?.basisType || '',
    basis: llm?.basis || '',
    side,
    signals,
    source: llm ? 'llm+ta' : 'ta',
    actionIntent: intent,
    knowledgeAction: llm?.knowledgeAction || knowledgeAction,
  };
  const terminal = finalize(result, prim);
  await logVerdict(a, name, prim, terminal);
  return terminal;
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
    fundSnapshot: result.signals?.funds?.current || null,
    fundChange: result.signals?.funds?.change || null,
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
