import { sendJson, sendError, num } from './_lib.js';

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

// 专门抓 K线：校验必须有非空 klines，否则视为失败（东财偶发 200 空响应会被拒）
async function fetchKline(hosts, path) {
  // 1) 先并发抢镜像，但只接受“有非空 klines”的结果
  const valid = (j) => j && j.data && Array.isArray(j.data.klines) && j.data.klines.length > 0;
  const race = hosts.map((h) => jget(h + path, 8000).then((j) => {
    if (!valid(j)) throw new Error('empty klines');
    return j;
  }));
  try {
    return await Promise.any(race);
  } catch {
    // 2) 并发都失败/都空 → 串行重试每个镜像一次（带小退避），最大限度捞到数据
    for (const h of hosts) {
      try {
        const j = await jget(h + path, 9000);
        if (valid(j)) return j;
      } catch { /* 继续下一个镜像 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return null;
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

    // 分时多镜像：push2 实时 + push2his 历史，任一有数据即可
    const trendsHosts = ['https://push2.eastmoney.com', 'https://push2his.eastmoney.com'];
    async function fetchTrends() {
      for (const h of trendsHosts) {
        try {
          const j = await jget(h + trendsPath, 7000);
          if (j && j.data && Array.isArray(j.data.trends) && j.data.trends.length) return j;
        } catch { /* 下一个镜像 */ }
      }
      return null;
    }

    const [klJson, f10Json, trendsJson] = await Promise.all([
      fetchKline(klHosts, klPath),
      jget(f10Url, 7000, 'https://emweb.securities.eastmoney.com/').catch(() => null),
      wantTrends ? fetchTrends() : Promise.resolve(null),
    ]);

    // 解析 K线
    const kd = klJson && klJson.data;
    const klines = (kd && kd.klines) || [];
    const candles = klines.map((line) => {
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

    // 解析分时（f51时间,f53现价,f56量,f58均价）
    let trends = null, preClose = null;
    if (wantTrends && trendsJson && trendsJson.data) {
      preClose = num(trendsJson.data.preClose);
      trends = (trendsJson.data.trends || []).map((line) => {
        const p = line.split(',');
        return { time: p[0], price: num(p[1]), volume: num(p[2]), avg: num(p[3]) };
      });
    }

    // 解析简介
    const jb = (f10Json && f10Json.jbzl && f10Json.jbzl[0]) || {};
    const profile = {
      fullName: jb.ORG_NAME || (kd && kd.name) || '',
      name: jb.SECURITY_NAME_ABBR || (kd && kd.name) || '',
      code: jb.SECURITY_CODE || code,
      industry: jb.EM2016 || jb.INDUSTRYCSRC1 || '',
      market: jb.SECURITY_TYPE || '',
      business: jb.BUSINESS_SCOPE || '',
      intro: (jb.ORG_PROFILE || '').trim(),
      website: jb.ORG_WEB || '',
      empNum: jb.EMP_NUM || '',
    };

    sendJson(
      res,
      { ok: true, code, updatedAt: Date.now(), profile, klt, candles, trends, preClose },
      { cache: candles.length ? 120 : 0 }
    );
  } catch (e) {
    sendError(res, e);
  }
}
