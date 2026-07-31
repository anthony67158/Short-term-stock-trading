// ============ 交易日历 / 市场时间上下文（后端共享模块）============
// 解决"AI 在周末/盘前把上一交易日的陈旧数据当成今日实时情绪"的问题：
// 统一算出【北京时间此刻】【今天是不是交易日】【现在是盘前/盘中/午间/盘后/休市】
// 【数据应按哪天口径解读】【下一个交易日是哪天】，注入所有 LLM 提示，让模型先明确
// "时间坐标"再作答，避免出现"周六还谈今日市场情绪"这类低级错误。

// 北京时间 Date（东八区）
export function nowBJ() {
  const n = new Date();
  return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000);
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// A股法定节假日(闭市)——按年维护；用于判断交易日与"下一交易日"，避免落在假期
const A_SHARE_HOLIDAYS = new Set([
  // 2026（按实际公布调整）
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-06', '2026-05-01', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
]);

export function isTradingDay(d) {
  const g = d.getDay();
  if (g === 0 || g === 6) return false;          // 周末
  if (A_SHARE_HOLIDAYS.has(ymd(d))) return false; // 法定节假日
  return true;
}

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
  // 面向的决策交易日：盘后/休市/盘前 → 下一交易日；盘中/午间 → 今天
  const decisionDay = (tradingToday && hm >= 570 && hm <= 900) ? today : nextTd;

  return {
    bjNow: `${ymd(bj)} ${String(bj.getHours()).padStart(2, '0')}:${String(bj.getMinutes()).padStart(2, '0')}`,
    weekday: WK[bj.getDay()],
    tradingToday,
    phase, phaseNote, dataFreshness, isLive,
    dataDayLabel: label(dataDay),          // 数据实际对应的交易日
    nextTradingDayLabel: label(nextTd),    // 下一个交易日
    decisionDayLabel: label(decisionDay),  // 本次建议应面向的交易日
  };
}

// 生成给 LLM 的"时间坐标 + 铁律"提示块（agent 与结构化 AI 共用）
export function marketTimePromptBlock() {
  const c = marketTimeContext();
  return `【⏰ 当前市场时间坐标（最高优先·作答前必须先认清）】
- 此刻(北京时间)：${c.bjNow} ${c.weekday}
- 市场状态：${c.phase}。${c.phaseNote}
- 数据口径：${c.dataFreshness}你拿到的所有行情/资金/涨停/情绪数据，实际对应的是【${c.dataDayLabel}】这个交易日。
- 下一个交易日：${c.nextTradingDayLabel}${c.tradingToday && c.isLive ? '' : `；你的操作建议应面向【${c.decisionDayLabel}】开盘。`}
【时间铁律】
1. ${c.tradingToday ? '今天是交易日。' : '⚠️今天不是交易日(休市)，绝对不存在“今日市场情绪/今日实时行情”。任何谈“今天盘面热不热、情绪强弱”的说法都是错的。'}
2. 引用盘面/情绪时，必须说清是【${c.dataDayLabel}】的数据，不能把历史数据说成“今天/此刻”的实时情绪。
3. ${c.tradingToday && c.isLive ? '给出面向今日盘中的操作。' : `给建议时明确面向【${c.decisionDayLabel}】开盘，用真实日期表述，不要笼统说“明天”（可能是周末/假期）。`}
4. 休市或盘前若被问“今天推荐什么/现在能不能做”，正确姿势是：基于最近交易日(${c.dataDayLabel})的收盘数据做研判，把结论落到【${c.decisionDayLabel}】开盘该怎么做，而不是假装有“今日实时情绪”。`;
}
