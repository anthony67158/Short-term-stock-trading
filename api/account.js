import {
  put,
  list,
  del,
  readJsonStrict,
  readJsonWithMetaStrict,
  hasStorage,
} from './_blob.js';
import { sendJson, preflight } from './_lib.js';
import { createHash } from 'crypto';
import {
  mergeAutoRefreshSettings,
  newerAutoRefreshPatch,
} from '../shared/adviceAutoRefreshPolicy.js';
import { adviceEntryMatchesMode } from '../shared/adviceModeContext.js';
import { accountTradeStateFingerprint } from '../shared/accountSync.js';
import {
  mergeReviewsByTimestamp,
  reviewsAfter,
} from '../shared/reviewSchedule.js';
import {
  evidenceSnapshotsFromData,
  mergeEvidenceSnapshotIndexes,
} from '../shared/evidenceSnapshot.js';
import {
  createAccountSessionToken,
  verifyAccountSessionToken,
} from './_account_session.js';

// ============ 云端账号 + 数据同步（阿里云 OSS 持久化）============
// 单一入口，按 action 区分：register / login / get / save
// 存储：每个账号一个 current.json 权威快照，并保留 history/ 可恢复版本。
//   { nick, pwHash, createdAt, updatedAt, data:{ plan, holding, closed } }
// 密码以 SHA-256 摘要存储；账号文件名用昵称摘要，避免直接暴露昵称。

const PREFIX = 'accounts/';
export const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const defaultStorage = {
  put,
  list,
  del,
  readJson: readJsonStrict,
  readJsonWithMeta: readJsonWithMetaStrict,
};
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

function newestStamp(value, keys) {
  return Math.max(...keys.map((key) => Number(value?.[key]) || 0), 0);
}

export function accountSyncDelta(data = {}, since = 0) {
  const after = Number(since) || 0;
  const jobs = data.jobs && typeof data.jobs === 'object'
    ? data.jobs
    : {};
  const advice = Object.fromEntries(
    Object.entries(data.advice || {}).filter(([code, entry]) => {
      const job = jobs[code];
      const completedAfterCursor = job?.status === 'done'
        && newestStamp(job, ['finishedAt', 'progressAt']) > after;
      return newestStamp(entry, ['at', 'cachedAt', 'updatedAt']) > after
        || completedAfterCursor;
    }),
  );
  const adviceLog = (data.adviceLog || []).filter((entry) =>
    newestStamp(entry, ['verifiedAt', 'outcomeUpdatedAt', 'at']) > after
  );
  const decisionLog = (data.decisionLog || []).filter((entry) =>
    newestStamp(entry, ['outcomeUpdatedAt', 'verifiedAt', 'executedAt', 'at']) > after
  );
  return {
    advice,
    adviceLog,
    decisionLog,
    reviews: reviewsAfter(data.reviews, after),
    // 预警只有 166 KiB，整组返回可覆盖旧记录缺少 updatedAt 的兼容场景。
    alerts: Array.isArray(data.alerts) ? data.alerts : [],
    batchProgress: data.batchProgress || null,
    tradeStateResetAt: Number(data.tradeStateResetAt) || 0,
  };
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

export function applyClientAccountSave(
  account,
  incoming,
  baseRevision,
  { forceTradeState = false } = {},
) {
  const currentRevision = Number(account.clientRevision) || 0;
  if (
    !forceTradeState
    && (
      !Number.isInteger(baseRevision)
      || baseRevision !== currentRevision
    )
  ) {
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
  if (missingExecutedTrade && !forceTradeState) {
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
  if (
    prev.adviceBatchCancellations
    && typeof prev.adviceBatchCancellations === 'object'
  ) {
    merged.adviceBatchCancellations = {
      ...(incoming.adviceBatchCancellations || {}),
      ...prev.adviceBatchCancellations,
    };
  }
  if (Number(prev.adviceAutoPauseUntil) > 0) {
    merged.adviceAutoPauseUntil = Math.max(
      Number(incoming.adviceAutoPauseUntil) || 0,
      Number(prev.adviceAutoPauseUntil) || 0,
    );
  }
  if (Number(prev.tradeStateResetAt) > 0) {
    merged.tradeStateResetAt = Math.max(
      Number(incoming.tradeStateResetAt) || 0,
      Number(prev.tradeStateResetAt) || 0,
    );
  }
  if (Number(prev.runtimeStateAppliedAt) > 0) {
    merged.runtimeStateAppliedAt = Math.max(
      Number(incoming.runtimeStateAppliedAt) || 0,
      Number(prev.runtimeStateAppliedAt) || 0,
    );
  }
  if (
    prev.runtimeAdviceAppliedAt
    && typeof prev.runtimeAdviceAppliedAt === 'object'
  ) {
    merged.runtimeAdviceAppliedAt = {
      ...(incoming.runtimeAdviceAppliedAt || {}),
      ...prev.runtimeAdviceAppliedAt,
    };
  }
  if (
    prev.portfolioAnalysisJob
    && typeof prev.portfolioAnalysisJob === 'object'
  ) {
    merged.portfolioAnalysisJob = prev.portfolioAnalysisJob;
  }
  if (
    prev.portfolioAnalysisLatest
    && typeof prev.portfolioAnalysisLatest === 'object'
  ) {
    merged.portfolioAnalysisLatest = prev.portfolioAnalysisLatest;
  }
  if (Array.isArray(prev.portfolioAnalysisHistory)) {
    merged.portfolioAnalysisHistory = prev.portfolioAnalysisHistory;
  }
  if (
    prev.portfolioAnalysisReview
    && typeof prev.portfolioAnalysisReview === 'object'
  ) {
    merged.portfolioAnalysisReview = prev.portfolioAnalysisReview;
  }
  if (prev.adviceDailyReport?.summary?.text) {
    merged.adviceDailyReport = prev.adviceDailyReport;
  }
  // Web Push 订阅只允许 /api/push 增删。普通账本保存不携带该字段，
  // 不能用客户端快照把服务端已绑定的设备订阅清空。
  if (Array.isArray(prev.pushSubs)) merged.pushSubs = prev.pushSubs;
  merged.reviews = mergeReviewsByTimestamp(incoming.reviews, prev.reviews);
  if (prev.reviewAuto && typeof prev.reviewAuto === 'object') {
    merged.reviewAuto = prev.reviewAuto;
  }
  for (const key of [
    'realOutcomeLearning',
    'advisorCouncilShadow',
    'strategyHumanApproval',
    'strategyGovernanceV2',
    'adviceEventKeys',
  ]) {
    if (prev[key] != null) merged[key] = prev[key];
    else delete merged[key];
  }
  merged.evidenceSnapshots = mergeEvidenceSnapshotIndexes(
    {
      ...(prev.evidenceSnapshots || {}),
      ...evidenceSnapshotsFromData(prev),
    },
    {
      ...(incoming.evidenceSnapshots || {}),
      ...evidenceSnapshotsFromData(incoming),
    },
  );
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
  const heldCodes = new Set(
    (merged.holding || []).map((holding) => String(holding?.code || '')).filter(Boolean),
  );
  if (merged.jobs && typeof merged.jobs === 'object') {
    for (const job of Object.values(merged.jobs)) {
      if (
        !job
        || job.mode !== 'hold_advice'
        || heldCodes.has(String(job.code || ''))
        || !['queued', 'running'].includes(job.status)
      ) continue;
      job.cancelRequested = true;
      job.status = 'canceled';
      job.finishedAt = Date.now();
      job.leaseUntil = 0;
      job.phase = '持仓已清仓，旧持仓复核已取消';
      job.progressAt = job.finishedAt;
    }
  }
  merged.advice = Object.fromEntries(
    Object.entries(adv).filter(([code, entry]) =>
      adviceEntryMatchesMode(
        entry,
        heldCodes.has(String(code)) ? 'hold_advice' : 'buy_advice',
      )
    ),
  );
  merged.adviceLog = mergeAccountEvents(incoming.adviceLog, prev.adviceLog, 500);
  merged.decisionLog = mergeAccountEvents(incoming.decisionLog, prev.decisionLog, 1000);
  merged.adviceReviewLog = mergeAccountEvents(
    incoming.adviceReviewLog,
    prev.adviceReviewLog,
    500,
  );
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
const adviceRuntimePrefixOf = (nick) => `${prefixOf(nick)}runtime/advice/`;
const adviceRuntimeStatePathOf = (nick) => `${prefixOf(nick)}runtime/state.json`;
const adviceRuntimeUpdatePathOf = (nick, code) =>
  `${adviceRuntimePrefixOf(nick)}${String(code || '').replace(/[^0-9A-Za-z_-]/g, '')}.json`;

function runtimeStamp(value) {
  return Math.max(
    Number(value?.updatedAt) || 0,
    Number(value?.progressAt) || 0,
    Number(value?.finishedAt) || 0,
    Number(value?.at) || 0,
  );
}

function runtimeRecordKey(item) {
  if (item?.id) return String(item.id);
  if (item?.schemaVersion === 'advisor-council-shadow.v1') {
    return [
      item.code,
      item.at,
      item.evidenceSnapshotId,
      item.baseAdviceAction,
    ].join('|');
  }
  return '';
}

function mergeRuntimeRecords(current = [], incoming = [], limit = 1000) {
  const records = new Map(
    (Array.isArray(current) ? current : [])
      .map((item) => [runtimeRecordKey(item), item])
      .filter(([key]) => key),
  );
  for (const item of (Array.isArray(incoming) ? incoming : [])) {
    const key = runtimeRecordKey(item);
    if (!key) continue;
    const previous = records.get(key);
    if (!previous || runtimeStamp(item) >= runtimeStamp(previous)) {
      records.set(key, item);
    }
  }
  return [...records.values()]
    .sort((left, right) => runtimeStamp(right) - runtimeStamp(left))
    .slice(0, limit);
}

function mergeRuntimeJob(current, incoming) {
  if (!incoming) return current;
  if (!current || runtimeStamp(incoming) >= runtimeStamp(current)) {
    return incoming;
  }
  return current;
}

export function mergeAdviceRuntimeState(account, runtime) {
  if (!account || !runtime || typeof runtime !== 'object') return account;
  const updatedAt = Number(runtime.updatedAt) || 0;
  const data = account.data || (account.data = {});
  if (updatedAt <= (Number(data.runtimeStateAppliedAt) || 0)) {
    return account;
  }
  if (runtime.jobs && typeof runtime.jobs === 'object') {
    const jobs = { ...(data.jobs || {}) };
    for (const [code, job] of Object.entries(runtime.jobs)) {
      jobs[code] = mergeRuntimeJob(jobs[code], job);
    }
    data.jobs = jobs;
  }
  for (const key of [
    'jobWorker',
    'activeAdviceBatchId',
    'adviceBatchCancellations',
    'adviceAutoPauseUntil',
  ]) {
    if (runtime[key] != null) data[key] = runtime[key];
  }
  if (
    runtime.batchProgress
    && runtimeStamp(runtime.batchProgress)
      >= runtimeStamp(data.batchProgress)
  ) data.batchProgress = runtime.batchProgress;
  if (
    runtime.adviceDailyReport
    && runtimeStamp(runtime.adviceDailyReport)
      >= runtimeStamp(data.adviceDailyReport)
  ) data.adviceDailyReport = runtime.adviceDailyReport;
  if (runtime.settings && typeof runtime.settings === 'object') {
    data.settings = {
      ...(data.settings || {}),
      ...runtime.settings,
    };
  }
  data.runtimeStateAppliedAt = updatedAt;
  account.updatedAt = Math.max(Number(account.updatedAt) || 0, updatedAt);
  return account;
}

export function mergeAdviceRuntimeUpdate(account, update) {
  if (!account || !update?.code) return account;
  const updatedAt = Number(update.updatedAt) || 0;
  const data = account.data || (account.data = {});
  const cursors = data.runtimeAdviceAppliedAt
    && typeof data.runtimeAdviceAppliedAt === 'object'
    ? data.runtimeAdviceAppliedAt
    : {};
  const code = String(update.code);
  if (updatedAt <= (Number(cursors[code]) || 0)) return account;

  if (update.advice) {
    const advice = data.advice || (data.advice = {});
    if (
      !advice[code]
      || runtimeStamp(update.advice) >= runtimeStamp(advice[code])
    ) advice[code] = update.advice;
  }
  if (update.job) {
    const jobs = data.jobs || (data.jobs = {});
    jobs[code] = mergeRuntimeJob(jobs[code], update.job);
  }
  data.adviceLog = mergeRuntimeRecords(
    data.adviceLog,
    update.adviceLog,
    500,
  );
  data.decisionLog = mergeRuntimeRecords(
    data.decisionLog,
    update.decisionLog,
    1000,
  );
  data.adviceReviewLog = mergeRuntimeRecords(
    data.adviceReviewLog,
    update.adviceReviewLog,
    500,
  );
  data.advisorCouncilShadow = mergeRuntimeRecords(
    data.advisorCouncilShadow,
    update.councilShadow,
    200,
  );
  data.evidenceSnapshots = mergeEvidenceSnapshotIndexes(
    data.evidenceSnapshots,
    update.evidenceSnapshots,
  );
  data.alerts = mergeRuntimeRecords(data.alerts, update.alerts, 1000);
  if (
    update.batchProgress
    && runtimeStamp(update.batchProgress)
      >= runtimeStamp(data.batchProgress)
  ) data.batchProgress = update.batchProgress;
  for (const [collection, patch] of [
    ['holding', update.holdingPatch],
    ['plan', update.planPatch],
  ]) {
    if (!patch?.code || !Array.isArray(data[collection])) continue;
    data[collection] = data[collection].map((item) =>
      String(item?.code) === code
        ? {
            ...item,
            ...(patch.qScore != null ? { qScore: patch.qScore } : {}),
            ...(patch.qBias != null ? { qBias: patch.qBias } : {}),
            ...(patch.qAt != null ? { qAt: patch.qAt } : {}),
          }
        : item
    );
  }
  data.runtimeAdviceAppliedAt = {
    ...cursors,
    [code]: updatedAt,
  };
  account.updatedAt = Math.max(Number(account.updatedAt) || 0, updatedAt);
  return account;
}

async function writeAdviceRuntimeObject(
  path,
  value,
  storage,
  { verify = true } = {},
) {
  const body = JSON.stringify(value);
  await storage.put(path, body, {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  });
  if (verify) {
    const verified = await storage.readJson(path);
    if (
      !verified
      || Number(verified.updatedAt) !== Number(value.updatedAt)
    ) {
      throw new Error('OSS 建议增量写入校验失败');
    }
  }
  return value;
}

export async function writeAdviceRuntimeState(
  nick,
  runtime,
  storage = defaultStorage,
) {
  if (!nick || !runtime || typeof runtime !== 'object') {
    throw new Error('建议运行态无效');
  }
  return writeAdviceRuntimeObject(
    adviceRuntimeStatePathOf(nick),
    runtime,
    storage,
    { verify: false },
  );
}

export async function writeAdviceRuntimeUpdate(
  nick,
  update,
  storage = defaultStorage,
) {
  const path = adviceRuntimeUpdatePathOf(nick, update?.code);
  if (!nick || !update?.code || path.endsWith('/.json')) {
    throw new Error('单股建议增量无效');
  }
  return writeAdviceRuntimeObject(path, update, storage);
}

async function applyAdviceRuntime(
  account,
  nick,
  storage,
  { runtimeSince = 0, includeAdviceUpdates = true } = {},
) {
  if (!account || !storage?.list || !storage?.readJson) return account;
  const state = await storage.readJson(adviceRuntimeStatePathOf(nick))
    .catch(() => null);
  mergeAdviceRuntimeState(account, state);
  if (!includeAdviceUpdates) return account;
  const cursor = Math.max(0, Number(runtimeSince) || 0);
  const { blobs } = await storage.list({
    prefix: adviceRuntimePrefixOf(nick),
    limit: 500,
  }).catch(() => ({ blobs: [] }));
  const candidates = (blobs || []).filter((blob) => {
    if (!cursor) return true;
    const uploadedAt = new Date(blob?.uploadedAt || 0).getTime();
    // 运行态进度可能在单股结果之后写入并推进客户端游标。
    // 保留五分钟重叠窗口，避免状态写入盖过刚完成的建议增量。
    return !Number.isFinite(uploadedAt)
      || uploadedAt > cursor - 5 * 60 * 1000;
  });
  const updates = await Promise.all(
    candidates.map((blob) =>
      storage.readJson(blob?.pathname || blob).catch(() => null)
    ),
  );
  for (const update of updates
    .filter(Boolean)
    .sort((left, right) =>
      Number(left.updatedAt || 0) - Number(right.updatedAt || 0)
    )) {
    mergeAdviceRuntimeUpdate(account, update);
  }
  return account;
}

// 账号响应绝不缓存(登录/保存态)，走统一 sendJson(cache:0) 契约
function ok(res, obj) {
  sendJson(res, obj, { cache: 0 });
}

export function accountCredentialMatches(account, { pw = '', token = '' } = {}) {
  return (
    (!!token && verifyAccountSessionToken(account, token))
    || (!!pw && account.pwHash === sha(pw))
  );
}

function accountSessionToken(account) {
  return createAccountSessionToken(account);
}

// 读取某账号：优先读取权威当前快照；没有则从历史/旧格式中取最新版本。
// OSS 故障必须向上抛出，不能伪装成“账号不存在”。
export async function readAccount(
  nick,
  storage = defaultStorage,
  {
    includeAdviceRuntime = true,
    includeAdviceUpdates = true,
    runtimeSince = 0,
  } = {},
) {
  const currentRecord = storage.readJsonWithMeta
    ? await storage.readJsonWithMeta(currentPathOf(nick))
    : {
        value: await storage.readJson(currentPathOf(nick)),
        etag: null,
      };
  let account = currentRecord?.value || null;
  if (account && currentRecord?.etag) {
    account._storageEtag = currentRecord.etag;
  }

  if (!account) {
    const { blobs } = await storage.list({ prefix: prefixOf(nick), limit: 5000 });
    const latest = (blobs || [])
      .filter((item) => ![currentPathOf(nick), deactivationPathOf(nick)].includes(item.pathname))
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())[0];
    if (latest) account = await storage.readJson(latest);
  }

  if (!account) account = await storage.readJson(legacyPathOf(nick));
  if (!account) return null;

  account = await applyDeactivationMarker(account, nick, storage);
  return includeAdviceRuntime
    ? applyAdviceRuntime(account, nick, storage, {
        runtimeSince,
        includeAdviceUpdates,
      })
    : account;
}

async function applyDeactivationMarker(account, nick, storage) {
  const marker = await storage.readJson(deactivationPathOf(nick));
  return marker
    ? { ...account, status: 'deactivated', deactivatedAt: marker.deactivatedAt || account.deactivatedAt }
    : account;
}

// 列出【全部账号】的最新快照(供云端定时任务遍历所有用户生成 AI 建议)。
// accounts/ 下形如 accounts/<hash>/<ts>-<rand>.json(新)或 accounts/<hash>.json(旧单文件)。
// 按 hash 目录分组。current.json 永远优先；只有 current 缺失时才回退最新历史或旧文件。
export async function listAllAccounts(storage = defaultStorage) {
  const byNick = new Map();
  const { blobs } = await storage.list({ prefix: PREFIX, limit: 10000 });
  const groups = new Map(); // key: hash 目录(或旧单文件 key) → 该组最新 blob
  for (const b of (blobs || [])) {
    if (b.pathname.endsWith('/deactivated.json')) continue;
    const rest = b.pathname.slice(PREFIX.length);      // <hash>/<ts>.json 或 <hash>.json
    if (rest.includes('/runtime/')) continue;
    const key = rest.includes('/') ? rest.split('/')[0] : rest; // 目录 hash 或旧文件名
    const cur = groups.get(key);
    const isCurrent = rest.endsWith('/current.json');
    const currentSelected = cur?.pathname?.endsWith('/current.json');
    if (
      !cur
      || (isCurrent && !currentSelected)
      || (
        isCurrent === currentSelected
        && new Date(b.uploadedAt).getTime()
          > new Date(cur.uploadedAt).getTime()
      )
    ) {
      groups.set(key, b);
    }
  }
  for (const b of groups.values()) {
    const raw = await storage.readJson(b);
    // 分组时已取得该账号最新对象，避免再把 4 MiB current.json 重读一遍。
    const j = raw && raw.nick
      ? await applyDeactivationMarker(raw, raw.nick, storage)
      : null;
    if (!j || !j.nick || !isAccountActive(j)) continue;
    if (
      b.pathname === currentPathOf(j.nick)
      && b.etag
    ) j._storageEtag = b.etag;
    const current = byNick.get(j.nick);
    if (!current || (j.updatedAt || 0) >= (current.updatedAt || 0)) byNick.set(j.nick, j);
  }
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

export async function writeAccount(
  acc,
  storage = defaultStorage,
  {
    history = true,
    verify = true,
    createOnly = false,
  } = {},
) {
  const {
    _storageEtag: expectedEtag,
    ...persistedAccount
  } = acc || {};
  const saved = { ...persistedAccount, updatedAt: Date.now() };
  const body = JSON.stringify(saved);
  const snapshot = history
    ? await storage.put(`${historyPrefixOf(saved.nick)}${saved.updatedAt}.json`, body, {
        access: 'public', contentType: 'application/json',
        addRandomSuffix: true, cacheControlMaxAge: 0,
      })
    : null;
  let currentWrite;
  try {
    currentWrite = await storage.put(currentPathOf(saved.nick), body, {
      access: 'public',
      contentType: 'application/json',
      cacheControlMaxAge: 0,
      ...(expectedEtag ? { ifMatch: expectedEtag } : {}),
      ...(createOnly ? { forbidOverwrite: true } : {}),
    });
  } catch (error) {
    if (
      error?.status === 412
      || error?.code === 'PreconditionFailed'
    ) {
      const conflict = new Error('OSS 权威快照已被其他实例更新');
      conflict.code = 'OSS_WRITE_CONFLICT';
      conflict.status = 409;
      throw conflict;
    }
    throw error;
  }

  if (verify) {
    const verified = await storage.readJson(currentPathOf(saved.nick));
    if (!verified || verified.updatedAt !== saved.updatedAt || verified.nick !== saved.nick) {
      throw new Error('OSS 账号快照写入校验失败');
    }
  }

  // 保留最近 20 份细粒度版本，并为最近 90 天每天保留一个恢复点。
  if (history) {
    try {
      await cleanupAccountHistory(saved.nick, storage, saved.updatedAt);
    } catch { /* ignore */ }
  }
  if (acc && typeof acc === 'object') {
    acc._storageEtag = currentWrite?.etag || expectedEtag || null;
  }
  return {
    ...saved,
    _storageEtag: currentWrite?.etag || expectedEtag || null,
    storage: 'oss',
    snapshotKey: snapshot?.pathname || null,
  };
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
    const token = body.token != null ? String(body.token) : '';

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
      }, undefined, { createOnly: true });
      return ok(res, {
        ok: true, nick: acc.nick, data: acc.data,
        updatedAt: acc.updatedAt, revision: acc.clientRevision, storage: acc.storage,
        token: accountSessionToken(acc),
      });
    }

    if (action === 'login' || action === 'get' || action === 'sync') {
      const syncSince = action === 'sync'
        ? Math.max(0, Number(body.since) || 0)
        : 0;
      const acc = await readAccount(
        nick,
        defaultStorage,
        { runtimeSince: syncSince },
      );
      if (!acc) return ok(res, { ok: false, error: '账号不存在，请先注册' });
      const authorized = action === 'login'
        ? !!pw && acc.pwHash === sha(pw)
        : accountCredentialMatches(acc, { pw, token });
      if (!authorized) {
        return ok(res, {
          ok: false,
          error: action === 'login' ? '密码错误' : '登录已过期，请重新登录',
        });
      }
      if (!isAccountActive(acc)) return ok(res, { ok: false, error: '账号已注销，数据仍保存在 OSS' });
      if (action === 'sync') {
        const since = syncSince;
        const changed = Number(acc.updatedAt) > since;
        return ok(res, {
          ok: true,
          nick: acc.nick,
          data: changed ? accountSyncDelta(acc.data, since) : {},
          changed,
          updatedAt: acc.updatedAt,
          revision: Number(acc.clientRevision) || 0,
          tradeFingerprint: accountTradeStateFingerprint(acc.data),
          storage: 'oss',
        });
      }
      return ok(res, {
        ok: true, nick: acc.nick,
        data: acc.data || { plan: [], holding: [], closed: [] },
        updatedAt: acc.updatedAt, revision: Number(acc.clientRevision) || 0, storage: 'oss',
        token: accountSessionToken(acc),
      });
    }

    if (action === 'save') {
      const acc = await readAccount(nick);
      if (!acc) return ok(res, { ok: false, error: '账号不存在' });
      if (!accountCredentialMatches(acc, { pw, token })) {
        return ok(res, { ok: false, error: '登录已过期，请重新登录' });
      }
      if (!isAccountActive(acc)) return ok(res, { ok: false, error: '账号已注销，不能继续保存' });
      const incoming = (body.data && typeof body.data === 'object') ? body.data : null;
      if (incoming) {
        const applied = applyClientAccountSave(
          acc,
          incoming,
          Number(body.baseRevision),
          { forceTradeState: body.forceTradeState === true },
        );
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
      if (!accountCredentialMatches(acc, { pw, token })) {
        return ok(res, { ok: false, error: '登录已过期，请重新登录' });
      }
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
      if (!accountCredentialMatches(acc, { pw, token })) {
        return ok(res, { ok: false, error: '登录已过期，请重新登录' });
      }
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
    if (e?.code === 'OSS_WRITE_CONFLICT') {
      return ok(res, {
        ok: false,
        code: 'ACCOUNT_VERSION_CONFLICT',
        error: '云端账号数据已更新，请刷新页面后重试',
        retryable: true,
      });
    }
    return ok(res, { ok: false, error: '阿里云 OSS 存储访问失败，请稍后重试' });
  }
}
