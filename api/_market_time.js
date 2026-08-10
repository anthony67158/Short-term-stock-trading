// ============ 交易日历 / 市场时间上下文（后端共享模块）============
// 解决"AI 在周末/盘前把上一交易日的陈旧数据当成今日实时情绪"的问题：
// 统一算出【北京时间此刻】【今天是不是交易日】【现在是盘前/盘中/午间/盘后/休市】
// 【数据应按哪天口径解读】【下一个交易日是哪天】，注入所有 LLM 提示，让模型先明确
// "时间坐标"再作答，避免出现"周六还谈今日市场情绪"这类低级错误。

import { isTradingDay, localDateKey } from '../shared/tradingCalendar.js';

// 北京时间 Date（东八区）
export function nowBJ() {
  const n = new Date();
  return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000);
}
function ymd(d) {
  return localDateKey(d);
}
const WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export { isTradingDay };

// 从给定日期往后找第 1 个交易日（不含当天）
export function nextTradingDay(from) {
  const d = new Date(from.getTime()); d.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 12; i++) {
    const n = new Date(d.getTime() + i * 86400000);
    if (isTradingDay(n)) return n;
  }
  return new Date(d.getTime() + 86400000);
}
// 从给定日期往前找第 1 个交易日（含当天：若当天是交易日则返回当天）
export function lastTradingDayOnOrBefore(from) {
  const d = new Date(from.getTime()); d.setHours(0, 0, 0, 0);
  for (let i = 0; i <= 12; i++) {
    const n = new Date(d.getTime() - i * 86400000);
    if (isTradingDay(n)) return n;
  }
  return d;
}

function label(d) {
  return `${ymd(d)}(${WK[d.getDay()]})`;
}

// 计算完整的"市场时间上下文"。返回结构供后端拼提示词。
export function marketTimeContext() {
  const bj = nowBJ();
  const hm = bj.getHours() * 60 + bj.getMinutes();
  const today = new Date(bj.getTime()); today.setHours(0, 0, 0, 0);
  const tradingToday = isTradingDay(today);

  // 交易时段判定（仅交易日有意义）
  // 盘前<9:15 / 集合竞价9:15-9:30 / 早盘9:30-11:30 / 午间11:30-13:00 / 午盘13:00-15:00 / 盘后>15:00
  let phase, phaseNote, dataFreshness, isLive = false;
  if (!tradingToday) {
    const g = bj.getDay();
    const why = (g === 0 || g === 6) ? '周末' : '法定节假日';
    phase = `休市(${why})`;
    phaseNote = `今天是${label(bj)}，${why}，A股不开盘、没有任何“今日实时行情/情绪”。`;
    dataFreshness = '所有行情、资金、情绪数据都停留在最近一个交易日收盘，属于历史快照，绝不能说成“今日”。';
  } else if (hm < 555) {
    phase = '盘前(未开盘)';
    phaseNote = `现在是${label(bj)}早盘前(未到9:15)，尚未开盘。`;
    dataFreshness = '当前看到的是上一交易日收盘数据，尚无“今日”盘面。';
  } else if (hm < 570) {
    phase = '集合竞价';
    phaseNote = `现在是${label(bj)}集合竞价阶段(9:15-9:30)。`;
    dataFreshness = '正在竞价，尚无连续竞价成交，情绪待开盘确认。';
    isLive = true;
  } else if (hm <= 690) {
    phase = '早盘(盘中)';
    phaseNote = `现在是${label(bj)}早盘交易中(9:30-11:30)。`;
    dataFreshness = '数据为今日实时。';
    isLive = true;
  } else if (hm < 780) {
    phase = '午间休市';
    phaseNote = `现在是${label(bj)}午间休市(11:30-13:00)，下午还要开盘。`;
    dataFreshness = '数据为今日上午收盘的实时快照，下午会继续变化。';
    isLive = true;
  } else if (hm <= 900) {
    phase = '午盘(盘中)';
    phaseNote = `现在是${label(bj)}午盘交易中(13:00-15:00)。`;
    dataFreshness = '数据为今日实时。';
    isLive = true;
  } else {
    phase = '盘后(已收盘)';
    phaseNote = `现在是${label(bj)}收盘后(15:00之后)。`;
    dataFreshness = '数据为今日收盘定格，可用于复盘和为下一交易日做准备。';
  }

  // 数据口径日 = 最近一个"含数据"的交易日：休市/盘前用上一交易日，其余用今天
  const dataDay = (!tradingToday || hm < 570) ? lastTradingDayOnOrBefore(new Date(today.getTime() - (tradingToday && hm < 570 ? 86400000 : 0)))
                                              : today;
  const nextTd = nextTradingDay(bj);
  // 面向的决策交易日：交易日且未收盘(盘前/集合竞价/盘中/午间, hm<=15:00) → 今天；
  // 盘后(已收盘)或休市(周末/节假日) → 下一交易日。
  // 关键：盘前(hm<9:30)今天 9:30 就要开盘，操作应面向【今天】开盘，绝不能跳到下一交易日。
  const decisionDay = (tradingToday && hm <= 900) ? today : nextTd;
  const decisionIsToday = decisionDay.getTime() === today.getTime();

  return {
    bjNow: `${ymd(bj)} ${String(bj.getHours()).padStart(2, '0')}:${String(bj.getMinutes()).padStart(2, '0')}`,
    weekday: WK[bj.getDay()],
    tradingToday,
    phase, phaseNote, dataFreshness, isLive,
    dataDayLabel: label(dataDay),          // 数据实际对应的交易日
    nextTradingDayLabel: label(nextTd),    // 下一个交易日
    decisionDayLabel: label(decisionDay),  // 本次建议应面向的交易日
    decisionIsToday,                       // 决策日是否就是今天(盘前/盘中 → true)
  };
}

// ============ 操作指导时间窗（按"此刻"决定建议面向哪段时间）============
// 解决"复盘/操作建议不管什么时候生成，指导都写成面向第二天"的低级错误：
// 指导应面向【紧接着当前时刻的那段可交易时间】——
//   盘前(未开盘)      → 今天开盘及全天盘中
//   早盘(9:30-11:30)  → 现在起到今天收盘前的盘中
//   午间休市(11:30-13:00) → 今天下午(13:00开盘后到收盘)
//   午盘(13:00-15:00) → 现在起到今天15:00收盘前
//   盘后(>=15:00)/休市 → 下一交易日开盘
// 返回 { isToday, whenLabel(短标签), phrase(可直接嵌入提示的动作时段描述), nextTradingDayLabel }
export function guidanceHorizon() {
  const bj = nowBJ();
  const hm = bj.getHours() * 60 + bj.getMinutes();
  const today = new Date(bj.getTime()); today.setHours(0, 0, 0, 0);
  const tradingToday = isTradingDay(today);
  const nextTd = nextTradingDay(bj);
  const nextLabel = label(nextTd);

  // 非交易日 或 已收盘 → 面向下一交易日
  if (!tradingToday || hm >= 900) {
    return {
      isToday: false,
      whenLabel: nextLabel,
      phrase: `下一交易日（${nextLabel}）开盘及当日`,
      nextTradingDayLabel: nextLabel,
    };
  }
  // 交易日盘前(未开盘，含集合竞价前) → 今天开盘
  if (hm < 570) {
    return { isToday: true, whenLabel: '今天', phrase: '今天开盘后（含集合竞价与全天盘中）', nextTradingDayLabel: nextLabel };
  }
  // 早盘盘中 9:30-11:30 → 现在到今天收盘前
  if (hm <= 690) {
    return { isToday: true, whenLabel: '今天盘中', phrase: '现在起到今天（15:00 收盘前）的盘中', nextTradingDayLabel: nextLabel };
  }
  // 午间休市 11:30-13:00 → 今天下午
  if (hm < 780) {
    return { isToday: true, whenLabel: '今天下午', phrase: '今天下午（13:00 开盘后到 15:00 收盘前）', nextTradingDayLabel: nextLabel };
  }
  // 午盘盘中 13:00-15:00 → 现在到今天收盘前
  return { isToday: true, whenLabel: '今天收盘前', phrase: '现在起到今天 15:00 收盘前的这段时间', nextTradingDayLabel: nextLabel };
}

// 生成给 LLM 的"时间坐标 + 铁律"提示块（agent 与结构化 AI 共用）
export function marketTimePromptBlock() {
  const c = marketTimeContext();
  const g = guidanceHorizon();  // 操作指导应面向的时段(盘前→今天/盘中→今天收盘前/午间→今天下午/盘后·休市→下一交易日)
  return `【⏰ 当前市场时间坐标（最高优先·作答前必须先认清）】
- 此刻(北京时间)：${c.bjNow} ${c.weekday}
- 市场状态：${c.phase}。${c.phaseNote}
- 数据口径：${c.dataFreshness}你拿到的所有行情/资金/涨停/情绪数据，实际对应的是【${c.dataDayLabel}】这个交易日。
- 下一个交易日：${c.nextTradingDayLabel}${c.tradingToday && c.isLive ? '' : `；你的操作建议应面向【${c.decisionDayLabel}】${c.decisionIsToday ? '开盘(今天即将开盘)' : '开盘'}。`}
- 操作指导时间窗：你给的操作建议必须面向【${g.phrase}】——${g.isToday ? '现在还能交易,别把指导写成"明天/下一交易日开盘怎么做",要落到紧接着此刻的这段可交易时间。' : '当天已收盘或休市,面向下一交易日开盘。'}
【时间铁律】
1. ${c.tradingToday ? '今天是交易日。' : '⚠️今天不是交易日(休市)，绝对不存在“今日市场情绪/今日实时行情”。任何谈“今天盘面热不热、情绪强弱”的说法都是错的。'}
2. 引用盘面/情绪时，必须说清是【${c.dataDayLabel}】的数据，不能把历史数据说成“今天/此刻”的实时情绪。
3. ${c.tradingToday && c.isLive ? `给出面向【${g.phrase}】的操作，别写成"明天/下一交易日"——现在盘中/午间还能交易。` : `给建议时明确面向【${c.decisionDayLabel}】开盘${c.decisionIsToday ? '（就是今天，稍后 9:30 开盘，不要说成“明天/下一交易日”）' : '，用真实日期表述，不要笼统说“明天”（可能是周末/假期）'}。`}
4. ${c.tradingToday && c.isLive ? '' : `${c.decisionIsToday ? '盘前' : '休市'}若被问“今天推荐什么/现在能不能做”，正确姿势是：基于最近交易日(${c.dataDayLabel})的收盘数据做研判，把结论落到【${c.decisionDayLabel}】开盘该怎么做，而不是假装有“今日实时情绪”。`}`;
}
