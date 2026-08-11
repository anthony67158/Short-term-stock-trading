import { sendJson, sendError, num } from './_lib.js';
import { computeTechnicals, fetchSelectedQuantPredict } from './_ta.js';
import {
  normalizeQuantModelVersion,
  QUANT_MODEL_V2,
} from '../shared/modelVersion.js';
import { canUseQuantModel } from './_quant_access.js';

// secid 前缀：6/9/5 开头沪市=1，其余=0
function toSecid(code) {
  const c = String(code).trim();
  return /^(6|9|5)/.test(c) ? '1.' + c : '0.' + c;
}
function toF10Code(code) {
  const c = String(code).trim();
  return (/^(6|9|5)/.test(c) ? 'SH' : 'SZ') + c;
}

async function jget(url, timeout = 7000, referer = 'https://quote.eastmoney.com/') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: referer,
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 腾讯行情代码：sh600519 / sz000001 / sz300xxx
function toTxCode(code) {
  const c = String(code).trim();
  return (/^(6|9|5)/.test(c) ? 'sh' : 'sz') + c;
}

// ===== 备用数据源：腾讯行情（海外基本不限流，作为东财失败时的兜底）=====
// 注：fetchKlineTx / fetchTrendsTx 同时被 _confirm.js(智能确认闸门)复用为盘中/日线数据源,
//   故一并 export;二者只读腾讯公开行情,不触碰量化 /predict(36维OHLCV模型)口径。
// 日/周/月 K线
export async function fetchKlineTx(code, klt, lmt) {
  const tx = toTxCode(code);
  const period = klt === '102' ? 'week' : klt === '103' ? 'month' : 'day';
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tx},${period},,,${lmt},qfq&_=${Date.now()}`;
  const j = await jget(url, 6000, 'https://gu.qq.com/');
  const node = j && j.data && j.data[tx];
  if (!node) return null;
  // 前复权优先：qfqday / qfqweek / qfqmonth，回退非复权 day/week/month
  const rows = node['qfq' + period] || node[period] || [];
  if (!rows.length) return null;
  // 腾讯每行：[日期, 开, 收, 高, 低, 成交量(手), {...或成交额}]
  const candles = rows.map((r) => {
    const open = num(r[1]), close = num(r[2]), high = num(r[3]), low = num(r[4]);
    return {
      date: r[0], open, close, high, low,
      volume: num(r[5]),
      amount: num(r[6] && typeof r[6] === 'object' ? 0 : r[6]) || 0,
      pct: 0, // 腾讯不直接给涨跌幅，前端/下方补算
    };
  });
  // 用前收补算涨跌幅
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev) candles[i].pct = +(((candles[i].close - prev) / prev) * 100).toFixed(2);
  }
  return { name: (node.qt && node.qt[tx] && node.qt[tx][1]) || '', candles };
}

// 当日分时（腾讯）
export async function fetchTrendsTx(code) {
  const tx = toTxCode(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tx}&_=${Date.now()}`;
  const j = await jget(url, 5000, 'https://gu.qq.com/');
  const root = j && j.data && j.data[tx];
  const node = root && root.data;
  if (!node || !Array.isArray(node.data) || !node.data.length) return null;
  // 昨收在 qt[tx][4]（qt 是 data 的兄弟节点）
  const preClose = num(root.qt && root.qt[tx] && root.qt[tx][4]);
  // 每行 "HHMM 价格 累计量(手) 累计成交额(元)"。均价=累计额/(累计量×100)，每分钟量=累计量差分
  let prevCum = 0;
  const trends = node.data.map((line) => {
    const p = String(line).split(/\s+/);
    const hhmm = p[0];
    const time = /^\d{4}$/.test(hhmm) ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : hhmm;
    const price = num(p[1]);
    const cumVol = num(p[2]);           // 累计成交量(手)
    const cumAmt = num(p[3]);           // 累计成交额(元)
    const vwap = cumVol ? +(cumAmt / (cumVol * 100)).toFixed(2) : price; // 真·均价 VWAP
    const vol = Math.max(cumVol - prevCum, 0); // 每分钟量
    prevCum = cumVol;
    return { time, price, volume: vol, avg: vwap };
  });
  return { trends, preClose };
}

// 专门抓 K线：校验必须有非空 klines，否则视为失败（东财偶发 200 空响应会被拒）
// 两轮并发抢镜像，绝不串行累加超时（避免 4×9s 拖到 Vercel 函数超时）
async function fetchKline(hosts, path) {
  const valid = (j) => j && j.data && Array.isArray(j.data.klines) && j.data.klines.length > 0;
  const raceOnce = (timeout) => {
    const race = hosts.map((h) => jget(h + path, timeout).then((j) => {
      if (!valid(j)) throw new Error('empty klines');
      return j;
    }));
    return Promise.any(race);
  };
  try {
    return await raceOnce(6000);   // 第一轮：6s 并发抢
  } catch {
    try { return await raceOnce(6000); } catch { return null; } // 第二轮：再并发抢一次
  }
}

// 个股详情：公司简介(主营) + 日K线 + (可选)当日分时
// query: code=600519  klt=101(日)|102(周)|103(月)  lmt=K线根数  trends=1(附当日分时)
export default async function handler(req, res) {
  try {
    const code = req.query.code;
    if (!code) return sendJson(res, { ok: false, error: 'missing code' });
    const klt = req.query.klt || '101';
    const lmt = Math.min(Number(req.query.lmt) || 120, 500);
    const wantTrends = req.query.trends === '1';
    const wantQuant = req.query.quant === '1';
    const quantModelVersion = normalizeQuantModelVersion(req.query.model);
    if (
      wantQuant
      && !(await canUseQuantModel(req, quantModelVersion))
    ) {
      return sendJson(res, {
        ok: false,
        error: 'V2模型需要已登录且当前账号已选择V2',
      }, { cache: 0 });
    }
    const secid = toSecid(code);

    // K线多镜像（多个负载均衡节点，任一有效即可）
    const klHosts = [
      'https://push2his.eastmoney.com',
      'https://82.push2his.eastmoney.com',
      'https://45.push2his.eastmoney.com',
      'https://49.push2his.eastmoney.com',
    ];
    const klPath =
      `/api/qt/stock/kline/get?secid=${secid}` +
      `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f61` +
      `&klt=${klt}&fqt=1&end=20500101&lmt=${lmt}`;

    // 当日分时（trends2：f51时间,f53现价,f56量,f58均价）
    const trendsPath =
      `/api/qt/stock/trends2/get?secid=${secid}` +
      `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13,f17` +
      `&fields2=f51,f53,f56,f58&iscr=0&ndays=1&forcect=1`;

    // 公司简介
    const f10Url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${toF10Code(code)}`;

    // 分时多镜像：push2 实时 + push2his 历史，并发取先返回且有数据的（超时压到4s，绝不拖垮K线）
    const trendsHosts = ['https://push2.eastmoney.com', 'https://push2his.eastmoney.com'];
    async function fetchTrends() {
      const race = trendsHosts.map((h) => jget(h + trendsPath, 4000).then((j) => {
        if (j && j.data && Array.isArray(j.data.trends) && j.data.trends.length) return j;
        throw new Error('empty trends');
      }));
      try { return await Promise.any(race); } catch { return null; }
    }

    // 用 allSettled 保证：分时/简介失败绝不影响 K线返回
    const [klRes, f10Res, trendsRes] = await Promise.allSettled([
      fetchKline(klHosts, klPath),
      jget(f10Url, 6000, 'https://emweb.securities.eastmoney.com/'),
      wantTrends ? fetchTrends() : Promise.resolve(null),
    ]);
    const klJson = klRes.status === 'fulfilled' ? klRes.value : null;
    const f10Json = f10Res.status === 'fulfilled' ? f10Res.value : null;
    const trendsJson = trendsRes.status === 'fulfilled' ? trendsRes.value : null;

    // 解析 K线
    const kd = klJson && klJson.data;
    const klines = (kd && kd.klines) || [];
    let candles = klines.map((line) => {
      const p = line.split(',');
      return {
        date: p[0],
        open: num(p[1]),
        close: num(p[2]),
        high: num(p[3]),
        low: num(p[4]),
        volume: num(p[5]),
        amount: num(p[6]),
        pct: num(p[8]),
      };
    });
    let txName = '';
    // 东财 K线为空 → 回退腾讯行情（更稳、基本不限流）
    if (!candles.length) {
      try {
        const tx = await fetchKlineTx(code, klt, lmt);
        if (tx && tx.candles && tx.candles.length) { candles = tx.candles; txName = tx.name; }
      } catch { /* 腾讯也失败则保持空 */ }
    }

    // 解析分时（f51时间,f53现价,f56量,f58均价）；东财空则回退腾讯
    let trends = null, preClose = null;
    if (wantTrends && trendsJson && trendsJson.data && Array.isArray(trendsJson.data.trends) && trendsJson.data.trends.length) {
      preClose = num(trendsJson.data.preClose);
      trends = trendsJson.data.trends.map((line) => {
        const p = line.split(',');
        return { time: p[0], price: num(p[1]), volume: num(p[2]), avg: num(p[3]) };
      });
    } else if (wantTrends) {
      try {
        const tx = await fetchTrendsTx(code);
        if (tx && tx.trends && tx.trends.length) { trends = tx.trends; preClose = tx.preClose; }
      } catch { /* 忽略 */ }
    }

    // 解析简介
    const jb = (f10Json && f10Json.jbzl && f10Json.jbzl[0]) || {};
    const profile = {
      fullName: jb.ORG_NAME || (kd && kd.name) || '',
      name: jb.SECURITY_NAME_ABBR || (kd && kd.name) || txName || '',
      code: jb.SECURITY_CODE || code,
      industry: jb.EM2016 || jb.INDUSTRYCSRC1 || '',
      market: jb.SECURITY_TYPE || '',
      business: jb.BUSINESS_SCOPE || '',
      intro: (jb.ORG_PROFILE || '').trim(),
      website: jb.ORG_WEB || '',
      empNum: jb.EMP_NUM || '',
    };

    // 专业技术指标（ATR/布林/RSI/KDJ/MACD/量能 + 买卖价位建议 + 大白话）
    const periodLabel = klt === '102' ? '周' : klt === '103' ? '月' : '日';
    let tech = null;
    try { tech = computeTechnicals(candles, periodLabel); } catch { /* 指标失败不阻断 */ }

    // 量化预测（quant=1 时调用；把本地已取到的 K线传给量化服务，绕开其取数被风控）
    // 可选持仓：holdCost 传入则给"加/减/做T"建议，否则给"买/观望"建议
    let quant = null;
    let quantError = '';
    if (wantQuant && candles.length >= 25) {
      const holdCost = Number(req.query.holdCost) || null;
      const hold = holdCost ? { cost: holdCost, qty: Number(req.query.holdQty) || null } : null;
      try {
        quant = await fetchSelectedQuantPredict(
          quantModelVersion,
          code,
          candles,
          hold,
          20000,
        )
      } catch (error) {
        quantError = String(error?.message || error || '')
      }
    }
    if (
      wantQuant
      && quantModelVersion === QUANT_MODEL_V2
      && !quant
    ) {
      return sendJson(res, {
        ok: false,
        error: quantError || 'V2模型服务未运行或预测不可用',
        quantModelVersion,
      }, { cache: 0 })
    }

    // 缓存策略：带量化请求时，拿到 quant 才短缓存(60s)，没拿到不缓存(下次可重试冷启动后的服务)
    const cacheSec = wantQuant ? (quant ? 60 : 0) : (candles.length ? 120 : 0);
    sendJson(
      res,
      {
        ok: true,
        code,
        updatedAt: Date.now(),
        profile,
        klt,
        candles,
        trends,
        preClose,
        tech,
        quant,
        quantModelVersion,
      },
      { cache: cacheSec }
    );
  } catch (e) {
    sendError(res, e);
  }
}
