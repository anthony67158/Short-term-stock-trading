import { emGet, sendJson, sendError, num } from './_lib.js';

// 板块资金流历史趋势（近N日主力净流入）
// query: code=BKxxxx  days=10
export default async function handler(req, res) {
  try {
    const code = req.query.code;
    if (!code) return sendJson(res, { ok: false, error: 'missing code' });
    const days = Math.min(Number(req.query.days) || 10, 30);

    // 板块历史资金流：secid=90.BKxxxx，需带 ut 认证参数否则返回空
    const path =
      `/api/qt/stock/fflow/daykline/get?lmt=0&klt=101` +
      `&ut=b2884a393a59ad64002292a3e90d46a5` +
      `&fields1=f1,f2,f3,f7` +
      `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
      `&secid=90.${code}&_=${Date.now()}`;

    // 板块资金流历史优先走主 push2 集群（daykline 在主集群更稳）
    let j = await emGet(path).catch(() => null);
    if (!j || !(j.data && j.data.klines && j.data.klines.length)) {
      j = await emGet(path, { his: true }).catch(() => null);
    }
    const klines = (j && j.data && j.data.klines) || [];
    // 每行: 日期,主力净流入,小单,中单,大单,超大单,主力净占比,...
    const series = klines.slice(-days).map((row) => {
      const p = row.split(',');
      return {
        date: p[0],
        mainInflow: num(p[1]),   // 主力净流入(元)
        mainRatio: num(p[6]),    // 主力净占比(%)
      };
    });

    sendJson(res, { ok: true, code, updatedAt: Date.now(), series }, { cache: 300 });
  } catch (e) {
    sendError(res, e);
  }
}
