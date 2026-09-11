import { put, list, del, readJson, hasStorage } from './_blob.js';
import { sendJson, preflight } from './_lib.js';
import {
  dedupeQuantReports,
  normalizeRetrainRun,
  opportunityReportSnapshot,
  quantReportModel,
  decisionWorkflowRun,
} from '../shared/quantRetrainReport.js';

// ============ 决策模型每日训练与发布台账（阿里云 OSS 持久化）============
// 每轮训练完成后写入冠军、挑战者、组成部分选择、整体门禁和部署结果。
// 历史个股/板块报告只读兼容，不再进入量化汇报主视图。
//
//   GET  /api/quant_report[?limit=50]        → { ok, reports:[{id,at,decision,title,body,...}] }
//   POST /api/quant_report { action:'append', title, body, decision?, meta? }  ← 定时任务调用
//   POST /api/quant_report { action:'delete', id }     单条删除(id = pathname)
//   POST /api/quant_report { action:'clear_decision' } 清空决策模型记录
//
// 存储：每条一个 blob，pathname = quantreport/<ts>.json，读取取全部按时间倒序。

const PREFIX = 'quantreport/';
const WORKFLOW_RUNS_URL =
  'https://api.github.com/repos/anthony67158/Short-term-stock-trading/actions/workflows/daily-retrain.yml/runs?per_page=10';
const WORKFLOW_CACHE_MS = 60 * 1000;
let workflowCache = { at: 0, value: null };

function ok(res, obj) { sendJson(res, obj, { cache: 0 }); }

async function workflowStatus() {
  const now = Date.now();
  if (
    workflowCache.value
    && now - workflowCache.at < WORKFLOW_CACHE_MS
  ) {
    return workflowCache.value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(WORKFLOW_RUNS_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'stock-dashboard-quant-report',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const payload = await response.json();
    const recent = (Array.isArray(payload?.workflow_runs)
      ? payload.workflow_runs
      : [])
      .map((run) => normalizeRetrainRun(run, now))
      .filter(Boolean);
    const value = {
      available: true,
      checkedAt: now,
      current: recent.find(
        (run) => run.state === 'running' || run.state === 'queued',
      ) || null,
      latest: recent.find(
        (run) => run.status === 'completed',
      ) || recent[0] || null,
      recent: recent.slice(0, 10),
    };
    workflowCache = { at: now, value };
    return value;
  } catch {
    const value = {
      available: false,
      checkedAt: now,
      current: null,
      latest: workflowCache.value?.latest || null,
      recent: workflowCache.value?.recent || [],
    };
    workflowCache = { at: now, value };
    return value;
  } finally {
    clearTimeout(timer);
  }
}

// 读全部汇报（倒序，最新在前）
export async function listReports(
  limit,
  storage = { list, readJson },
  model = 'all',
) {
  const { blobs } = await storage.list({ prefix: PREFIX, limit: 10000 });
  const sorted = (blobs || []).slice().sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  ).slice(0, Math.min(400, limit * 2));
  const out = [];
  for (let offset = 0; offset < sorted.length; offset += 8) {
    const batch = await Promise.all(sorted.slice(offset, offset + 8).map(async (b) => {
      const record = await storage.readJson(b);
      return record ? { ...record, id: b.pathname } : null;
    }));
    out.push(...batch.filter(Boolean));
  }
  return dedupeQuantReports(out)
    .filter((report) => (
      model === 'all' || quantReportModel(report) === model
    ))
    .slice(0, limit);
}

export async function readOpportunitySummary(reader = readJson) {
  try {
    return opportunityReportSnapshot(await reader('opportunitymodel/training-status.json'));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (!hasStorage()) return ok(res, { ok: false, error: '云端存储未配置' });

  try {
    if (req.method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const model = req.query.model === 'all' ? 'all' : 'opportunity';
      const [reports, workflow, opportunity] = await Promise.all([
        listReports(limit, { list, readJson }, model),
        workflowStatus(),
        readOpportunitySummary(),
      ]);
      return ok(res, {
        ok: true,
        reports,
        workflow: {
          ...workflow,
          decision: decisionWorkflowRun(workflow, reports),
        },
        opportunity,
      });
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
        if (!id.startsWith(PREFIX) || id.includes('..') || !id.endsWith('.json')) {
          return ok(res, { ok: false, error: '无效的汇报记录' });
        }
        await del(id);
        return ok(res, { ok: true });
      }

      if (action === 'clear') {
        const { blobs } = await list({ prefix: PREFIX, limit: 10000 });
        for (const b of (blobs || [])) await del(b.url);
        return ok(res, { ok: true });
      }

      if (action === 'clear_decision') {
        const { blobs } = await list({ prefix: PREFIX, limit: 10000 });
        for (const blob of (blobs || [])) {
          const record = await readJson(blob);
          if (quantReportModel(record) === 'opportunity') {
            await del(blob.url);
          }
        }
        return ok(res, { ok: true });
      }

      return ok(res, { ok: false, error: '未知 action' });
    }

    return ok(res, { ok: false, error: 'method not allowed' });
  } catch (e) {
    return ok(res, { ok: false, error: String(e.message || e) });
  }
}
