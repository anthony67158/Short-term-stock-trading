// ============ /api/llm_config：AI 模型配置端点 ============
// 前端「AI 模型配置」向导用。四个 action：
//   get    → 返回当前配置的安全视图（Key 只给掩码）
//   verify → 用给定 baseUrl+apiKey 实测连通性：拉 /models 列表；拉不到也回连通标志
//   test   → 用给定(或已存) baseUrl+apiKey 对指定模型逐个发 1-token 请求，返回每个 ✓/✗+延迟
//   save   → 落库 OSS(config/llm.json)；apiKey 留空则保留原 Key
//
// 安全：apiKey 明文只在 verify/test/save 的【请求体入参】里出现，绝不写日志、绝不回传。

import { applyCors, preflight } from './_lib.js';
import {
  ensureConfig, currentConfig, saveConfig, publicView, resolveJudgeEndpoint, ROLES,
} from './_llm_config.js';
import { poolStatus, endpointCountForRole, judgeEndpointStatus } from './_llm_pool.js';
import { authorizePaidRequest } from './_account_auth.js';

export const MODEL_TEST_TIMEOUT_MS = 120000;

const normalizeBaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

export function resolveLlmConfigTarget(config = {}, body = {}) {
  const endpointId = String(body.endpointId || (body.target === 'judge' ? 'judge' : 'default'));
  let stored = null;
  if (endpointId === 'judge') {
    stored = resolveJudgeEndpoint(config);
  } else if (endpointId === 'default') {
    stored = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    };
  } else {
    stored = (config.endpoints || []).find((endpoint) => endpoint?.id === endpointId) || null;
    if (!stored) {
      return {
        endpointId,
        baseUrl: '',
        apiKey: '',
        error: '指定端点不存在',
      };
    }
  }

  const storedBase = normalizeBaseUrl(stored?.baseUrl);
  const requestedBase = normalizeBaseUrl(body.baseUrl);
  const baseUrl = requestedBase || storedBase;
  const providedKey = body.apiKey && !/\*/.test(String(body.apiKey))
    ? String(body.apiKey).trim()
    : '';
  const canReuseStoredKey = !requestedBase || requestedBase === storedBase;
  return {
    endpointId,
    baseUrl,
    apiKey: providedKey || (canReuseStoredKey ? String(stored?.apiKey || '') : ''),
  };
}

// 用一对 base/key 拉可用模型列表（OpenAI 兼容 GET /models）
async function fetchModels(baseUrl, apiKey) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base || !apiKey) return { ok: false, error: '缺少 Base URL 或 API Key', models: [] };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${base}/models`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) {
      // 401/403 → key 无效；其它 → 端点不支持 /models（仍可能可用），交由 test 兜底
      const auth = r.status === 401 || r.status === 403;
      return { ok: !auth, error: `HTTP ${r.status}`, status: r.status, models: [], listable: false };
    }
    const j = await r.json().catch(() => null);
    const arr = (j && (j.data || j.models || [])) || [];
    const models = arr.map((m) => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
    return { ok: true, models, listable: true };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return { ok: false, error: aborted ? '连接超时' : String(e && e.message || e), models: [] };
  } finally { clearTimeout(t); }
}

// 对单个模型发最小请求，测可用性 + 延迟
async function pingModel(baseUrl, apiKey, model) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), MODEL_TEST_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0 }),
    });
    const ms = Date.now() - t0;
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      try { const j = await r.json(); if (j && j.error && j.error.message) detail = j.error.message; } catch { /* ignore */ }
      return { model, ok: false, ms, error: detail };
    }
    // 只要能拿到合规响应体即视为可用（不强制有 content，max_tokens=1 可能空）
    await r.json().catch(() => null);
    return { model, ok: true, ms };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return { model, ok: false, ms: Date.now() - t0, error: aborted ? '超时' : String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const accountAuth = await authorizePaidRequest(req);
    if (!accountAuth.ok) {
      return res.status(accountAuth.error === '请先登录' ? 401 : 403)
        .send(JSON.stringify({ ok: false, error: accountAuth.error }));
    }
    await ensureConfig({ maxAgeMs: 0 });
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const action = (body && body.action) || (req.query && req.query.action) || 'get';

    if (action === 'get') {
      const config = currentConfig();
      const roles = Object.fromEntries(Object.entries(ROLES).filter(([role]) => role !== 'judge'));
      return res.status(200).send(JSON.stringify({
        ok: true,
        config: publicView(),
        roles,
        judgeRole: ROLES.judge,
        pool: poolStatus(config),
        judgePool: judgeEndpointStatus(config),
        concurrency: endpointCountForRole(config, 'advisor'),
      }));
    }

    // verify / test / save 都可能带明文 key；留空则用已存 key
    const cur = currentConfig();
    const judgeTarget = body && body.target === 'judge';
    const judgeEndpoint = resolveJudgeEndpoint(cur);
    const target = resolveLlmConfigTarget(cur, body || {});
    if (target.error) {
      return res.status(200).send(JSON.stringify({
        ok: false,
        error: target.error,
      }));
    }
    const { baseUrl, apiKey } = target;

    if (action === 'verify') {
      const r = await fetchModels(baseUrl, apiKey);
      return res.status(200).send(JSON.stringify({
        ok: r.ok, error: r.ok ? undefined : (r.error || '验证失败'),
        listable: !!r.listable, models: r.models || [],
      }));
    }

    if (action === 'test') {
      const models = Array.isArray(body && body.models) ? body.models.filter(Boolean)
        : (judgeTarget
          ? [judgeEndpoint?.model].filter(Boolean)
          : Object.values((body && body.modelMap) || cur.models || {}).filter(Boolean));
      const uniq = [...new Set(models)];
      if (!uniq.length) return res.status(200).send(JSON.stringify({ ok: false, error: '没有要测试的模型' }));
      const results = await Promise.all(uniq.map((m) => pingModel(baseUrl, apiKey, m)));
      return res.status(200).send(JSON.stringify({ ok: results.every((x) => x.ok), results }));
    }

    if (action === 'save') {
      const patch = {
        baseUrl: body && body.baseUrl,
        apiKey: body && body.apiKey,     // 空则 saveConfig 内部保留原 key
        models: body && body.models,
        reasoning: body && body.reasoning,
        primaryMaxInflight: body && body.primaryMaxInflight,
        endpoints: body && body.endpoints,   // 多端点资源池(整组替换;掩码 key 不覆盖旧值)
      };
      if (body && Object.prototype.hasOwnProperty.call(body, 'judgeEndpoint')) {
        patch.judgeEndpoint = body.judgeEndpoint;
      }
      const saved = await saveConfig(patch);
      return res.status(200).send(JSON.stringify({
        ok: true,
        config: publicView(),
        source: saved.source,
        pool: poolStatus(currentConfig()),
        judgePool: judgeEndpointStatus(currentConfig()),
      }));
    }

    return res.status(200).send(JSON.stringify({ ok: false, error: '未知 action: ' + action }));
  } catch (e) {
    return res.status(200).send(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
}
