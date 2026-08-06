// ============ Web Push 订阅管理(服务端) ============
// 存储:把每个账号的推送订阅存进该账号 data.pushSubs 数组(随 OSS 账号一起持久化)。
//   sub = { endpoint, keys:{p256dh,auth}, ua, at }  —— 以 endpoint 去重(同设备重复订阅只留一份)。
// 只读写 data.pushSubs,绝不动 plan/holding/closed/account(避免覆盖用户编辑)。
// 鉴权:复用账号昵称+密码摘要(与 account.js 同口径),防止别人给你的账号乱塞订阅。
//
// 请求:POST /api/push
//   { action:'subscribe', nick, pw, subscription, ua }   → 新增/更新订阅
//   { action:'unsubscribe', nick, pw, endpoint }         → 删除本设备订阅

import { applyCors, preflight } from './_lib.js';
import { createHash } from 'crypto';
import { list, readJson } from './_blob.js';
import { writeAccount } from './account.js';

const PREFIX = 'accounts/';
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const prefixOf = (nick) => `${PREFIX}${sha('u:' + nick)}/`;
const legacyPathOf = (nick) => `${PREFIX}${sha('u:' + nick)}.json`;

async function readAccount(nick) {
  try {
    const { blobs } = await list({ prefix: prefixOf(nick), limit: 100 });
    if (blobs && blobs.length) {
      const latest = blobs.slice().sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())[0];
      const j = await readJson(latest);
      if (j) return j;
    }
    const { blobs: old } = await list({ prefix: legacyPathOf(nick), limit: 1 });
    if (old && old.length) { const j = await readJson(old[0]); if (j) return j; }
    return null;
  } catch { return null; }
}

function json(res, obj, code = 200) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  applyCors(res);
  res.statusCode = code;
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  if (req.method !== 'POST') return json(res, { ok: false, error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
  body = body || {};

  const action = body.action;
  const nick = String(body.nick || '').trim();
  const pw = body.pw != null ? String(body.pw) : '';
  if (!nick || !pw) return json(res, { ok: false, error: '缺少账号凭证' });

  const acc = await readAccount(nick);
  if (!acc) return json(res, { ok: false, error: '账号不存在' });
  if (acc.pwHash !== sha(pw)) return json(res, { ok: false, error: '密码错误' });

  const data = acc.data || (acc.data = {});
  const subs = Array.isArray(data.pushSubs) ? data.pushSubs : (data.pushSubs = []);

  try {
    if (action === 'subscribe') {
      const s = body.subscription;
      if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) {
        return json(res, { ok: false, error: '订阅信息不完整' });
      }
      const clean = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, ua: String(body.ua || '').slice(0, 200), at: Date.now() };
      const idx = subs.findIndex((x) => x && x.endpoint === clean.endpoint);
      if (idx >= 0) subs[idx] = clean; else subs.push(clean);
      // 上限保护:每账号最多留 10 个设备,超出淘汰最旧
      if (subs.length > 10) { subs.sort((a, b) => (b.at || 0) - (a.at || 0)); data.pushSubs = subs.slice(0, 10); }
      await writeAccount(acc);
      return json(res, { ok: true, count: (data.pushSubs || subs).length });
    }

    if (action === 'unsubscribe') {
      const ep = String(body.endpoint || '');
      data.pushSubs = subs.filter((x) => x && x.endpoint !== ep);
      await writeAccount(acc);
      return json(res, { ok: true, count: data.pushSubs.length });
    }

    return json(res, { ok: false, error: '未知 action' });
  } catch (e) {
    return json(res, { ok: false, error: String(e.message || e) });
  }
}
