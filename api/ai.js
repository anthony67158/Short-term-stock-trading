// AI 分析代理：服务端调用 LLM，Key 从环境变量读取，绝不暴露给前端
// POST body: { mode: 'market'|'sector'|'stock'|'scan', payload: {...} }
import { buildCorpus, retrieve } from './_rag.js';

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

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
  if (mode === 'daily') {
    return `【当日全盘数据：大盘情绪 + 板块资金流 + 涨停连板 + 盘中异动】\n${data}\n\n你是短线操盘手，服务做 T+1（今买明卖）的用户。请综合所有维度，直接给出今日可执行的操盘决策。输出 JSON：{"canTrade":"能做/谨慎/空仓 三选一","light":"green/yellow/red","verdict":"一句话今日定调(能不能做、什么风格)","direction":"今日主攻方向(1-2个板块/主线)","candidates":[{"name":"候选股(必须来自给定数据)","code":"代码","reason":"入选逻辑(结合资金/涨停/异动的具体数据)","buyPoint":"买点提示(如回踩不破/放量突破)","expect":"次日预期","stop":"止损提示"}],"position":"建议仓位(如3-5成)","risk":"最需警惕的风险"}。candidates 给3-5只，必须来自给定数据里的真实个股。`;
  }
  if (mode === 't_advice') {
    const styleMap = {
      conservative: '【稳健】只在明确支撑/压力位出手，手数小(建议底仓1/4左右)，价位留足安全边际，宁可少做也不冒进；大盘或个股不明朗时直接建议观望。',
      balanced: '【均衡】常规高抛低吸，手数适中(建议底仓1/3左右)，在合理支撑压力间做T。',
      aggressive: '【激进】追求弹性和更大差价，手数可较大(建议底仓1/2，日内强势可更多)，敢在放量拉升中追、急跌企稳中抢反弹，价位更贴近现价，博更大波段；但仍必须给出失效止损位。',
    }
    const styleText = styleMap[payload.style] || styleMap.balanced
    return `【做T参考请求】用户持有一只票想日内做T(高抛低吸摊薄成本)。数据含：个股实时量价、当日分时结构(intraday: vwap均价/日内高低/现价位置posInDay/节奏rhythm/是否触及日内高低)、大盘情绪(market)、大盘资金流向(marketFlow)、个股近20日走势(history)、用户持仓(holdCost/holdQty/baseQty)。
数据：${data}

【用户选择的操作风格】${styleText}
你必须严格按这个风格给建议——激进就大胆给重手贴价、稳健就轻仓留边际，不要千篇一律。

【分析逻辑链，逐条结合数据，不许空谈】：
1. 大盘环境：用 market(涨跌比/涨停) + marketFlow(净额/流入流出) 判断顺风还是逆风。
2. 当日分时：用 intraday(现价 vs vwap均价、posInDay在当日区间位置、rhythm节奏、atDayLow/atDayHigh) 判断此刻是日内偏低还是偏高、什么节奏。这是做T最关键的日内依据。
3. 个股波段：用 history(近5日/均线vsMa5,vsMa20/20日区间位置posInRange) 判断中期强弱与箱体位置。
4. 支撑压力：结合日内高低、均价线VWAP、近20日高低，给出具体的支撑位和压力位数字(做T的锚)。
5. 理论支撑：贴切引用一个理论(均值回归/趋势/支撑压力/量价/仓位管理)解释判断。

【方向】正T低吸=现价在日内/均价下方偏低且有支撑；反T高抛=现价冲高在压力附近或大盘转弱；观望=震荡无边界或极度逆风。手数与激进度按上面风格来。

请输出 JSON：{"advisable":"适合/谨慎/不建议","light":"green/yellow/red","dir":"positive或reverse或none","dirLabel":"正T低吸 或 反T高抛 或 暂不做T","confidence":"高/中/低","plain":"用大白话解释为什么这么做(假设用户不太懂,像师傅带徒弟那样讲清楚,别堆术语)","marketNote":"一句话大盘环境(引用数据)","stockNote":"一句话个股当下位置(引用分时vwap/日内位置/量比)","support":支撑位数字,"resistance":压力位数字,"theory":"引用的理论+一句话如何支撑","suggestQty":建议手数(整数,按风格),"leg1Price":第一腿参考价(数字),"leg2Price":第二腿目标价(数字),"estProfit":"预估净赚(元)","estCostDown":"预估成本下降(元/股)","addOn":"激进风格可给加码条件(如放量突破X可追,目标X);其他风格填空字符串","risk":"风险与失效止损价位"}。不建议做T时 dir=none、价位可 null。`;
  }
  if (mode === 'plan') {
    return `【交易计划请求】用户持有一只票，想为它定一份短线交易计划(止盈价/止损价/买入理由)，用户不太懂技术，需要你基于技术指标与经典理论给出默认建议，用户会在此基础上微调。
数据含：个股实时量价、当日分时(intraday: vwap均价/日内高低/现价位置)、大盘情绪(market)、资金流向(marketFlow)、近20日走势(history: ma5/ma10/ma20、20日高低high20/low20、区间位置posInRange)、用户持仓成本(holdCost)。
数据：${data}

【定价逻辑链，必须结合数据与理论，给出具体数字】：
1. 止损价：以"支撑失守即离场"为原则。优先取 MA10/MA20 生命线、近20日重要支撑(low20 附近)中，离现价最近的下方支撑；并确保相对持仓成本(holdCost)的最大回撤不超过约 8%(短线纪律)。两者取更能护住本金的那个(通常是更靠上的支撑)。
2. 止盈价：以压力位与波段空间为依据。参考近20日高点(high20)、前高、整数关口、或按趋势给出合理的目标涨幅(短线常见 +8%~+15%)。强势趋势可给远目标，弱势/接近压力则保守。
3. 理由：一句话讲清这份计划的技术依据(引用均线/支撑压力/量价/趋势理论其一)，像师傅带徒弟，别堆术语。

【硬约束】止损价必须 < 现价 < 止盈价；价位精度贴合该股价位量级(低价股可到3位小数)；数字必须落在合理区间(别给离谱的价)。

请输出 JSON：{"tp":止盈价数字,"sl":止损价数字,"reason":"一句话交易计划理由(含技术依据)","tpBasis":"止盈定价依据(如:近20日高X/压力位X/目标+X%)","slBasis":"止损定价依据(如:MA10生命线X/成本-8%X/支撑X)","theory":"引用的理论一句话","confidence":"高/中/低"}。只输出JSON。`;
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

    // t_advice / plan 模式：服务端补齐"大盘情绪+资金流向+个股历史走势+分时"，让建议有据可依
    if ((mode === 't_advice' || mode === 'plan') && payload.code) {
      try {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const origin = `${proto}://${host}`;
        const getJ = (p) => fetch(origin + p).then((r) => r.json()).catch(() => null);

        const [mkt, sec, detail, trend] = await Promise.all([
          getJ('/api/market'),
          getJ('/api/sectors?type=industry&sort=main'),
          getJ(`/api/stock_detail?code=${payload.code}&klt=101&lmt=20`),
          fetchTrend(payload.code),
        ]);

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
        max_tokens: (mode === 'scan' || mode === 'daily') ? 2000 : (mode === 't_advice' ? 1600 : 1200),
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
