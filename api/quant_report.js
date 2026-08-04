import { put, list, del, readJson, hasStorage } from './_blob.js';
import { sendJson, preflight } from './_lib.js';

// ============ 量化每日重训「中文汇报」台账（阿里云 OSS 持久化）============
// 每天的持续训练定时任务跑完后 POST 一条中文汇报到这里；前端「预警中心 · 量化」页读取展示，
// 支持单条删除 + 一键清空。彻底替代原来「通过 Mira 推送」的方式。
//
//   GET  /api/quant_report[?limit=50]        → { ok, reports:[{id,at,decision,title,body,...}] }
//   POST /api/quant_report { action:'append', title, body, decision?, meta? }  ← 定时任务调用
//   POST /api/quant_report { action:'delete', id }     单条删除(id = pathname)
//   POST /api/quant_report { action:'clear' }          清空全部
//
// 存储：每条一个 blob，pathname = quantreport/<ts>.json，读取取全部按时间倒序。

const PREFIX = 'quantreport/';

function ok(res, obj) { sendJson(res, obj, { cache: 0 }); }

// 读全部汇报（倒序，最新在前）
async function listReports(limit) {
  const { blobs } = await list({ prefix: PREFIX, limit: 500 });
  const sorted = (blobs || []).slice().sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  ).slice(0, limit);
  const out = [];
  for (const b of sorted) {
    const j = await readJson(b);
    if (j) out.push({ id: b.pathname, ...j });
  }
  return out;
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (!hasStorage()) return ok(res, { ok: false, error: '云端存储未配置' });

  try {
    if (req.method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const reports = await listReports(limit);
      return ok(res, { ok: true, reports });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body || '{}');
      const action = body.action || 'append';

      if (action === 'append') {
        const title = String(body.title || '').slice(0, 200);
        const text = String(body.body || '').slice(0, 20000);
        if (!text) return ok(res, { ok: false, error: 'body 不能为空' });
        const rec = {
          at: Date.now(),
          title: title || '量化每日重训汇报',
          body: text,
          decision: body.decision || null,   // promote / reject / error
          meta: (body.meta && typeof body.meta === 'object') ? body.meta : null,
        };
        const ts = rec.at;
        await put(`${PREFIX}${ts}.json`, JSON.stringify(rec), {
          access: 'public', contentType: 'application/json',
          addRandomSuffix: true, cacheControlMaxAge: 0,
        });
        // 只保留最近 100 条，避免无限堆积
        try {
          const { blobs } = await list({ prefix: PREFIX, limit: 500 });
          const olds = (blobs || []).slice()
            .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
            .slice(100);
          for (const b of olds) { try { await del(b.url); } catch { /* ignore */ } }
        } catch { /* ignore */ }
        return ok(res, { ok: true, at: ts });
      }

      if (action === 'delete') {
        const id = String(body.id || '').trim();
        if (!id) return ok(res, { ok: false, error: '缺少 id' });
        try { await del(id); } catch { /* ignore */ }
        return ok(res, { ok: true });
      }

      if (action === 'clear') {
        try {
          const { blobs } = await list({ prefix: PREFIX, limit: 500 });
          for (const b of (blobs || [])) { try { await del(b.url); } catch { /* ignore */ } }
        } catch { /* ignore */ }
        return ok(res, { ok: true });
      }

      return ok(res, { ok: false, error: '未知 action' });
    }

    return ok(res, { ok: false, error: 'method not allowed' });
  } catch (e) {
    return ok(res, { ok: false, error: String(e.message || e) });
  }
}
