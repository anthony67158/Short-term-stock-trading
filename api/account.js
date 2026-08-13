import { put, list, del, readJsonStrict, hasStorage } from './_blob.js';
import { sendJson, preflight } from './_lib.js';
import { createHash } from 'crypto';
import {
  mergeAutoRefreshSettings,
  newerAutoRefreshPatch,
} from '../shared/adviceAutoRefreshPolicy.js';

// ============ 云端账号 + 数据同步（阿里云 OSS 持久化）============
// 单一入口，按 action 区分：register / login / get / save
// 存储：每个账号一个 current.json 权威快照，并保留 history/ 可恢复版本。
//   { nick, pwHash, createdAt, updatedAt, data:{ plan, holding, closed } }
// 密码以 SHA-256 摘要存储；账号文件名用昵称摘要，避免直接暴露昵称。

const PREFIX = 'accounts/';
export const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const defaultStorage = { put, list, del, readJson: readJsonStrict };
const RECENT_HISTORY = 20;
const DAILY_HISTORY_DAYS = 90;
export const isAccountActive = (account) => !!account && account.status !== 'deactivated';
export function deactivateAccount(account, now = Date.now()) {
  return {
    ...account,
    status: 'deactivated',
    deactivatedAt: now,
  };
}
export function mergeAccountEvents(clientEvents, serverEvents, limit) {
  const merged = new Map();
  for (const event of [...(serverEvents || []), ...(clientEvents || [])]) {
    if (!event || !event.id) continue;
    const current = merged.get(event.id);
    const stamp = event.executedAt || event.verifiedAt || event.at || 0;
    const currentStamp = current && (current.executedAt || current.verifiedAt || current.at || 0);
    if (!current || stamp >= currentStamp) merged.set(event.id, event);
  }
  return [...merged.values()]
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, limit);
}

function mergeAccountAlerts(clientAlerts, serverAlerts) {
  const serverById = new Map((serverAlerts || []).filter((alert) => alert?.id).map((alert) => [alert.id, alert]));
  return (clientAlerts || []).map((client) => {
    const server = serverById.get(client?.id);
    if (!server) return client;
    const withServerContext = server.judgeContext && !client.judgeContext
      ? { ...client, judgeContext: server.judgeContext }
      : client;
    const stamp = (alert) => Math.max(
      Number(alert?.retiredAt) || 0,
      Number(alert?.supersededAt) || 0,
      Number(alert?.triggeredAt) || 0,
      Number(alert?.lastJudgeAt) || 0,
      Number(alert?.watchingAt) || 0,
      Number(alert?.rearmedAt) || 0,
      Number(alert?.outcomeUpdatedAt) || 0,
      Number(alert?.positionCheckedAt) || 0,
    );
    if (stamp(server) > stamp(client)) return { ...client, ...server };
    if (server.phase === 'confirmed' && client.phase === 'confirmed') {
      return {
        ...withServerContext,
        judgeOutcomes: { ...(client.judgeOutcomes || {}), ...(server.judgeOutcomes || {}) },
      };
    }
    return withServerContext;
  });
}

export function applyClientAccountSave(account, incoming, baseRevision) {
  const currentRevision = Number(account.clientRevision) || 0;
  if (!Number.isInteger(baseRevision) || baseRevision !== currentRevision) {
    return {
      ok: false,
      code: 'ACCOUNT_VERSION_CONFLICT',
      error: '云端账号数据已更新，请刷新页面后重试',
      revision: currentRevision,
    };
  }
  const prev = account.data || {};
  // 运行时跨端 pull 只增量合并 AI/预警，不覆盖本机持仓。旧页面可能因此拿到了最新
  // execution 事件，却仍缺少对应交易流水。若允许这种快照保存，会把真实持仓整组盖回旧值。
  const incomingClosedIds = new Set((incoming.closed || []).map((item) => item?.id).filter(Boolean));
  const incomingExecutionTxnIds = new Set((incoming.decisionLog || [])
    .filter((event) => event?.kind === 'execution' && event.transactionId)
    .map((event) => event.transactionId));
  const missingExecutedTrade = (prev.closed || []).find((record) =>
    record?.id &&
    !incomingClosedIds.has(record.id) &&
    incomingExecutionTxnIds.has(record.id)
  );
  if (missingExecutedTrade) {
    return {
      ok: false,
      code: 'TRADE_STATE_CONFLICT',
      error: '云端交易记录已更新，请刷新页面后再操作',
      revision: currentRevision,
    };
  }
  const merged = { ...incoming };
  // AI 任务生命周期只由服务端 Worker 管理。客户端可能持有数秒前的旧快照，
  // 保存持仓时绝不能把正在运行的队列、租约或 Worker 锁覆盖掉。
  if (prev.jobs && typeof prev.jobs === 'object') merged.jobs = prev.jobs;
  if (prev.jobWorker && typeof prev.jobWorker === 'object') merged.jobWorker = prev.jobWorker;
  if (prev.activeAdviceBatchId) merged.activeAdviceBatchId = prev.activeAdviceBatchId;
  if (prev.adviceDailyReport?.summary?.text) {
    merged.adviceDailyReport = prev.adviceDailyReport;
  }
  const settings = mergeAutoRefreshSettings(prev.settings || {}, incoming.settings || {});
  for (const key of [
    'advAuto.holdLastAt', 'advAuto.holdLastTryAt',
    'advAuto.watchLastAt', 'advAuto.watchLastTryAt',
  ]) {
    if (prev.settings?.[key] != null) settings[key] = prev.settings[key];
  }
  merged.settings = settings;
  const cbp = incoming.batchProgress, sbp = prev.batchProgress;
  if (sbp && (!cbp || (sbp.at || 0) > (cbp.at || 0))) merged.batchProgress = sbp;
  const ca = (incoming.advice && typeof incoming.advice === 'object') ? incoming.advice : {};
  const sa = (prev.advice && typeof prev.advice === 'object') ? prev.advice : {};
  const adv = { ...ca };
  for (const [key, value] of Object.entries(sa)) {
    if (!value) continue;
    const current = adv[key];
    if (!current || (value.at || 0) > (current.at || 0)) adv[key] = value;
  }
  merged.advice = adv;
  merged.adviceLog = mergeAccountEvents(incoming.adviceLog, prev.adviceLog, 500);
  merged.decisionLog = mergeAccountEvents(incoming.decisionLog, prev.decisionLog, 1000);
  merged.alerts = mergeAccountAlerts(incoming.alerts, prev.alerts);
  account.data = merged;
  account.clientRevision = currentRevision + 1;
  return { ok: true, revision: account.clientRevision };
}
// 账号目录：current.json 是权威当前值，history/ 保存可恢复快照。
const prefixOf = (nick) => `${PREFIX}${sha('u:' + nick)}/`;
const currentPathOf = (nick) => `${prefixOf(nick)}current.json`;
const historyPrefixOf = (nick) => `${prefixOf(nick)}history/`;
const deactivationPathOf = (nick) => `${prefixOf(nick)}deactivated.json`;
const legacyPathOf = (nick) => `${PREFIX}${sha('u:' + nick)}.json`; // 旧的单文件覆盖式路径（兼容迁移）

// 账号响应绝不缓存(登录/保存态)，走统一 sendJson(cache:0) 契约
function ok(res, obj) {
  sendJson(res, obj, { cache: 0 });
}

// 读取某账号：优先读取权威当前快照；没有则从历史/旧格式中取最新版本。
// OSS 故障必须向上抛出，不能伪装成“账号不存在”。
export async function readAccount(nick, storage = defaultStorage) {
  const current = await storage.readJson(currentPathOf(nick));
  let account = current;

  if (!account) {
    const { blobs } = await storage.list({ prefix: prefixOf(nick), limit: 5000 });
    const latest = (blobs || [])
      .filter((item) => ![currentPathOf(nick), deactivationPathOf(nick)].includes(item.pathname))
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())[0];
    if (latest) account = await storage.readJson(latest);
  }

  if (!account) account = await storage.readJson(legacyPathOf(nick));
  if (!account) return null;

  const marker = await storage.readJson(deactivationPathOf(nick));
  return marker
    ? { ...account, status: 'deactivated', deactivatedAt: marker.deactivatedAt || account.deactivatedAt }
    : account;
}

// 列出【全部账号】的最新快照(供云端定时任务遍历所有用户生成 AI 建议)。
// accounts/ 下形如 accounts/<hash>/<ts>-<rand>.json(新)或 accounts/<hash>.json(旧单文件)。
// 按 hash 目录分组,每组取 uploadedAt 最新的一份读出 → 返回账号对象数组(含 nick/pwHash/data)。
export async function listAllAccounts(storage = defaultStorage) {
  const byNick = new Map();
  try {
    const { blobs } = await storage.list({ prefix: PREFIX, limit: 10000 });
    const groups = new Map(); // key: hash 目录(或旧单文件 key) → 该组最新 blob
    for (const b of (blobs || [])) {
      if (b.pathname.endsWith('/deactivated.json')) continue;
      const rest = b.pathname.slice(PREFIX.length);      // <hash>/<ts>.json 或 <hash>.json
      const key = rest.includes('/') ? rest.split('/')[0] : rest; // 目录 hash 或旧文件名
      const cur = groups.get(key);
      if (!cur || new Date(b.uploadedAt).getTime() > new Date(cur.uploadedAt).getTime()) {
        groups.set(key, b);
      }
    }
    for (const b of groups.values()) {
      const raw = await storage.readJson(b);
      const j = raw && raw.nick ? await readAccount(raw.nick, storage) : null;
      if (!j || !j.nick || !isAccountActive(j)) continue;
      const current = byNick.get(j.nick);
      if (!current || (j.updatedAt || 0) >= (current.updatedAt || 0)) byNick.set(j.nick, j);
    }
  } catch { /* ignore */ }
  return [...byNick.values()];
}

async function cleanupAccountHistory(nick, storage, now) {
  const { blobs } = await storage.list({ prefix: historyPrefixOf(nick), limit: 5000 });
  const sorted = (blobs || []).slice().sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
  const keep = new Set(sorted.slice(0, RECENT_HISTORY).map((item) => item.pathname));
  const daily = new Set();
  const cutoff = now - DAILY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  for (const item of sorted.slice(RECENT_HISTORY)) {
    const stamp = new Date(item.uploadedAt).getTime();
    if (!Number.isFinite(stamp) || stamp < cutoff) continue;
    const day = new Date(stamp).toISOString().slice(0, 10);
    if (!daily.has(day)) {
      daily.add(day);
      keep.add(item.pathname);
    }
  }
  for (const item of sorted) {
    if (!keep.has(item.pathname)) await storage.del(item.pathname);
  }
}

export async function writeAccount(acc, storage = defaultStorage) {
  const saved = { ...acc, updatedAt: Date.now() };
  const body = JSON.stringify(saved);
  const snapshot = await storage.put(`${historyPrefixOf(saved.nick)}${saved.updatedAt}.json`, body, {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: true, cacheControlMaxAge: 0,
  });
  await storage.put(currentPathOf(saved.nick), body, {
    access: 'public', contentType: 'application/json',
    cacheControlMaxAge: 0,
  });

  const verified = await storage.readJson(currentPathOf(saved.nick));
  if (!verified || verified.updatedAt !== saved.updatedAt || verified.nick !== saved.nick) {
    throw new Error('OSS 账号快照写入校验失败');
  }

  // 保留最近 20 份细粒度版本，并为最近 90 天每天保留一个恢复点。
  try {
    await cleanupAccountHistory(saved.nick, storage, saved.updatedAt);
  } catch { /* ignore */ }
  return { ...saved, storage: 'oss', snapshotKey: snapshot.pathname };
}

export async function deactivateStoredAccount(account, storage = defaultStorage, now = Date.now()) {
  const deactivated = deactivateAccount(account, now);
  await storage.put(deactivationPathOf(account.nick), JSON.stringify({
    status: 'deactivated',
    deactivatedAt: now,
  }), {
    access: 'public', contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
  return writeAccount(deactivated, storage);
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return ok(res, { ok: false, error: 'POST only' });
  if (!hasStorage()) return ok(res, { ok: false, error: '云端存储未配置' });

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
      if (exist) {
        const error = isAccountActive(exist)
          ? '该昵称已存在，请直接登录或换一个'
          : '该昵称已注销，数据仍保存在 OSS，如需恢复请联系管理员';
        return ok(res, { ok: false, error });
      }
      const data = (body.data && typeof body.data === 'object') ? body.data : { plan: [], holding: [], closed: [] };
      const acc = await writeAccount({
        nick, pwHash: sha(pw), createdAt: Date.now(),
        clientRevision: 1, data,
      });
      return ok(res, {
        ok: true, nick: acc.nick, data: acc.data,
        updatedAt: acc.updatedAt, revision: acc.clientRevision, storage: acc.storage,
      });
    }

    if (action === 'login' || action === 'get') {
      const acc = await readAccount(nick);
      if (!acc) return ok(res, { ok: false, error: '账号不存在，请先注册' });
      if (acc.pwHash !== sha(pw)) return ok(res, { ok: false, error: '密码错误' });
      if (!isAccountActive(acc)) return ok(res, { ok: false, error: '账号已注销，数据仍保存在 OSS' });
      return ok(res, {
        ok: true, nick: acc.nick,
        data: acc.data || { plan: [], holding: [], closed: [] },
        updatedAt: acc.updatedAt, revision: Number(acc.clientRevision) || 0, storage: 'oss',
      });
    }

    if (action === 'save') {
      const acc = await readAccount(nick);
      if (!acc) return ok(res, { ok: false, error: '账号不存在' });
      if (acc.pwHash !== sha(pw)) return ok(res, { ok: false, error: '密码错误' });
      if (!isAccountActive(acc)) return ok(res, { ok: false, error: '账号已注销，不能继续保存' });
      const incoming = (body.data && typeof body.data === 'object') ? body.data : null;
      if (incoming) {
        const applied = applyClientAccountSave(acc, incoming, Number(body.baseRevision));
        if (!applied.ok) {
          const refreshPatch = newerAutoRefreshPatch(acc.data?.settings || {}, incoming.settings || {});
          let settingsSaved = false;
          if (refreshPatch) {
            acc.data = acc.data || {};
            acc.data.settings = { ...(acc.data.settings || {}), ...refreshPatch };
            await writeAccount(acc);
            settingsSaved = true;
          }
          return ok(res, {
            ok: false,
            code: applied.code,
            error: applied.error,
            revision: applied.revision,
            retryable: false,
            settingsSaved,
          });
        }
      }
      const saved = await writeAccount(acc);
      return ok(res, {
        ok: true, updatedAt: saved.updatedAt,
        revision: saved.clientRevision,
        storage: saved.storage, snapshotKey: saved.snapshotKey,
      });
    }

    if (action === 'deactivate') {
      const acc = await readAccount(nick);
      if (!acc) return ok(res, { ok: false, error: '账号不存在' });
      if (acc.pwHash !== sha(pw)) return ok(res, { ok: false, error: '密码错误' });
      if (!isAccountActive(acc)) {
        return ok(res, {
          ok: true, deactivated: true, retainedInOss: true,
          deactivatedAt: acc.deactivatedAt || acc.updatedAt,
        });
      }
      const saved = await deactivateStoredAccount(acc);
      return ok(res, {
        ok: true, deactivated: true, retainedInOss: true,
        deactivatedAt: saved.deactivatedAt,
        storage: saved.storage, snapshotKey: saved.snapshotKey,
      });
    }

    if (action === 'delete') {
      const acc = await readAccount(nick);
      if (!acc) return ok(res, { ok: false, error: '账号不存在' });
      if (acc.pwHash !== sha(pw)) return ok(res, { ok: false, error: '密码错误' });
      try {
        const { blobs } = await list({ prefix: prefixOf(nick), limit: 5000 });
        for (const b of (blobs || [])) { try { await del(b.url); } catch { /* ignore */ } }
        try { await del(legacyPathOf(nick)); } catch { /* ignore */ }
      } catch { /* ignore */ }
      return ok(res, { ok: true });
    }

    return ok(res, { ok: false, error: '未知 action' });
  } catch (e) {
    console.error('[account] OSS operation failed', e && (e.code || e.name || e.message));
    return ok(res, { ok: false, error: '阿里云 OSS 存储访问失败，请稍后重试' });
  }
}
