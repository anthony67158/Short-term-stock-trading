import { authorizePaidRequest } from './_account_auth.js';
import {
  ensureAiSearchConfig,
  publicAiSearchConfig,
  saveAiSearchConfig,
} from './_ai_search_config.js';
import { applyCors, preflight } from './_lib.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    return res.status(405).send(JSON.stringify({
      ok: false,
      error: 'POST only',
    }));
  }

  const accountAuth = await authorizePaidRequest(req);
  if (!accountAuth.ok) {
    return res.status(accountAuth.error === '请先登录' ? 401 : 403)
      .send(JSON.stringify({ ok: false, error: accountAuth.error }));
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const action = String(body?.action || 'get');
    if (action === 'get') {
      const config = await ensureAiSearchConfig({ maxAgeMs: 0 });
      return res.status(200).send(JSON.stringify({
        ok: true,
        config: publicAiSearchConfig(config),
      }));
    }
    if (action === 'save') {
      const patch = {};
      if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body?.apiKey === 'string') patch.apiKey = body.apiKey;
      const saved = await saveAiSearchConfig(patch);
      return res.status(200).send(JSON.stringify({
        ok: true,
        config: publicAiSearchConfig(saved),
      }));
    }
    return res.status(400).send(JSON.stringify({
      ok: false,
      error: '未知 action',
    }));
  } catch (error) {
    const message = String(error?.message || error);
    const invalid = /格式无效|未知 action/.test(message);
    return res.status(invalid ? 400 : 500).send(JSON.stringify({
      ok: false,
      error: invalid ? message : 'AI检索配置保存失败',
    }));
  }
}
