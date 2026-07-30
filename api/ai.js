// AI 分析代理：服务端调用 LLM，Key 从环境变量读取，绝不暴露给前端
// POST body: { mode: 'market'|'sector'|'stock'|'scan', payload: {...} }
import { buildCorpus, retrieve } from './_rag.js';
import { techSummaryForAI, fetchQuantPredict } from './_ta.js';

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) { if (arr.length < 2) return 0; const m = avg(arr); return Math.sqrt(avg(arr.map((x) => (x - m) ** 2))); }

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
async function fetchTrend(code) {
  const hosts = ['https://push2his.eastmoney.com', 'https://82.push2his.eastmoney.com'];
  const path = `/api/qt/stock/trends2/get?secid=${toSecid(code)}&fields1=f1,f2&fields2=f51,f53,f56,f58&iscr=0&ndays=1`;
  for (const h of hosts) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(h + path, { signal: ctrl.signal, headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(t);
      const j = await r.json();
      const trends = j && j.data && j.data.trends;
      if (trends && trends.length) {
        return trends.map((line) => {
          const p = line.split(',');
          return { time: p[0].slice(11), price: Number(p[1]), vol: Number(p[2]), avg: Number(p[3]) };
        });
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

const SYSTEM_PROMPT = `你是一位专业的A股短线交易策略分析师。你的任务是基于用户提供的【实时行情数据】做客观分析。

严格规则（必须遵守）：
1. 只能引用用户在数据中提供的真实股票、板块、数值。绝对禁止虚构任何股票代码、名称、价格或数据。
2. 如果数据不足以支撑某个结论，明确说"数据不足"，不要编造。
3. 你的分析是"资金面/情绪面/量价"的客观解读，不是买卖指令。
4. 面向短线（1-5日）视角：关注资金流向、连板梯队、量能、换手、板块强弱。
5. 保持简洁、结构化、有逻辑依据，每个观点都要能追溯到给定数据。
6. 若提供了【RAG检索资料】（近5日走势、主营、联网新闻），务必结合消息面/基本面一起分析。

你必须只输出一个合法的 JSON 对象（不要 markdown 代码块包裹），结构见用户要求。`;

function buildUserPrompt(mode, payload, ragText) {
  const data = JSON.stringify(payload, null, 0);
  const ragBlock = ragText ? `\n\n【RAG检索资料：近5日走势+主营+联网新闻】\n${ragText}` : '';
  if (mode === 'market') {
    return `【今日盘面实时数据】\n${data}\n\n请输出 JSON：{"sentiment":"多头/中性/空头","score":0-100的情绪分,"summary":"一句话盘面总结","mainLines":[{"name":"最强主线板块名","reason":"资金/涨停依据"}],"risks":["风险点1","风险点2"],"advice":"短线操作建议(仓位/节奏)"}`;
  }
  if (mode === 'sector') {
    return `【板块「${payload.sectorName}」实时数据+成分股】\n${data}\n\n请从上面【真实成分股列表】中挑选最多3只短线关注度高的个股（必须是列表里存在的），输出 JSON：{"sectorView":"该板块资金/强弱判断","picks":[{"name":"股票名(必须来自列表)","code":"代码","reason":"入选逻辑(资金/量价/连板)","watch":"短线关注点/风险"}],"note":"整体提示"}`;
  }
  if (mode === 'stock') {
    return `【个股实时数据】\n${data}${ragBlock}\n\n请综合实时数据与RAG资料（消息面/近5日走势），输出 JSON（各字段填你的分析结论，不要照抄字段说明）：{"name":"股票名","view":"用一句话给出资金面+量价+消息面的综合判断结论","strength":"强或中或弱三选一","points":["解读要点1","解读要点2","解读要点3"],"newsImpact":"最新消息面对短线的具体影响；若近期无重要消息则写'近期无重要消息'","watch":"短线关注点与风险"}`;
  }
  if (mode === 'scan') {
    return `【当日全盘综合数据：大盘情绪 + 板块资金流 + 涨停连板 + 盘中异动】\n${data}\n\n你是短线策略总监，请综合以上所有维度，给出今日最值得关注的 TOP3 方向。输出 JSON：{"marketMood":"一句话大盘定调","topDirections":[{"rank":1,"direction":"方向/板块名","logic":"入选逻辑(必须结合资金流/涨停/异动的具体数据)","representStocks":[{"name":"代表股(必须来自给定数据)","code":"代码"}],"strength":"强/中/弱"}],"strategy":"今日短线操作策略(仓位/节奏/风格)","topRisk":"最需警惕的风险"}`;
  }
  if (mode === 'scan_pick') {
    return `【AI 选股请求】用户不知道今天买哪只，需要你从"已用量化模型打过分的候选池"里，结合大盘/板块/盘面，精选出今日最值得买的 **3 只** 个股，并说清怎么买。
数据含：大盘情绪(market)、板块资金流(sectors)、【候选池 candidates —— 每只都带量化打分与走势预测】。
数据：${data}

【候选池 candidates 字段说明】每只含：name/code、pct当日涨幅、量价(turnover换手/volRatio量比/mainInflowYi主力净流入亿)、tags信号(涨停/连板/主力抢筹/涨速)、以及量化模型结果 quant{ score综合分0~100越高越偏多, bias偏多/偏空/中性, upProb未来5日上涨概率%, expRet预期涨跌%, targetLow~targetHigh目标价区间 }。

【选股逻辑，逐条执行】：
1. **先看大盘与板块**：逆风(跌多/跌停多)则从严、甚至提示今日不宜追高；顺风则积极。优先落在强势主线板块里的票。
2. **量化优先**：candidates 里 quant.score 高(≥60)、upProb 高(≥55%)、expRet 为正的，是量化看好的；score 低/看跌的坚决排除。量化是硬门槛。
3. **量价与题材验证**：在量化过关的基础上，选有资金(主力净流入)、有量能(量比适中放量)、属于当日主线、位置不过高(别追已连板高位接盘)的。
4. **可买性**：给出明确买点(回踩不破/放量突破/开盘竞价)和参考买入价区间(可结合 quant 目标区间下沿)，以及止损位。

【硬要求】：精选正好 3 只(若实在符合的不足3只，可少给并说明)，必须来自 candidates 里的真实个股，理由必须引用该股的量化分/上涨概率/资金等具体数字。

请输出 JSON：{"marketNote":"一句话今日大盘环境与选股基调","picks":[{"rank":1,"name":"股票名","code":"代码","quantScore":量化分数字,"reason":"为什么选它(引用量化分/上涨概率/资金/板块的具体数字，大白话)","buyPoint":"买点(如回踩5日线不破/放量突破X/竞价低吸)","buyZone":"参考买入价区间(如 12.3~12.8)","target":"目标位/预期","stop":"止损位","risk":"该股主要风险"}],"note":"整体提示(仓位/节奏)"}。只输出 JSON。`;
  }
  if (mode === 'daily') {
    return `【当日全盘数据：大盘情绪 + 板块资金流 + 涨停连板 + 盘中异动】\n${data}\n\n你是短线操盘手，服务做 T+1（今买明卖）的用户。请综合所有维度，直接给出今日可执行的操盘决策。输出 JSON：{"canTrade":"能做/谨慎/空仓 三选一","light":"green/yellow/red","verdict":"一句话今日定调(能不能做、什么风格)","direction":"今日主攻方向(1-2个板块/主线)","candidates":[{"name":"候选股(必须来自给定数据)","code":"代码","reason":"入选逻辑(结合资金/涨停/异动的具体数据)","buyPoint":"买点提示(如回踩不破/放量突破)","expect":"次日预期","stop":"止损提示"}],"position":"建议仓位(如3-5成)","risk":"最需警惕的风险"}。candidates 给3-5只，必须来自给定数据里的真实个股。`;
  }
  if (mode === 't_advice') {
    const styleMap = {
      conservative: '【稳健】只在明确支撑/压力位出手，手数小(建议底仓1/4左右)，价位留足安全边际，宁可少做也不冒进；大盘或个股不明朗时直接建议观望。',
      balanced: '【均衡】常规高抛低吸，手数适中(建议底仓1/3左右)，在合理支撑压力间做T。',
      aggressive: '【激进】追求弹性和更大差价，手数可较大(建议底仓1/2，日内强势可更多)，敢在放量拉升中追、急跌企稳中抢反弹，价位更贴近现价，博更大波段；但仍必须给出失效止损位。',
    }
    const isAuto = !payload.style || payload.style === 'auto'
    const styleText = isAuto
      ? '【自动】用户没有指定风格，请你根据 stockProfile(这只股自己的历史规律) 自动选定最合适的风格：波动大/振幅大的妖股→偏激进博差价；温吞小波动→偏稳健小做；居中→均衡。并在 chosenStyle 字段回填你选的风格。'
      : (styleMap[payload.style] || styleMap.balanced)
    return `【做T参考请求】用户持有一只票想日内做T摊薄成本。做T有两个方向，你要根据此刻盘面对称判断、不要默认只做正T：正T=先低吸后高抛(现价偏低时)，反T=先高抛后低接(现价偏高/浮盈时)。数据含：个股实时量价、当日分时结构(intraday: vwap均价/日内高低/现价位置posInDay/节奏rhythm/是否触及日内高低)、大盘情绪(market)、大盘资金流向(marketFlow)、个股近20日走势(history)、【个股历史规律画像 stockProfile】、【专业技术指标 tech(ATR真实波幅/布林带/RSI/KDJ/MACD/支撑压力/买卖带/止损止盈)】、用户持仓(holdCost/holdQty/baseQty)。
数据：${data}

【个股历史规律画像 stockProfile —— 本次策略自适应的核心，务必逐项参考】
这是根据该股近${payload.stockProfile ? payload.stockProfile.days : 60}日日线统计出的“这只股自己的性格”，含义：
- avgAmplitude/recentAmplitude：平均/近10日日内振幅%。振幅大=做T空间大值得做；recentAmplitude<2.5 基本没肉，应倾向观望或轻仓。
- volatility：日涨跌幅标准差(性格烈度)。越大越是“妖股脾气”→越适合激进；越小越温吞→越适合稳健。
- bigUpRevRate/bigDnRevRate/meanRevScore：大涨后回落概率 / 大跌后反弹概率 / 综合均值回归分。分数高(≥0.55)=强均值回归，特别适合“涨了就抛、跌了就吸”的高抛低吸做T。
- lowOpenUpRate/highOpenDownRate：历史上“低开走高”/“高开走低”的频率。前者高→这只股正T低吸胜率高；后者高→反T高抛更契合。
- volPriceSync：放量日里上涨占比。高=放量可信可追；低=放量常是出货，追高需谨慎。
- streak：当前连阳(正)/连阴(负)根数；posIn20/posIn60：现价在20/60日区间位置%。
- styleSuggest/dirBias/dirReason：系统按历史规律预判的风格与方向偏好，作为你的重要参考(你可结合当日盘面覆盖，但若覆盖必须说明理由)。

【用户选择的操作风格】${styleText}
${isAuto ? '你要基于历史规律自动决策，并在 chosenStyle 明确回填(conservative/balanced/aggressive 之一)。' : '你必须严格按这个风格给建议——激进就大胆给重手贴价、稳健就轻仓留边际。'}

【分析逻辑链，逐条结合数据，不许空谈】：
1. 历史规律(最重要)：先看 stockProfile 判断这只股“天生适合怎么做T”——是激进还是稳健、值不值得做(振幅够不够)、以及 dirBias 是偏正T/反T还是双向都行。注意 dirBias=balanced/meanReversion 时不要预设方向，方向由第3步的当日位置决定。
2. 大盘环境：用 market(涨跌比/涨停) + marketFlow(净额/流入流出) 判断顺风还是逆风，对历史规律结论做加减分。
3. 当日分时：用 intraday(现价 vs vwap均价、posInDay、rhythm、atDayLow/atDayHigh) 判断此刻是日内偏低还是偏高、什么节奏。这是落地到“今天此刻”的执行依据。
4. 支撑压力：优先采用 tech(专业技术指标) 里的 support/resistance/布林上下轨/buyZone/sellZone 作为做T的锚，再结合日内高低、均价线VWAP微调，给出具体的支撑位和压力位数字。tech.atr(真实波幅)决定两腿价差不要小于约1个ATR否则没肉、不要大于约3个ATR否则一天到不了。tech.rsi/kdj 超买则反T高抛更优、超卖则正T低吸更优。
5. 理论支撑：贴切引用一个理论(均值回归/趋势/支撑压力/量价/仓位管理)解释判断。${payload.quant ? `
6. 【量化模型深度融合 quant，必须与你的价位决策拧成一体，不要各说各话】：quant 有 score(0~100)、bias，以及**走势预测 forecast**(upProb未来5日上涨概率%、direction看涨/看跌/震荡、targetLow~targetHigh目标价区间、expRet预期涨跌%)。落地要求：
   - **量化定方向倾向**：forecast.direction=看涨→更偏正T(先低吸博后续上涨)、看跌→更偏反T(先高抛避回落)、震荡→区间高抛低吸皆可。若量化方向与你按分时位置判的方向冲突，以稳健为先(减小手数/收窄价差)并在 plain 里点明分歧。
   - **量化目标区间锚定两腿价**：leg2Price(目标腿)要参考 forecast 的目标价区间——正T的高抛目标别超过 targetHigh 太多(那是模型预期上沿，够不着)，反T的接回目标别低于 targetLow 太多。让两腿价位"落在量化认为大概率能到的区间内",这样你才跟得住、成交得了。
   - **量化定信心与手数**：upProb 高(≥60)且方向一致→信心高、手数可大;upProb 中性(45~55)→手数减半、只在明确支撑/压力才动;量化偏空(score≤40)且你想正T→明确降级为轻仓或观望。` : ''}

【方向必须对称判断，不得默认偏向正T——先看此刻现价在日内的位置(intraday.posInDay / vsVwap)】：
- **正T低吸(先买后卖)**：现价在日内区间偏低(posInDay 低、现价在VWAP下方)、触及/接近日内低点(atDayLow)、急跌企稳有支撑时。适合“手里有底仓、今天想低点补一手明天高抛摊成本”。
- **反T高抛(先卖后买)**：现价在日内区间偏高(posInDay 高、现价在VWAP上方)、触及/接近日内高点(atDayHigh)、冲高滞涨或大盘转弱时。适合“手里有底仓、趁高抛一部分等回落再接回、落袋并降成本”。**当用户持仓浮盈、或现价明显高于成本、或 posInDay≥60、或尾段拉升到日内高位时，要优先考虑反T高抛，而不是让他去追高低吸。**
- **观望(none)**：振幅太小(recentAmplitude<2.5)、震荡无边界、或极度逆风。
判定顺序：先用 intraday 的当日位置定“此刻更该先买还是先卖”，再用 stockProfile 的 dirBias/开盘路径做辅助验证。dirBias=balanced 时，完全以当日位置为准。不要因为“做T=高抛低吸”这个习惯说法就默认选正T——反T同样是做T，方向取决于此刻价格在日内的高低。

请输出 JSON：{"advisable":"适合/谨慎/不建议","light":"green/yellow/red","chosenStyle":"conservative或balanced或aggressive(你据历史规律选定的风格)","styleReason":"为什么给这只股选这个风格(必须引用stockProfile的具体数字，如振幅/波动率/均值回归分)","dir":"positive或reverse或none","dirLabel":"正T低吸 或 反T高抛 或 暂不做T","confidence":"高/中/低","actionPlan":"【最重要·一句话行动指令，让用户能直接照做】把方向+手数+两腿价位+触发条件揉成一句话，例如'现价X偏高，先在Y附近高抛N手，回落到Z附近接回，量化看跌upProb仅30%所以别追高'。必须含具体价格数字。","histPattern":"用一句话概括这只股的历史规律","plain":"用大白话解释为什么这么做(像师傅带徒弟，点出历史规律)","marketNote":"一句话大盘环境(引用数据)","stockNote":"一句话个股当下位置(引用分时vwap/日内位置/量比)","support":支撑位数字,"resistance":压力位数字,${payload.quant ? '"quantNote":"量化走势预测如何影响这次决策(引用quant.score、forecast上涨概率与目标区间的具体数字，说明为什么两腿价定在这;用大白话)",' : ''}"theory":"引用的理论+一句话如何支撑","suggestQty":建议手数(整数,按风格),"leg1Price":第一腿参考价(数字),"leg2Price":第二腿目标价(数字,须落在量化目标区间内),"estProfit":"预估净赚(元)","estCostDown":"预估成本下降(元/股)","addOn":"激进风格可给加码条件;其他风格填空字符串","risk":"风险与失效止损价位"}。不建议做T时 dir=none、价位可 null。`;
  }
  if (mode === 'plan') {
    return `【交易计划请求】用户持有一只票，想为它定一份短线交易计划(止盈价/止损价/买入理由)。用户不太懂技术，需要你基于**持仓成本**并结合技术指标给出默认建议，用户会再微调。
数据含：个股实时量价、当日分时(intraday)、大盘情绪(market)、资金流向(marketFlow)、近20日走势(history: ma5/ma10/ma20、20日高低high20/low20)、**用户持仓成本 holdCost（本次定价的核心基准）**。
数据：${data}

【最高优先级 · 定价基准 = 持仓成本 holdCost】
用户要的是"相对我的成本能赚多少、亏多少"，不是相对现价。所以：
- **止盈价 tp 必须 > holdCost**，且至少覆盖买卖双边手续费后仍有正收益；短线合理目标为 holdCost × (1 + 8%~15%)。
- **止损价 sl 必须 < holdCost**，相对 holdCost 的最大回撤不超过约 8%（即 sl ≥ holdCost × 0.92）。
- 现价可能高于或低于成本（浮盈或套牢），但**都不改变上面两条铁律**：止盈永远在成本之上、止损永远在成本之下。

【技术位只用于"在上述区间内微调"，不能突破成本边界】
- 止盈：在"成本+8%~+15%"区间内，若上方有近20日高点/压力位/整数关口，可就近取这些技术位作为更现实的目标；但技术位若低于成本，则忽略它、直接用"成本+目标涨幅"。
- 止损：在"成本-8%以内"，若下方有 MA10/MA20/近20日支撑 low20，可取更靠上的那个技术支撑作为更早的离场点；但止损不得高于成本。

【硬约束（务必自检）】必须满足 sl < holdCost < tp；且 sl ≥ holdCost×0.92、tp ≥ holdCost×1.06；价位精度贴合该股量级(低价股可3位小数)。若技术位与上述冲突，一律以成本基准为准。

请输出 JSON：{"tp":止盈价数字,"sl":止损价数字,"reason":"一句话交易计划理由(说明相对成本的盈亏目标+技术依据)","tpBasis":"止盈依据(如:成本+10%/近20日高X)","slBasis":"止损依据(如:成本-8%/MA10 X)","theory":"引用的理论一句话","confidence":"高/中/低"}。只输出JSON。`;
  }
  if (mode === 'price') {
    const isBuy = payload.action === 'buy';
    const actLabel = { buy: '建仓(首次买入)', add: '加仓(补仓)', sell: '减仓/清仓(卖出)' }[payload.actionKind] || (isBuy ? '买入' : '卖出');
    return `【${isBuy ? '买入' : '卖出'}挂单价请求】用户正准备${actLabel}一只票，需要你给出一个**极其合理的${isBuy ? '买入' : '卖出'}挂单价**（一个具体数字），供他人工挂单参考。
数据含：个股实时量价(nowPrice=当前实时价、dayHigh/dayLow/open/prevClose)、当日分时(intraday: now实时价/vwap均价/日内高低/posInDay位置/rhythm节奏/是否触及日内高低)、【个股历史规律画像 stockProfile】、【专业技术指标 tech(ATR真实波幅/布林带上下轨/RSI/KDJ/MACD/支撑support压力resistance/系统算好的买入带buyZone卖出带sellZone/止损stopLoss/止盈takeProfit)】、大盘情绪(market)、资金流向(marketFlow)、近20日走势(history)${payload.holdCost ? '、用户当前持仓成本 holdCost' : ''}${payload.tradeHistory ? '、用户过往在这只股上的交易记录 tradeHistory(历史买卖价与盈亏，用于贴合他的操作习惯与成本带)' : ''}。
数据：${data}

【定价三大依据，缺一不可，且必须落到一个具体价格】：
1. **当前实时价(最高优先，锚)**：以 intraday.now / nowPrice 为基准锚，你的挂单价必须在实时价附近的合理区间，不能脱离盘口开虚价。${isBuy ? '买入价通常≤实时价(挂低吸单)，但不宜低于日内低点太多导致挂不上；急拉时可贴近实时价追。' : '卖出价通常≥实时价(挂高抛单)，但不宜高于日内高点太多导致挂不出；跳水时可贴近实时价出。'}
2. **历史规律(stockProfile)**：用 avgAmplitude/recentAmplitude 判断合理挂单偏离幅度(振幅大→可挂离现价远一点博差价，振幅小→贴近现价才成交)；用 lowOpenUpRate/highOpenDownRate/meanRevScore 判断这只股${isBuy ? '低吸' : '高抛'}的合适位置；用 posInDay/vwap 判断此刻贵不贵。
3. **过往交易记录(tradeHistory)**：${payload.tradeHistory ? '参考用户历史在这只股的买卖价位带与成本，给出与他习惯/成本相衔接的价格(如买入尽量低于其历史均价成本、卖出尽量高于其成本)。' : '本次无历史成交记录，按前两条定价。'}${payload.holdCost ? ` 用户当前持仓成本 holdCost=${payload.holdCost}${isBuy ? '，加仓价应能摊低或至少不显著抬高成本' : '，卖出价应尽量高于成本以锁定收益(除非止损)'}。` : ''}
4. **专业技术指标(tech)**：这是定价的技术锚，务必用它校准价格——${isBuy ? '买入价优先贴近 tech.buyZone(买入带)/布林下轨 tech.boll.lower/支撑 tech.support；若 RSI<30 或 KDJ 超卖或现价贴布林下轨，说明是低吸好位置可稍积极；用 ATR 判断挂单不要低于现价超过约1个ATR否则难成交。' : '卖出价优先贴近 tech.sellZone(卖出带)/布林上轨 tech.boll.upper/压力 tech.resistance；若 RSI>70 或 KDJ 超买或现价贴布林上轨，说明是高抛好位置可稍积极；用 ATR 判断挂单不要高于现价超过约1个ATR否则难成交。'} 你给出的价格应与 tech 的买卖带/支撑压力大体吻合，若明显偏离必须在理由里说明为什么。${payload.quant ? `
5. **量化模型(quant)**：多因子打分 quant.score(0~100越高越偏多)、quant.bias，以及**走势预测 quant.forecast**(upProb未来5日上涨概率%、expRet预期涨跌%、targetLow~targetHigh目标价区间、direction看涨/看跌/震荡)。${isBuy ? '预测看涨且上涨概率高(≥58)时买入可略积极贴近现价；看跌或概率低(≤42)则买入更保守、或干脆等回调。' : '预测看跌时卖出可略积极尽快出；看涨则卖价可挂高一点等冲高。'} 目标价区间可作为你止盈/接回价的参考。量化与技术面冲突时以稳健为先并点明分歧。` : ''}

【要求】只给一个最优挂单价 price(数字，精度贴合该股量级，低价股可3位小数)，并给一个可选的备用价 altPrice(更积极成交或更保守的另一档)。价格必须合理、可成交、有依据。

请输出 JSON：{"price":挂单价数字,"altPrice":备用价数字或null,"side":"${isBuy ? 'buy' : 'sell'}","anchor":"相对实时价的说明(如:实时X，挂低吸X/挂高抛X)","reason":"一句话大白话理由(点出实时价+历史规律+交易记录如何支撑这个价)","histNote":"历史规律如何影响定价(引用振幅/回归/开盘路径的具体数字)","techNote":"技术指标如何支撑这个价(引用布林/ATR/RSI/支撑压力的具体数字，用大白话)"${payload.quant ? ',"quantNote":"量化模型打分如何印证或修正(引用quant.score与bias，用大白话)"' : ''},"confidence":"高/中/低"}。只输出JSON。`;
  }
  if (mode === 'hold_advice') {
    return `【持仓个股操作建议请求】用户持有一只票，需要你像贴身操盘顾问一样，明确告诉他现在该 **加仓 / 减仓 / 持有 / 清仓**，并且**给出具体的参考价位（一个数字或一个窄区间）**让他能直接照着挂单。这是持仓管理决策，不是做T。
数据含：个股实时量价(nowPrice/dayHigh/dayLow/open/prevClose)、当日分时(intraday: now实时价/vwap均价/日内高低/posInDay位置/rhythm节奏/是否触及日内高低)、大盘情绪(market)、资金流向(marketFlow)、个股近20日走势(history: ma5/ma10/ma20、20日高低)、【个股历史规律画像 stockProfile】、【专业技术指标 tech(ATR真实波幅/布林带上下轨/RSI/KDJ/MACD/支撑support压力resistance/买入带buyZone卖出带sellZone/止损stopLoss/止盈takeProfit)】、**用户持仓成本 holdCost 与手数 holdQty（决策基准）**${payload.quant ? '、量化模型 quant(score多因子分/bias/forecast走势预测)' : ''}。
数据：${data}

【决策逻辑，逐条结合数据，不许空谈】：
1. **先算盈亏**：用 nowPrice 与 holdCost 比，判断此刻是浮盈还是套牢、幅度多少。这决定基调：浮盈可考虑落袋/减仓，套牢要看该补还是该止损。
2. **趋势与位置**：用 history(均线多空/20日区间位置) + tech(布林/RSI/KDJ/MACD/支撑压力) + intraday(现价vs均价/日内位置) 判断这只股现在是强势该拿住、还是转弱该减、还是超跌可补。
3. **历史规律 stockProfile**：用振幅/波动率/均值回归分/连阳连阴，判断这只股"性格"——是追涨型还是回归型，辅助决定加减仓的价位偏离度。
4. **大盘环境**：market/marketFlow 顺风则可积极持有/加仓，逆风则优先减仓控风险。${payload.quant ? `
5. **量化走势预测 quant.forecast**：upProb(未来5日上涨概率%)、direction(看涨/看跌/震荡)、targetLow~targetHigh(目标价区间)、expRet(预期涨跌%)。看涨且上涨概率高(≥58)→倾向持有或回踩加仓、加仓价可参考现价或回踩支撑；看跌(≤42)→倾向减仓/清仓、减仓价可贴近现价或反抽压力尽快出；震荡→高抛低吸波段管理。量化目标区间用来锚定你给的加/减仓价位。` : ''}

【价位要求——必须落到可挂单的具体数字】：
- **加仓价 addPrice**：给一个回踩买点（通常≤现价，贴近 tech.buyZone/布林下轨/支撑位/MA10；能摊低或不显著抬高 holdCost），振幅大可挂离现价远些、振幅小要贴近现价才成交。
- **减仓价 reducePrice**：给一个反弹卖点（通常≥现价，贴近 tech.sellZone/布林上轨/压力位；尽量高于 holdCost 锁定收益）。
- **止损价 stopPrice**：跌破则无条件离场（通常 holdCost×0.92 与最近关键支撑取较高者）。
- 根据你的决策(action)，主推的那个价位要给准；不主推的价位也尽量给出以便用户参考。价格精度贴合该股量级(低价股可3位小数)，且必须与 tech 的买卖带/支撑压力大体吻合，明显偏离要在理由里说明。

请输出 JSON：{"action":"加仓 或 减仓 或 持有 或 清仓","tone":"red(偏多/加仓/持有强势) 或 green(偏空/减仓/清仓) 或 muted(观望/持有中性)","title":"一句话结论(如:可小幅减仓锁利 / 回踩可加仓 / 继续持有)","pnlNote":"当前相对成本的盈亏情况(引用现价与holdCost的具体数字)","actionPlan":"【最重要·一句话可直接照做的行动指令】把动作+手数(或仓位比例)+参考价位+触发条件揉成一句话，必须含具体价格数字，例如'现价X已浮盈Y%，可在Z附近减2手锁利，跌破W则清仓止损'。","addPrice":加仓参考价数字或null,"reducePrice":减仓参考价数字或null,"stopPrice":止损价数字或null,"targetPrice":目标位/预期价数字或null,"reason":"大白话理由(结合盈亏+趋势+位置+量化，说清为什么这么做、价位为什么定在这)","techNote":"技术面依据(引用布林/RSI/支撑压力/均线的具体数字)"${payload.quant ? ',"quantNote":"量化走势预测如何支撑(引用score/upProb/目标区间的具体数字，大白话)"' : ''},"risk":"最需警惕的风险与失效信号","confidence":"高/中/低"}。只输出JSON。`;
  }
  if (mode === 'buy_advice') {
    return `【未持仓·买入决策请求】用户还没买这只票，正在研究要不要买、什么时候买、买多少钱。你要像贴身操盘顾问一样，**明确告诉他:现在该买 / 等回调再买 / 暂时观望**，并给出**具体的买入时机 + 买入价(一个数字或窄区间) + 止损价 + 目标价**，让他能直接照着挂单，绝不能含糊其辞。
数据含：个股实时量价(nowPrice/dayHigh/dayLow/open/prevClose)、当日分时(intraday: now实时价/vwap均价/日内高低/posInDay位置/rhythm节奏/是否触及日内高低)、大盘情绪(market)、资金流向(marketFlow)、个股近20日走势(history: ma5/ma10/ma20、20日高低)、【个股历史规律画像 stockProfile】、【专业技术指标 tech(ATR真实波幅/布林带上下轨/RSI/KDJ/MACD/支撑support压力resistance/买入带buyZone卖出带sellZone/止损stopLoss/止盈takeProfit)】${payload.quant ? '、量化模型 quant(score多因子分/bias/forecast走势预测)' : ''}。
数据：${data}

【决策逻辑，逐条结合数据，不许空谈】：
1. **值不值得买(先定性)**：用 history(均线多空/20日区间位置) + tech(布林/RSI/KDJ/MACD/支撑压力) + stockProfile(振幅/波动率/均值回归) 判断这只股当前是强势可介入、还是转弱该回避、还是超跌可博反弹。振幅太小(recentAmplitude<2.5)、或明显转弱逆风，就直接建议观望。
2. **买入时机(最关键，必须具体)**：用 intraday(现价vs均价/日内位置posInDay/节奏rhythm/是否触及日内高低) + tech 判断"现在这个点位该不该马上买"：
   - 现价在日内低位/贴近支撑/RSI偏低/缩量回踩 → 可"现价附近直接买"或"分批建仓";
   - 现价在日内高位/贴布林上轨/RSI超买/放量冲高 → 建议"等回踩到X再买"，别追高;
   - 无明确信号 → "观望，等突破X或回踩X再动手"。
   把时机说成一句可执行的话(如"竞价别追，等回踩到均价线56.8附近分批买""放量站上58.2压力后再介入")。
3. **买入价(必须落到数字)**：给一个具体的**建议买入价 buyPrice**(优先贴近 tech.buyZone/布林下轨tech.boll.lower/支撑tech.support/MA10)，再给一个**买入区间 buyZone**(如"56.5~57.2")便于分批。价格必须贴合实时价、可成交，不能开脱离盘口的虚价。
4. **止损与目标**：给 stopPrice(跌破则不追，通常近关键支撑下方或买入价-5%~8%)、targetPrice(短线目标，参考压力位/近20日高/量化目标上沿)。${payload.quant ? `
5. **量化走势预测 quant.forecast**：upProb(未来5日上涨概率%)、direction(看涨/看跌/震荡)、targetLow~targetHigh(目标价区间)、expRet(预期涨跌%)。看涨且上涨概率高(≥58)→可积极些、买点贴近现价；看跌(≤42)→保守或观望、只在回踩深支撑才考虑;震荡→区间低吸。量化目标区间用来锚定你给的目标价。量化与技术面冲突时以稳健为先并点明分歧。` : ''}

请输出 JSON：{"action":"买入 或 等回调 或 观望","tone":"red(看多可买) 或 green(偏空回避) 或 muted(观望等待)","title":"一句话结论(如:可现价分批建仓 / 等回踩58再买 / 暂时观望)","timing":"【买入时机·可直接照做】一句话说清什么点位/什么信号出现再买，含具体价格数字","actionPlan":"【最重要·一句话可直接照做的行动指令】把动作+仓位比例+买入价+触发条件揉成一句话，必须含具体价格数字，例如'现价X偏高别追，回踩到Y附近先建半仓，站稳再加，跌破Z放弃'。","buyPrice":建议买入价数字或null,"buyZone":"买入区间(如 56.5~57.2)或null","stopPrice":止损价数字或null,"targetPrice":目标价数字或null,"reason":"大白话理由(结合趋势+位置+量化，说清为什么这么判断、价位为什么定在这)","techNote":"技术面依据(引用布林/RSI/ATR/支撑压力/均线的具体数字)"${payload.quant ? ',"quantNote":"量化走势预测如何支撑(引用score/upProb/目标区间的具体数字，大白话)"' : ''},"risk":"最需警惕的风险与不该买的情形","confidence":"高/中/低"}。观望时 buyPrice 可 null 但 timing 必须说清"等什么信号"。只输出JSON。`;
  }
  if (mode === 'review') {
    const sess = payload.session === 'close' ? '收盘复盘' : payload.session === 'noon' ? '午盘复盘' : '复盘';
    const guideFor = payload.session === 'close'
      ? '这是**收盘后复盘**，用户看盘结束、准备为**明天开盘**做决策。请站在"今天收完盘、明天该怎么办"的视角，给出对次日开盘的明确指导（继续持有/明天开盘减/回踩再加/直接止损等）。'
      : payload.session === 'noon'
      ? '这是**午间休市复盘**，上午已经交易完、下午还要开盘。请站在"上午收完、下午该怎么操作"的视角，给出对**今天下午**的明确指导（下午继续持有/逢高减/回踩加/盯住某价位等）。'
      : '这是用户手动发起的复盘，请对该股当前状态做一次完整复盘，并给出后续操作指导。';
    return `【持仓复盘请求·${sess}】用户${payload.hold ? '持有' : '关注'}这只票，需要你像操盘教练一样做一次**复盘总结**：回顾这只股当前的走势/量价/资金/量化状态，结合用户的持仓成本与今日/历史交易，给出一句话能照做的后续操作指导。${guideFor}
数据含：个股实时量价、当日分时(intraday: vwap均价/日内高低/posInDay位置/rhythm节奏)、大盘情绪(market)、资金流向(marketFlow)、近20日走势(history)、【个股历史规律画像 stockProfile】、【专业技术指标 tech】${payload.quant ? '、量化模型 quant(score/bias/forecast走势预测)' : ''}${payload.hold ? '、用户持仓 hold(cost成本/qty手数/pnlPct浮盈亏%)' : ''}${payload.todayTrades ? '、用户今日在该股的成交 todayTrades(买卖价/手数)' : ''}${payload.tradeHistory ? '、用户过往交易记录 tradeHistory' : ''}。
数据：${data}

【复盘逻辑，逐条结合数据】：
1. **今日表现回顾**：用当日涨跌/分时节奏(rhythm)/量比，一句话概括这只股今天走成什么样、强还是弱。
2. **持仓盈亏与操作检视**：${payload.hold ? '结合 hold.cost/pnlPct 说清此刻浮盈还是套牢、幅度多少；' : ''}${payload.todayTrades ? '点评今日 todayTrades 的买卖操作是否合理(追高了/抄早了/高抛得当等)，有则表扬、错则点出。' : '若无今日成交则跳过操作检视。'}
3. **趋势与位置研判**：用 history(均线多空/20日位置) + tech(布林/RSI/KDJ/支撑压力) + stockProfile 判断当前处于强势/转弱/超跌，配合量化 forecast 判断后市方向。
4. **给出下一步指导(最重要)**：${payload.session === 'close' ? '明确"明天开盘"怎么做' : payload.session === 'noon' ? '明确"今天下午"怎么做' : '明确后续怎么做'}——持有/加仓/减仓/清仓/止损，并给**具体参考价位**（回踩加仓价、反弹减仓价、止损价），让用户能直接照做。

请输出 JSON：{"stance":"持有 或 加仓 或 减仓 或 清仓 或 观望","tone":"red(偏多/持有/加仓) 或 green(偏空/减仓/清仓) 或 muted(中性观望)","headline":"一句话复盘结论(最醒目，含核心动作)","todayRecap":"今日走势与量价一句话回顾(引用涨跌/量比/节奏)","pnlNote":"${payload.hold ? '当前持仓盈亏一句话(引用成本与浮盈亏%)' : '未持仓，跳过'}","tradeReview":"${payload.todayTrades ? '今日操作点评(哪步做得好/该改进)' : '今日无成交'}","nextAction":"【${payload.session === 'close' ? '明天开盘' : payload.session === 'noon' ? '今天下午' : '后续'}怎么做·可直接照做】动作+参考价位+触发条件揉成一句话，必须含具体价格数字","addPrice":回踩加仓参考价数字或null,"reducePrice":反弹减仓参考价数字或null,"stopPrice":止损价数字或null,"keyLevel":"要盯住的关键价位说明(如:守住X则持有，破X则走)"${payload.quant ? ',"quantNote":"量化走势预测一句话(引用upProb/direction/目标区间)"' : ''},"risk":"最需警惕的风险","confidence":"高/中/低"}。只输出JSON。`;
  }
  return `分析以下数据并输出JSON：${data}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(200).send(JSON.stringify({ ok: false, error: 'POST only' }));
  }

  const BASE = process.env.LLM_BASE_URL;
  const KEY = process.env.LLM_API_KEY;
  const MODEL = process.env.LLM_MODEL || 'DeepSeek-V3.2-Pro';
  if (!BASE || !KEY) {
    return res.status(200).send(JSON.stringify({ ok: false, error: 'LLM 未配置' }));
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const mode = (body && body.mode) || 'market';
    const payload = (body && body.payload) || {};

    // stock 模式：接入 RAG（近5日走势+主营+联网新闻）
    let ragText = '';
    let newsRefs = [];
    if (mode === 'stock' && payload.code) {
      try {
        const corpus = await buildCorpus(payload.code);
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
    if ((mode === 't_advice' || mode === 'plan' || mode === 'price' || mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') && payload.code) {
      try {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const origin = `${proto}://${host}`;
        const getJ = (p) => fetch(origin + p).then((r) => r.json()).catch(() => null);

        const [mkt, sec, detail, trend] = await Promise.all([
          getJ('/api/market'),
          getJ('/api/sectors?type=industry&sort=main'),
          getJ(`/api/stock_detail?code=${payload.code}&klt=101&lmt=60`),
          fetchTrend(payload.code),
        ]);
        // 量化预测：用刚取到的 K线喂给量化服务（绕开其取数被风控），t_advice/price 场景带持仓成本
        let quant = null;
        if (detail && detail.ok && Array.isArray(detail.candles) && detail.candles.length >= 25) {
          const hold = payload.holdCost ? { cost: payload.holdCost, qty: payload.holdQty } : null;
          try { quant = await fetchQuantPredict(payload.code, detail.candles, hold, 9000); } catch { /* 静默 */ }
        }

        // 大盘情绪
        if (mkt && mkt.ok) {
          const b = mkt.breadth || {};
          payload.market = {
            indices: (mkt.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
            up: b.up, down: b.down, limitUp: b.limitUp, limitDown: b.limitDown,
            upDownRatio: b.down ? +(b.up / b.down).toFixed(2) : null,
          };
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
          if (mode === 't_advice' || mode === 'price' || mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') {
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
            reads: quant.reads, asOf: quant.asOf,
          };
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
        // 风格
        payload.style = payload.style || 'balanced'
      } catch (e) {
        // 补数据失败不阻断
      }
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 55000);

    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(mode, payload, ragText) },
        ],
        temperature: 0.4,
        max_tokens: (mode === 'scan' || mode === 'daily' || mode === 'scan_pick') ? 2200 : (mode === 't_advice' ? 1600 : (mode === 'hold_advice' || mode === 'buy_advice' || mode === 'review') ? 1400 : 1200),
        response_format: { type: 'json_object' },
      }),
    });
    clearTimeout(t);

    if (!resp.ok) {
      const errText = await resp.text();
      return res
        .status(200)
        .send(JSON.stringify({ ok: false, error: `LLM ${resp.status}`, detail: errText.slice(0, 200) }));
    }

    const j = await resp.json();
    const content = j.choices?.[0]?.message?.content || '';

    // 解析模型返回的 JSON（容错：剥离可能的 ```json 包裹）
    let result;
    try {
      const cleaned = content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      result = JSON.parse(cleaned);
    } catch {
      result = { raw: content };
    }

    res.status(200).send(
      JSON.stringify({
        ok: true,
        mode,
        model: MODEL,
        updatedAt: Date.now(),
        result,
        news: newsRefs,
        usedRag: !!ragText,
        usage: j.usage || null,
      })
    );
  } catch (e) {
    res.status(200).send(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}
