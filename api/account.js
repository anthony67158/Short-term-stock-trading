import { put, list, del } from '@vercel/blob';
import { createHash } from 'crypto';

// ============ 云端账号 + 数据同步（Vercel Blob 持久化）============
// 单一入口，按 action 区分：register / login / get / save
// 存储：每个账号一个 blob，pathname = accounts/<hash(nick)>.json
//   { nick, pwHash, createdAt, updatedAt, data:{ plan, holding, closed } }
// 密码以 SHA-256 摘要存储；账号文件名用昵称摘要，避免直接暴露昵称。

const PREFIX = 'accounts/';
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const pathOf = (nick) => `${PREFIX}${sha('u:' + nick)}.json`;

function ok(res, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).send(JSON.stringify(obj));
}

// 读取某账号的 blob（找不到返回 null）
async function readAccount(nick) {
  try {
    const { blobs } = await list({ prefix: pathOf(nick), limit: 1 });
    if (!blobs || !blobs.length) return null;
    const r = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function writeAccount(acc) {
  acc.updatedAt = Date.now();
  await put(pathOf(acc.nick), JSON.stringify(acc), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: false, allowOverwrite: true,
  });
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
        const { blobs } = await list({ prefix: pathOf(nick), limit: 1 });
        if (blobs && blobs.length) await del(blobs[0].url);
      } catch { /* ignore */ }
      return ok(res, { ok: true });
    }

    return ok(res, { ok: false, error: '未知 action' });
  } catch (e) {
    return ok(res, { ok: false, error: String(e.message || e) });
  }
}
