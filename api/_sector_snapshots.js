import { put, list } from '@vercel/blob';
import { emGet, num, sendJson } from './_lib.js';

// ============ 板块资金分时快照（A+B：真回放的数据底座）============
// 盘中每次被访问就把"当前板块主力净额快照"追加存入 Vercel Blob（按交易日分桶）。
// 前端时间轴据此真回放当天各时点的真实板块排名与金额（排名会真实换位）。
// GET /api/sector_snapshots            → 返回今天已累积的快照序列(不写入)
// GET /api/sector_snapshots?capture=1  → 抓当前快照并追加存储，再返回全序列
//
// 说明：只存每个时点的 TopN(净额最强/最弱各若干)，控制体积；非交易时段不写入。

function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000); }
function bjDayKey() { const d = nowBJ(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function bjMinutes() { const d = nowBJ(); return d.getHours() * 60 + d.getMinutes(); }
function isTradingNow() {
  const d = nowBJ(); const g = d.getDay(); if (g === 0 || g === 6) return false;
  const hm = bjMinutes();
  return (hm >= 570 && hm <= 690) || (hm >= 780 && hm <= 900); // 9:30-11:30 / 13:00-15:00
}
const PREFIX = 'sectorflow/';
const dayPrefix = (day) => `${PREFIX}${day}/`;

// 抓当前板块主力净额（行业口径），返回精简数组
async function fetchSectors() {
  const path = `/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f62`
    + `&fs=m:90+t:2&fields=f12,f14,f3,f62,f204,f205`;
  const j = await emGet(path).catch(() => null);
  const diff = (j && j.data && j.data.diff) || [];
  return diff.map((d) => ({
    code: d.f12, name: d.f14, pct: num(d.f3),
    mainInflow: num(d.f62), leadName: d.f204, leadCode: d.f205,
  })).filter((s) => s.name);
}

// 从全量板块里挑"用于回放的精简快照"：净额最强 TopN + 最弱 TopN（够画左右两栏）
function pickSnapshot(list, n = 10) {
  const sorted = [...list].sort((a, b) => b.mainInflow - a.mainInflow);
  const strong = sorted.slice(0, n);
  const weak = sorted.slice(-n);
  // 合并去重（板块数少时可能重叠）
  const seen = new Set();
  const merged = [];
  for (const s of [...strong, ...weak]) { if (!seen.has(s.code)) { seen.add(s.code); merged.push(s); } }
  return merged.map((s) => ({ c: s.code, n: s.name, p: s.pct, m: Math.round(s.mainInflow / 1e6), l: s.leadName, lc: s.leadCode })); // m 单位:百万，省体积
}

export async function snapshotsHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const day = bjDayKey();
    const wantCapture = req.query.capture === '1';
    const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;

    // 1) 盘中 + 允许写 → 抓当前快照并追加存储（做去重：同一分钟内不重复写）
    if (wantCapture && hasBlob && isTradingNow()) {
      try {
        const sectors = await fetchSectors();
        if (sectors.length) {
          const t = bjMinutes();
          // 查当天已存的时点，避免同一分钟重复写（前端会频繁轮询）
          const { blobs } = await list({ prefix: dayPrefix(day), limit: 200 });
          const existMin = new Set(blobs.map((b) => {
            const m = b.pathname.match(/\/(\d+)-/); return m ? Number(m[1]) : -1;
          }));
          if (!existMin.has(t)) {
            const snap = { t, at: Date.now(), items: pickSnapshot(sectors, 10) };
            await put(`${dayPrefix(day)}${t}-${Date.now()}.json`, JSON.stringify(snap), {
              access: 'public', contentType: 'application/json', addRandomSuffix: true, cacheControlMaxAge: 0,
            });
          }
        }
      } catch { /* 快照写入失败不影响读取 */ }
    }

    // 2) 读取当天全部快照，按时点升序返回
    let series = [];
    if (hasBlob) {
      try {
        const { blobs } = await list({ prefix: dayPrefix(day), limit: 200 });
        const sorted = blobs
          .map((b) => ({ url: b.url, min: (b.pathname.match(/\/(\d+)-/) || [])[1] }))
          .filter((x) => x.min != null)
          .sort((a, b) => Number(a.min) - Number(b.min));
        // 拉取每个快照内容（并发，容错）
        const fetched = await Promise.all(sorted.map((x) =>
          fetch(x.url).then((r) => r.json()).catch(() => null)
        ));
        // 同一分钟只保留最后一份
        const byMin = new Map();
        for (const s of fetched) { if (s && s.t != null) byMin.set(s.t, s); }
        series = [...byMin.values()].sort((a, b) => a.t - b.t);
      } catch { /* ignore */ }
    }

    return sendJson(res, { ok: true, day, count: series.length, series, blobEnabled: hasBlob }, { cache: 20 });
  } catch (e) {
    return sendJson(res, { ok: false, error: String(e.message || e) });
  }
}
