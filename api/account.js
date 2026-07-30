import { put, list, del } from '@vercel/blob';
import { createHash } from 'crypto';

// ============ 云端账号 + 数据同步（Vercel Blob 持久化）============
// 单一入口，按 action 区分：register / login / get / save
// 存储：每个账号一个 blob，pathname = accounts/<hash(nick)>.json
//   { nick, pwHash, createdAt, updatedAt, data:{ plan, holding, closed } }
// 密码以 SHA-256 摘要存储；账号文件名用昵称摘要，避免直接暴露昵称。

const PREFIX = 'accounts/';
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
// 账号的 blob 前缀（目录式）：每次写入生成唯一文件名，读取取最新，彻底规避 Vercel Blob 覆盖写的 CDN 强缓存
const prefixOf = (nick) => `${PREFIX}${sha('u:' + nick)}/`;
const legacyPathOf = (nick) => `${PREFIX}${sha('u:' + nick)}.json`; // 旧的单文件覆盖式路径（兼容迁移）

function ok(res, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).send(JSON.stringify(obj));
}

// 读取某账号：优先读新目录下最新版本；没有则回退旧单文件路径（老用户平滑迁移）
async function readAccount(nick) {
  try {
    const { blobs } = await list({ prefix: prefixOf(nick), limit: 100 });
    if (blobs && blobs.length) {
      const latest = blobs.slice().sort(
        (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      )[0];
      const url = latest.downloadUrl || latest.url;
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) return await r.json();
    }
    // 回退：旧单文件路径
    const { blobs: old } = await list({ prefix: legacyPathOf(nick), limit: 1 });
    if (old && old.length) {
      const base = old[0].downloadUrl || old[0].url;
      const bust = base + (base.includes('?') ? '&' : '?') + '_t=' + Date.now();
      const r = await fetch(bust, { cache: 'no-store' });
      if (r.ok) return await r.json();
    }
    return null;
  } catch { return null; }
}

async function writeAccount(acc) {
  acc.updatedAt = Date.now();
  // 用唯一文件名写入（addRandomSuffix），保证每次都是新 URL，绝不读到 CDN 旧副本
  await put(`${prefixOf(acc.nick)}${acc.updatedAt}.json`, JSON.stringify(acc), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: true, cacheControlMaxAge: 0,
  });
  // 清理旧版本，避免无限堆积（保留最近3份即可）
  try {
    const { blobs } = await list({ prefix: prefixOf(acc.nick), limit: 100 });
    const olds = blobs.slice()
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
      .slice(3);
    for (const b of olds) { try { await del(b.url); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  return acc;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return res.status(200).end(); }
  if (req.method !== 'POST') return ok(res, { ok: false, error: 'POST only' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return ok(res, { ok: false, error: '云端存储未配置' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const action = body.action;
    const nick = String(body.nick || '').trim();
    const pw = body.pw != null ? String(body.pw) : '';

    if (action === 'register') {
      if (!nick) return ok(res, { ok: false, error: '请输入昵称' });
      if (!pw) return ok(res, { ok: false, error: '请输入密码' });
      const exist = await readAccount(nick);
      if (exist) return ok(res, { ok: false, error: '该昵称已存在，请直接登录或换一个' });
      const data = (body.data && typeof body.data === 'object') ? body.data : { plan: [], holding: [], closed: [] };
      const acc = await writeAccount({ nick, pwHash: sha(pw), createdAt: Date.now(), data });
      return ok(res, { ok: true, nick: acc.nick, data: acc.data, updatedAt: acc.updatedAt });
    }

    if (action === 'login' || action === 'get') {
      const acc = await readAccount(nick);
      if (!acc) return ok(res, { ok: false, error: '账号不存在，请先注册' });
      if (acc.pwHash !== sha(pw)) return ok(res, { ok: false, error: '密码错误' });
      return ok(res, { ok: true, nick: acc.nick, data: acc.data || { plan: [], holding: [], closed: [] }, updatedAt: acc.updatedAt });
    }

    if (action === 'save') {
      const acc = await readAccount(nick);
      if (!acc) return ok(res, { ok: false, error: '账号不存在' });
      if (acc.pwHash !== sha(pw)) return ok(res, { ok: false, error: '密码错误' });
      acc.data = (body.data && typeof body.data === 'object') ? body.data : acc.data;
      const saved = await writeAccount(acc);
      return ok(res, { ok: true, updatedAt: saved.updatedAt });
    }

    if (action === 'delete') {
      const acc = await readAccount(nick);
      if (!acc) return ok(res, { ok: false, error: '账号不存在' });
      if (acc.pwHash !== sha(pw)) return ok(res, { ok: false, error: '密码错误' });
      try {
        const { blobs } = await list({ prefix: prefixOf(nick), limit: 100 });
        for (const b of (blobs || [])) { try { await del(b.url); } catch { /* ignore */ } }
      } catch { /* ignore */ }
      return ok(res, { ok: true });
    }

    return ok(res, { ok: false, error: '未知 action' });
  } catch (e) {
    return ok(res, { ok: false, error: String(e.message || e) });
  }
}
