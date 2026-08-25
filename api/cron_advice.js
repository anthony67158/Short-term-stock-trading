// ============ 云端「AI 操作建议」任务队列 + 并发池 + 单 Worker 锁(脱离浏览器,跨端共享)============
// 演进(相对旧版串行 cron_advice):
//   旧版:一次 FC 请求内【串行】生成指定 codes,进度写 batchProgress。任务不持久 → FC 崩/超时即丢,
//         无状态/无重试/无取消,点两次起两份。
//   新版:任务按角色沉到账号 data.jobs/reviewJobs(OSS 持久,见 _jobs.js),服务端为唯一权威源:
//         · advisor/review 各自按端点数限流；深度任务进入委员会阶段后释放 advisor 槽；
//           同一协调器串行持久化，但两个角色的模型调用可并行。
//         · 断点续跑:running 但租约过期(FC 崩)= 孤儿 → 下次 drain 自动回收重跑。
//         · 失败重试:失败回 queued 直到 maxAttempts。
//         · 取消:queued 立即 canceled;running 协作式(跑完丢弃结果)。
//         · 防重:同 role + code 已有活跃任务 → 复用不新建；不同角色互不覆盖。
//   触发(均无需浏览器常驻):
//     A) 前端 fire-and-forget POST(keepalive):{ op:'enqueue', codes, nick, pw }；
//        浏览器不等结果，但 FC 请求会 await drain，保证刷新/切后台不终止 Worker。
//     B) 单只/全部取消:{ op:'cancel'|'cancelAll', codes, nick, pw }。
//     C) 状态查询:{ op:'status', nick, pw }(前端也可直接靠 authStore.pull 读 batchProgress)。
//     D) 定时兜底(CRON_KEY):遍历所有账号 → 回收孤儿 + 排入过期建议 + drain,实现"每天/定时续跑"。
//
// 关键约束(承接旧版):
//   · 线上 /predict 的 36 维 OHLCV 打分【零改动】——本 handler 只是"调用方"。
//   · 只写任务运行态/advice/adviceLog/batchProgress/qScore,绝不覆盖 plan/holding/closed/account。
//   · 运行态写账号 runtime/state 小对象，单股完成按角色写独立 runtime/advice 对象；
//     整批收尾才压实完整账号快照，且始终先重读最新账本做保护式叠加。

import { applyCors, preflight } from './_lib.js';
import {
  accountCredentialMatches,
  isAccountActive,
  writeAdviceRuntimeState,
  writeAdviceRuntimeUpdate,
  writeAccount,
  readAccount,
  listAllAccounts,
} from './account.js';
import {
  quantResultFromAdviceMeta,
} from '../shared/adviceQuantResult.js';
import { buildHoldPayload, buildWatchPayload, computePortfolio, t1StatusOf } from './_portfolio.js';
import {
  CONCURRENCY, jobsOf, enqueueJob, leaseJob, completeJob, failJob, cancelJob, cancelAll,
  reapOrphans, gcJobs, runningCount, hasPendingWork, needsWorkerDispatch, isActive, jobsToProgress,
  isAdviceBatchCanceled, markAdviceBatchCanceled,
  mergeAdviceBatchCancellations,
  acquireWorkerLock, renewWorkerLock, renewLease, releaseWorkerLock, workerHeldByOther, updateJobProgress,
  adviceJobRole, allAdviceJobs, advisorAdmission, findAdviceJob,
  resourcePatchForJobProgress, reviewJobsOf, selectStartableJobs,
} from './_jobs.js';
import { ensureConfig, currentConfig, getModel } from './_llm_config.js';
import { endpointCountForRole } from './_llm_pool.js';
import { projectAdviceAlerts } from '../shared/adviceAlerts.js';
import { sanitizedAdvicePriceContract } from '../shared/advicePriceContract.js';
import { accountTradeStateFingerprint } from '../shared/accountSync.js';
import { createRecommendation } from '../shared/decisionLedger.js';
import { ensureAdviceReasoning } from '../shared/adviceReasoning.js';
import {
  autoConfigFromSettings,
  mergeAutoRefreshSettings,
  selectAutoRefreshCodes,
} from '../shared/adviceAutoRefreshPolicy.js';
import {
  adviceReviewDue,
  isAdviceReviewEnabled,
} from '../shared/adviceReviewPolicy.js';
import {
  adviceEvidenceDigest,
  adviceTrustBands,
  prioritizeAdviceReviewCodes,
} from '../shared/adviceIntelligence.js';
import {
  acceptsGenerationResult,
  adviceCompleteness,
  adviceConcurrency,
  generationOptions,
  validateBatchMode,
} from '../shared/adviceBatchPolicy.js';
import { summarizeAdviceOutcomes } from '../shared/adviceOutcome.js';
import {
  buildAdviceCacheEntry,
  compactAdvicePlan,
} from '../shared/adviceContinuity.js';
import {
  evidencePersistenceFields,
  evidenceSnapshotsFromData,
  mergeEvidenceSnapshotIndexes,
} from '../shared/evidenceSnapshot.js';
import { attachAdviceDailyReport } from '../shared/adviceDailyReportPolicy.js';
import { adviceEntryMatchesMode } from '../shared/adviceModeContext.js';
import aiHandler from './ai.js';
import quoteHandler from './quote.js';
import { TRUSTED_QUANT_VERSION } from './_quant_access.js';
import { TRUSTED_ACCOUNT_REQUEST } from './_account_auth.js';
import { dispatchAdviceWorker } from './_advice_dispatch.js';
import { buildRealOutcomeLearning } from '../shared/realOutcomeLearning.js';
import {
  buildStrategyPromotionGate,
  CURRENT_STRATEGY_EVALUATION,
} from '../shared/strategyPromotionGate.js';
import { getStrategySpecV2 } from '../shared/strategyCatalogV2.js';
import {
  addCouncilShadowRecord,
  councilRecordsFromData,
} from '../shared/advisorCouncilStore.js';
import {
  isContinuousTrading,
  nextTradingDayLabel,
} from '../shared/tradingCalendar.js';
import { runAdvisorCouncilShadow } from './_advisor_council.js';
import {
  shouldRunAdvisorCouncil,
} from '../shared/adviceGenerationPolicy.js';

export const PROGRESS_SAVE_INTERVAL_MS = 5000;
export const CANCEL_POLL_INTERVAL_MS = 2000;
export const WORKER_HEARTBEAT_INTERVAL_MS = 30000;

export function createAdviceSSEParser(onEvent) {
  let buffer = '';
  const consume = (flush = false) => {
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      try { onEvent(event, JSON.parse(dataLines.join('\n'))); } catch { /* 忽略心跳或不完整事件 */ }
    }
    if (flush && buffer.trim()) {
      buffer += '\n\n';
      consume(false);
    }
  };
  return {
    push(chunk) { buffer += String(chunk || ''); consume(false); },
    end() { consume(true); },
  };
}

export function progressPatchForEvent(event, data) {
  if (!data || typeof data !== 'object') return null;
  if (event === 'phase' && data.text) {
    const patch = { phase: String(data.text) };
    if (data.key) patch.stage = String(data.key).slice(0, 40);
    return patch;
  }
  if (event === 'source' && data.label) {
    return { source: { label: String(data.label), ok: !!data.ok } };
  }
  if (event === 'quant') return { quant: data };
  if (event === 'reasoning' && data.text) return { reasoningDelta: String(data.text) };
  if (event === 'model') {
    return {
      model: String(data.model || ''),
      endpoint: String(data.endpoint || ''),
    };
  }
  return null;
}

// FC HTTP 网关会终止长时间没有 SSE 帧的请求。批量触发方不消费响应正文，
// 结果统一从 OSS 状态轮询，因此这里用标准 SSE 注释心跳维持 Worker 执行上下文。
export function startJsonHeartbeat(res, intervalMs = 10000) {
  try {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Disposition', 'inline');
  } catch { /* 测试桩或响应已关闭 */ }
  let active = true;
  const write = () => {
    if (!active || res.writableEnded) return;
    try { res.write(`: hb ${Date.now()}\n\n`); } catch { /* 连接已关闭 */ }
  };
  write();
  const timer = setInterval(write, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return () => {
    active = false;
    clearInterval(timer);
  };
}

function endWorkerResponse(res, payload) {
  return res.end(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ---- 并发上限:严格等于用户为「操盘军师(advisor)」角色配置的端点数(核心规则1)----
// AI 操作建议实际调用 advisor 角色 → 承接该角色的端点数即为可并行生成的最大只数。
// 未配任何附加端点 → 退化为 1(仅主端点),endpointCountForRole 已保证最小 1。
// 读取的是全局 LLM 配置(config/llm.json,进程级缓存),故所有账号/设备共享同一上限。
function advisorConcurrency() {
  try { return endpointCountForRole(currentConfig(), 'advisor'); } catch { return CONCURRENCY; }
}

function reviewConcurrency() {
  try { return endpointCountForRole(currentConfig(), 'review'); } catch { return 0; }
}

function hasDeepAdviceWork(data) {
  return Object.values(data?.jobs || {}).some((job) =>
    isActive(job) && job.deepMode === true
  );
}

function hasDeepBatchWork(data) {
  return Object.values(data?.jobs || {}).some((job) =>
    isActive(job)
    && job.deepMode === true
    && job.batchRequest === true
  );
}

function effectiveAdviceConcurrency(data, deepMode, batchRequest) {
  const hasDeepBatch = hasDeepBatchWork(data);
  const deep = deepMode == null ? hasDeepAdviceWork(data) : deepMode === true;
  const limitedBatch = hasDeepBatch || batchRequest === true;
  const concurrency = adviceConcurrency(advisorConcurrency(), {
    deepMode: deep,
    batchRequest: limitedBatch,
  });
  return concurrency;
}

function adviceRoleCapacities(data, deepMode, batchRequest) {
  return {
    advisor: effectiveAdviceConcurrency(data, deepMode, batchRequest),
    review: reviewConcurrency(),
  };
}

function hasRunnableAdviceWork(data, now = Date.now()) {
  return selectStartableJobs(
    data,
    adviceRoleCapacities(data),
    new Set(),
    now,
  ).length > 0;
}

function needsRoleWorkerDispatch(data, now = Date.now()) {
  if (!hasRunnableAdviceWork(data, now)) return false;
  return needsWorkerDispatch(data, now);
}

const MAX_AUTO_JOBS_PER_TICK = 6;

export function internalRequestHeaders(env = process.env) {
  const rawPort = String(env.FC_SERVER_PORT || env.PORT || '3000').trim();
  const portNumber = Number(rawPort);
  const port = /^\d{1,5}$/.test(rawPort)
    && Number.isInteger(portNumber)
    && portNumber > 0
    && portNumber <= 65535
    ? rawPort
    : '3000';
  const host = `127.0.0.1:${port}`;
  return {
    host,
    'x-forwarded-host': host,
    'x-forwarded-proto': 'http',
  };
}

export function createRecoverableSerialRunner(task) {
  let tail = Promise.resolve();
  return {
    run() {
      const current = tail.then(task);
      tail = current.catch(() => {});
      return current;
    },
    settle() {
      return tail;
    },
  };
}

export function createAdviceProgressSaveScheduler(
  save,
  {
    now = () => Date.now(),
    intervalMs = PROGRESS_SAVE_INTERVAL_MS,
  } = {},
) {
  let lastSavedAt = 0;
  let running = false;
  let forceAfterCurrent = false;
  let tail = Promise.resolve();

  const drain = async () => {
    running = true;
    let firstError = null;
    try {
      do {
        forceAfterCurrent = false;
        lastSavedAt = now();
        try {
          await save();
        } catch (error) {
          firstError ||= error;
        }
      } while (forceAfterCurrent);
      if (firstError) throw firstError;
    } finally {
      running = false;
    }
  };

  return {
    schedule(force = false) {
      const currentTime = now();
      if (running) {
        if (force) forceAfterCurrent = true;
        return tail;
      }
      if (!force && currentTime - lastSavedAt < intervalMs) return tail;
      const current = drain();
      tail = current.catch(() => {});
      return current;
    },
    settle() {
      return tail;
    },
  };
}

function codeMatches(item, code) {
  const target = String(code || '');
  return [
    item?.code,
    item?.candCode,
    item?.actCode,
  ].some((value) => String(value || '') === target);
}

function quantPatchFrom(items, code) {
  const item = (items || []).find((entry) =>
    String(entry?.code || '') === String(code || '')
  );
  if (!item || item.qScore == null) return null;
  return {
    code: String(code),
    qScore: item.qScore,
    qBias: item.qBias,
    qAt: item.qAt,
  };
}

export function adviceRuntimeUpdateFromData(
  data,
  code,
  updatedAt = Date.now(),
  concurrency = effectiveAdviceConcurrency(data),
  role = 'advisor',
  jobId = '',
) {
  const key = String(code || '');
  const advice = data?.advice?.[key] || null;
  const job = findAdviceJob(data, key, { role, jobId });
  const resolvedRole = job ? adviceJobRole(job) : role;
  return {
    schemaVersion: 'advice-runtime-update.v2',
    code: key,
    role: resolvedRole,
    jobKey: `${resolvedRole}:${key}`,
    updatedAt: Number(updatedAt) || Date.now(),
    advice,
    job: resolvedRole === 'advisor' ? job : null,
    reviewJob: resolvedRole === 'review' ? job : null,
    batchProgress: jobsToProgress(
      data || {},
      Number(updatedAt) || Date.now(),
      concurrency,
    ),
    adviceLog: (data?.adviceLog || [])
      .filter((item) => codeMatches(item, key))
      .slice(0, 5),
    decisionLog: (data?.decisionLog || [])
      .filter((item) => codeMatches(item, key))
      .slice(0, 5),
    adviceReviewLog: (data?.adviceReviewLog || [])
      .filter((item) => codeMatches(item, key))
      .slice(0, 5),
    alerts: (data?.alerts || [])
      .filter((item) => codeMatches(item, key)),
    councilShadow: councilRecordsFromData(data)
      .filter((item) => codeMatches(item, key))
      .slice(0, 3),
    evidenceSnapshots: evidenceSnapshotsFromData({
      advice: advice ? { [key]: advice } : {},
    }),
    holdingPatch: quantPatchFrom(data?.holding, key),
    planPatch: quantPatchFrom(data?.plan, key),
  };
}

function adviceRuntimeStateFromData(data, updatedAt = Date.now()) {
  const runtimeSettings = {};
  for (const key of [
    'advAuto.holdLastAt',
    'advAuto.holdLastTryAt',
    'advAuto.watchLastAt',
    'advAuto.watchLastTryAt',
  ]) {
    if (data?.settings?.[key] != null) {
      runtimeSettings[key] = data.settings[key];
    }
  }
  return {
    schemaVersion: 'advice-runtime-state.v2',
    updatedAt: Number(updatedAt) || Date.now(),
    jobs: data?.jobs || {},
    reviewJobs: data?.reviewJobs || {},
    jobWorker: data?.jobWorker || null,
    activeAdviceBatchId: data?.activeAdviceBatchId || '',
    adviceBatchCancellations: data?.adviceBatchCancellations || {},
    adviceAutoPauseUntil: Number(data?.adviceAutoPauseUntil) || 0,
    batchProgress: data?.batchProgress || null,
    adviceDailyReport: data?.adviceDailyReport || null,
    settings: runtimeSettings,
  };
}

async function retryRuntimeWrite(task, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * 150)
        );
      }
    }
  }
  throw lastError || new Error('OSS 建议增量保存失败');
}

async function persistAdviceCompletion(
  nick,
  data,
  code,
  concurrency,
  role,
  jobId,
) {
  const update = adviceRuntimeUpdateFromData(
    data,
    code,
    Date.now(),
    concurrency,
    role,
    jobId,
  );
  await retryRuntimeWrite(() =>
    writeAdviceRuntimeUpdate(nick, update)
  );
  data.runtimeAdviceAppliedAt = {
    ...(data.runtimeAdviceAppliedAt || {}),
    [update.jobKey || code]: update.updatedAt,
  };
  return update;
}

// ---- 进程内调用另一个 handler:造最小 req/res,把 JSON 结果收集回来 ----
export function invoke(handler, {
  method = 'GET',
  query = {},
  body = null,
  signal,
  trustedQuantVersion,
  trustedAccount = false,
} = {}) {
  return new Promise((resolve) => {
    let done = false;
    const chunks = [];
    let timer = null;
    let externalAbort = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && externalAbort) {
        signal.removeEventListener('abort', externalAbort);
        externalAbort = null;
      }
    };
    const finishWith = (payload) => {
      if (done) return;
      done = true;
      cleanup();
      let out = payload;
      if (typeof out === 'string') { try { out = JSON.parse(out); } catch { /* 保留字符串 */ } }
      if (out == null && chunks.length) { try { out = JSON.parse(chunks.join('')); } catch { out = chunks.join(''); } }
      resolve(out);
    };
    const res = {
      statusCode: 200, headersSent: false, _headers: {},
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k) { return this._headers[String(k).toLowerCase()]; },
      status(c) { this.statusCode = c; return this; },
      write(s) { chunks.push(typeof s === 'string' ? s : String(s)); return true; },
      send(payload) { this.headersSent = true; finishWith(payload); return this; },
      json(obj) { this.headersSent = true; finishWith(obj); return this; },
      end(payload) { this.headersSent = true; finishWith(payload != null ? payload : null); return this; },
    };
    const req = {
      method,
      query,
      body: body || {},
      headers: internalRequestHeaders(),
      signal,
    };
    if (trustedQuantVersion) {
      req[TRUSTED_QUANT_VERSION] = trustedQuantVersion;
    }
    if (trustedAccount) req[TRUSTED_ACCOUNT_REQUEST] = true;
    timer = setTimeout(
      () => finishWith(null),
      595000,
    );
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (signal) {
      if (signal.aborted) return finishWith(null);
      externalAbort = () => finishWith(null);
      signal.addEventListener('abort', externalAbort, { once: true });
    }
    try {
      const r = handler(req, res);
      if (r && typeof r.then === 'function') r.catch(() => finishWith(null));
    } catch { finishWith(null); }
  });
}

export function invokeSSE(handler, {
  method = 'POST',
  query = {},
  body = null,
  onEvent,
  timeoutMs = 135000,
  signal,
  trustedQuantVersion,
  trustedAccount = false,
} = {}) {
  return new Promise((resolve) => {
    let done = false;
    let result = null;
    const requestController = new AbortController();
    let timer = null;
    let externalAbort = null;
    const parser = createAdviceSSEParser((event, data) => {
      if (event === 'result') result = data;
      if (typeof onEvent === 'function') onEvent(event, data);
    });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal && externalAbort) {
        signal.removeEventListener('abort', externalAbort);
      }
      parser.end();
      resolve(result);
    };
    const res = {
      statusCode: 200, headersSent: false, _headers: {},
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k) { return this._headers[String(k).toLowerCase()]; },
      status(c) { this.statusCode = c; return this; },
      write(chunk) { this.headersSent = true; parser.push(chunk); return true; },
      send(payload) {
        this.headersSent = true;
        if (payload != null) {
          try { result = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch { /* ignore */ }
        }
        finish();
        return this;
      },
      json(obj) { this.headersSent = true; result = obj; finish(); return this; },
      end(payload) {
        this.headersSent = true;
        if (payload != null) parser.push(payload);
        finish();
        return this;
      },
    };
    const req = {
      method,
      query,
      body: body || {},
      headers: internalRequestHeaders(),
      signal: requestController.signal,
    };
    if (trustedQuantVersion) {
      req[TRUSTED_QUANT_VERSION] = trustedQuantVersion;
    }
    if (trustedAccount) req[TRUSTED_ACCOUNT_REQUEST] = true;
    timer = setTimeout(() => {
      requestController.abort();
      finish();
    }, timeoutMs);
    if (signal) {
      externalAbort = () => {
        requestController.abort();
        finish();
      };
      if (signal.aborted) return externalAbort();
      signal.addEventListener('abort', externalAbort, { once: true });
    }
    try {
      const promise = handler(req, res);
      if (promise && typeof promise.then === 'function') promise.catch(finish);
    } catch { finish(); }
  });
}

// 行情缓存(进程级,30s):并发多只时避免每只都全量拉一遍行情。
let _quoteMemo = { at: 0, key: '', map: {} };
async function fetchQuoteMap(codes) {
  const key = [...codes].sort().join(',');
  if (key && _quoteMemo.key === key && (Date.now() - _quoteMemo.at) < 30000) return _quoteMemo.map;
  const map = {};
  if (codes.length) {
    try {
      const j = await invoke(quoteHandler, { method: 'GET', query: { codes: codes.join(',') } });
      for (const it of (j && j.list) || []) if (it && it.code) map[it.code] = it;
    } catch { /* 空 map 也能跑 */ }
  }
  _quoteMemo = { at: Date.now(), key, map };
  return map;
}

// 军师历史战绩(当前回测口径样本<5 返回 null)
function advisorTrackFrom(data, mode) {
  try {
    const stats = summarizeAdviceOutcomes(data.adviceLog);
    if (stats.total < 5) return null;
    const group = (stats.groups || []).find((item) => item.mode === mode);
    const actionScores = (stats.actions || [])
      .filter((item) => item.total >= 5)
      .map((item) => ({
        kind: item.kind,
        label: item.label,
        winRate: item.winRate,
        total: item.total,
        avgPct: item.avgPct,
      }));
    return {
      overallWinRate: stats.winRate,
      overallAvgPct: stats.avgPct,
      overallTotal: stats.total,
      modeWinRate: group ? group.winRate : null,
      modeAvgPct: group ? group.avgPct : null,
      modeTotal: group ? group.total : 0,
      actionScores,
      trustBands: adviceTrustBands(stats),
    };
  } catch { return null; }
}
function applyQuantScore(data, code, qs) {
  const stamp = (arr) => { for (const it of (arr || [])) if (it && it.code === code) { it.qScore = qs.qScore; it.qBias = qs.qBias; it.qAt = Date.now(); } };
  stamp(data.holding); stamp(data.plan);
}

export function adviceFailureReason(response, mode = '') {
  if (!response) return '军师未返回结果';
  if (!response.ok) {
    return String(response.error || '军师未返回可用建议').slice(0, 160);
  }
  if (response.unchanged) return '';
  if (response.truncated) return '军师建议输出被截断';
  if (!response.result) return '军师未返回结构化建议';
  const quality = adviceCompleteness(response.result, mode);
  if (!quality.complete) {
    return `军师建议缺少：${quality.missing.join('、')}`;
  }
  return '';
}

export function quantResultFromAdviceResponse(response, priceHint = null) {
  return quantResultFromAdviceMeta(response?.meta, priceHint);
}

export function buildAdviceReviewRecord({
  code,
  mode,
  origin,
  previousEntry,
  cacheItem,
  llmRan,
  durationMs,
} = {}) {
  if (!previousEntry && !['auto', 'judge'].includes(origin)) return null;
  const cycle = cacheItem?.advice?.reviewCycle || cacheItem?.reviewCycle || {};
  const previousAction = previousEntry?.advice?.action
    || previousEntry?.advice?.stance
    || '';
  const nextAction = cacheItem?.advice?.action
    || cacheItem?.advice?.stance
    || previousAction;
  const at = Number(cacheItem?.at) || Date.now();
  return {
    schemaVersion: 'advice-review.v1',
    id: `review_${at}_${String(code || '')}`,
    code: String(code || ''),
    mode: String(mode || ''),
    origin: String(origin || ''),
    at,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    llmRan: llmRan === true,
    disposition: String(cycle.status || ''),
    reason: String(cycle.reason || '').slice(0, 160),
    changeType: String(cycle.changeType || ''),
    previousAction: String(previousAction),
    nextAction: String(nextAction),
    configuredIntervalMin: Number(cycle.configuredIntervalMin) || null,
    intervalMin: Number(cycle.intervalMin) || null,
    riskLevel: String(cycle.riskLevel || 'normal'),
    riskReasons: Array.isArray(cycle.riskReasons)
      ? cycle.riskReasons.map(String).slice(0, 4)
      : [],
    evidenceSnapshotId: String(
      cacheItem?.meta?.evidenceSnapshot?.snapshotId || '',
    ),
  };
}

// 生成单只:军师内部完成统一证据采集与量化预测，任务层直接复用同一份结果。
async function genOne({
  code,
  name,
  mode,
  payload,
  priceHint,
  onProgress,
  signal,
  deepMode = false,
  previousEntry = null,
  reviewIntervalMin = null,
  reviewTrigger = '',
  strategyGate = null,
  runCouncilShadow = false,
}) {
  const startedAt = Date.now();
  const generation = generationOptions(deepMode);
  let streamedReasoning = '';
  let adviceFailure = '';
  const adviceP = invokeSSE(aiHandler, {
    method: 'POST',
    body: {
      mode,
      payload,
      stream: true,
      fastMode: generation.fastMode,
      forceReasoning: generation.forceReasoning,
      runtimeBudgetMs: generation.runtimeBudgetMs,
    },
    timeoutMs: generation.timeoutMs,
    signal,
    trustedQuantVersion: payload.quantModelVersion,
    trustedAccount: true,
    onEvent(event, data) {
      if (event === 'reasoning' && data?.text) streamedReasoning += String(data.text);
      const patch = progressPatchForEvent(event, data);
      if (patch && typeof onProgress === 'function') onProgress(patch);
    },
  })
    .then((r) => {
      adviceFailure = adviceFailureReason(r, mode);
      return adviceFailure
        ? null
        : {
            advice: r.result,
            meta: r.meta,
            news: r.news,
            truncated: r.truncated,
            unchanged: r.unchanged === true,
            reviewDisposition: r.reviewDisposition || '',
            reviewReason: r.reviewReason || '',
          };
    })
    .catch((error) => {
      adviceFailure = error?.name === 'AbortError'
        ? '军师生成已中断'
        : '军师生成请求异常';
      return null;
    });
  const adviceResp = await adviceP;
  const result = quantResultFromAdviceResponse(adviceResp, priceHint);

  const advice = adviceResp && adviceResp.advice
    ? ensureAdviceReasoning(adviceResp.advice, streamedReasoning)
    : null;
  const meta = adviceResp && adviceResp.meta;
  const news = adviceResp && adviceResp.news;
  const truncated = !!(adviceResp && (adviceResp.truncated || (advice && advice.truncated)));
  const unchanged = adviceResp?.unchanged === true;
  const reviewDisposition = adviceResp?.reviewDisposition
    || (!advice && previousEntry && adviceFailure ? 'insufficient' : '');
  const reviewReason = adviceResp?.reviewReason || adviceFailure || '';
  if (!acceptsGenerationResult({
    quant: result,
    advice,
    truncated,
    unchanged,
  }, mode)) {
    throw new Error(
      adviceFailure
      || '军师建议未完整返回',
    );
  }

  const at = Date.now();
  const cacheItem = buildAdviceCacheEntry(
    previousEntry,
    {
      mode,
      result,
      advice,
      meta,
      news,
      truncated,
      reviewIntervalMin,
      reviewTrigger: reviewTrigger || (previousEntry ? 'scheduled' : 'initial'),
      reviewDisposition,
      reviewReason,
    },
    at,
  );
  let councilShadow = null;
  if (advice && runCouncilShadow) {
    if (typeof onProgress === 'function') {
      onProgress({
        stage: 'council',
        phase: '委员会正在复核候选方案，尚未发布最终结论',
        model: getModel('review'),
        endpoint: 'review 独立端点池',
      });
    }
    try {
      councilShadow = await runAdvisorCouncilShadow({
        code,
        name,
        mode,
        advice,
        payload,
        strategyGate,
        evidenceSnapshotId: meta?.evidenceSnapshot?.snapshotId || null,
        signal,
        deepMode,
      });
      cacheItem.councilShadow = councilShadow;
    } catch {
      councilShadow = null;
    }
    if (typeof onProgress === 'function') {
      onProgress({
        stage: 'finalize',
        phase: '复核完成，正在发布最终结论',
      });
    }
  }
  cacheItem.generationMetrics = {
    schemaVersion: 'advice-generation-metrics.v1',
    profile: deepMode ? 'DEEP' : 'FAST',
    durationMs: Math.max(0, Date.now() - startedAt),
    mainLlmCalls: advice ? 1 : 0,
    councilLlmCalls: councilShadow ? 3 : 0,
    councilCallsSaved: advice && !runCouncilShadow ? 3 : 0,
  };
  let logEntry = null;
  if (advice) {
    const px = (result && result.price) || priceHint || (payload && payload.holdCost) || null;
    logEntry = {
      code, name, mode,
      action: advice.action || advice.stance || '',
      tone: advice.tone,
      entryPrice: advice.buyPrice ?? advice.addPrice ?? null,
      stop: advice.stopPrice ?? null, target: advice.targetPrice ?? null,
      trust: meta && meta.trustScore ? meta.trustScore.score : null,
      resonance: meta && meta.resonance ? meta.resonance.score : null,
      priceAtAdvice: px,
      theoryNote: advice.theoryNote || advice.theory || '',
      planId: advice.continuity?.planId || '',
      planRevision: advice.continuity?.revision || null,
      thesisVersion: advice.continuity?.thesisVersion || null,
      knowledgeActionPlan: advice.knowledgeActionPlan || null,
      knowledgeActionScore: advice.knowledgeActionScore || null,
      decisionPlanId: advice.decisionPlan?.decisionId || null,
      decisionPlanActionability:
        advice.decisionPlan?.actionability || null,
      strategyId: advice.decisionPlan?.strategy?.strategyId || null,
      specVersion: advice.decisionPlan?.strategy?.specVersion || null,
      ...evidencePersistenceFields(advice),
      at,
    };
  }
  const quantScore = (result && result.score != null && !isNaN(result.score))
    ? { qScore: Number(result.score), qBias: result.bias || '' } : null;
  const reviewRecord = buildAdviceReviewRecord({
    code,
    mode,
    origin: payload.reviewOrigin,
    previousEntry,
    cacheItem,
    llmRan: !!advice,
    durationMs: Date.now() - startedAt,
  });
  return {
    cacheItem,
    logEntry,
    quantScore,
    councilShadow,
    reviewRecord,
  };
}

export function adviceTradeStateMatches(sourceData, latestData) {
  return accountTradeStateFingerprint(sourceData)
    === accountTradeStateFingerprint(latestData);
}

export function reviewResultStillCurrent(result, currentEntry) {
  const sourceAdviceAt = Number(result?.sourceAdviceAt) || 0;
  const currentAdviceAt = Math.max(
    Number(currentEntry?.at) || 0,
    Number(currentEntry?.updatedAt) || 0,
  );
  if (currentAdviceAt > sourceAdviceAt) return false;
  const sourcePlanId = String(result?.sourcePlanId || '');
  if (!sourcePlanId) {
    return sourceAdviceAt > 0
      ? currentAdviceAt === sourceAdviceAt
      : currentAdviceAt === 0;
  }
  return String(
    currentEntry?.advice?.continuity?.planId || '',
  ) === sourcePlanId;
}

export function requeueAdviceForTradeChange(
  data,
  code,
  now = Date.now(),
  role = '',
  jobId = '',
) {
  const job = findAdviceJob(data, code, { role, jobId });
  if (!job) return null;
  job.status = 'queued';
  job.resourceRole = adviceJobRole(job);
  job.resourceUnits = 1;
  job.attempts = Math.max(0, (Number(job.attempts) || 1) - 1);
  job.startedAt = 0;
  job.finishedAt = 0;
  job.leaseUntil = 0;
  job.error = '';
  job.phase = '交易账本已更新，正在按最新持仓重新复核';
  job.progressAt = now;
  return job;
}

async function runJobGen(
  acc,
  code,
  onProgress,
  signal,
  deepMode = false,
  dailyReportSummary = null,
  reviewEvent = null,
  reviewOrigin = '',
) {
  let sourceAcc = acc;
  try {
    sourceAcc = (await readAccount(acc.nick)) || acc;
  } catch { /* 当前副本仍可进入生成，完成前还会再次校验 */ }
  const data = sourceAcc.data || {};
  const sourceTradeFingerprint = accountTradeStateFingerprint(data);
  const holding = data.holding || [], watch = data.plan || [];
  const holdSet = new Set(holding.map((h) => h.code));
  const allCodes = [...new Set([...holding.map((h) => h.code), ...watch.map((w) => w.code)])];
  const quoteMap = await fetchQuoteMap(allCodes);
  const portfolio = computePortfolio(holding, quoteMap, data.account);
  const name = (holding.find((h) => h.code === code) || watch.find((w) => w.code === code) || {}).name || code;
  const priceHint = Number(quoteMap[code]?.price) > 0 ? Number(quoteMap[code].price) : null;
  const quantModelVersion = data.settings?.quantModelVersion || 'default';
  const realOutcomeLearning = buildRealOutcomeLearning(data);
  data.realOutcomeLearning = realOutcomeLearning;
  const activeStrategySpec = getStrategySpecV2(
    'market-quant-resonance',
  );
  const strategyGate = buildStrategyPromotionGate({
    strategySpec: activeStrategySpec,
    evaluation: CURRENT_STRATEGY_EVALUATION,
    realOutcomeLearning,
    councilRecords: councilRecordsFromData(data),
    humanApproval: data.strategyHumanApproval,
  });
  const councilEnabled = process.env.ADVISOR_COUNCIL_SHADOW !== 'false'
    && data.settings?.advisorCouncilShadow !== false;
  const runCouncilShadow = shouldRunAdvisorCouncil({
    enabled: councilEnabled,
    deepMode,
    source: reviewOrigin || 'ondemand',
  });
  const mode = holdSet.has(code) ? 'hold_advice' : 'buy_advice';
  const autoConfig = autoConfigFromSettings(data.settings || {});
  const reviewIntervalMin = mode === 'hold_advice'
    ? autoConfig.holdIntervalMin
    : autoConfig.watchIntervalMin;
  const cachedPrevious = data.advice?.[code] || null;
  const previousEntry = adviceEntryMatchesMode(cachedPrevious, mode)
    ? cachedPrevious
    : null;
  const sourceAdviceAt = Math.max(
    Number(previousEntry?.at) || 0,
    Number(previousEntry?.updatedAt) || 0,
  );
  const sourcePlanId = String(
    previousEntry?.advice?.continuity?.planId || '',
  );
  const previousAdvice = compactAdvicePlan(previousEntry);
  const previousEvidenceDigest = previousEntry?.meta?.evidenceSnapshot
    ? adviceEvidenceDigest(previousEntry.meta.evidenceSnapshot)
    : null;
  if (mode === 'hold_advice') {
    let p = buildHoldPayload(
      holding,
      code,
      name,
      portfolio,
      data.account,
      data.closed,
      nextTradingDayLabel(),
      quoteMap[code],
    );
    p.advisorTrack = advisorTrackFrom(data, 'hold_advice');
    p.realOutcomeLearning = realOutcomeLearning;
    p.quantModelVersion = quantModelVersion;
    p.accountRevision = Number(sourceAcc.clientRevision) || null;
    p = attachAdviceDailyReport(p, dailyReportSummary);
    if (previousAdvice) p.previousAdvice = previousAdvice;
    if (previousEvidenceDigest) p.previousEvidenceDigest = previousEvidenceDigest;
    if (reviewEvent) p.reviewEvent = reviewEvent;
    if (reviewOrigin) p.reviewOrigin = reviewOrigin;
    const result = await genOne({ code, name, mode: 'hold_advice', payload: p, priceHint, onProgress, signal, deepMode, previousEntry, reviewIntervalMin, reviewTrigger: reviewEvent ? `judge_${reviewEvent.decision}` : '', strategyGate, runCouncilShadow });
    return {
      ...result,
      sourceTradeFingerprint,
      sourceAdviceAt,
      sourcePlanId,
    };
  }
  let p = buildWatchPayload(code, name, portfolio, data.account);
  p.advisorTrack = advisorTrackFrom(data, 'buy_advice');
  p.realOutcomeLearning = realOutcomeLearning;
  p.quantModelVersion = quantModelVersion;
  p.accountRevision = Number(sourceAcc.clientRevision) || null;
  p = attachAdviceDailyReport(p, dailyReportSummary);
  if (previousAdvice) p.previousAdvice = previousAdvice;
  if (previousEvidenceDigest) p.previousEvidenceDigest = previousEvidenceDigest;
  if (reviewEvent) p.reviewEvent = reviewEvent;
  if (reviewOrigin) p.reviewOrigin = reviewOrigin;
  const result = await genOne({ code, name, mode: 'buy_advice', payload: p, priceHint, onProgress, signal, deepMode, previousEntry, reviewIntervalMin, reviewTrigger: reviewEvent ? `judge_${reviewEvent.decision}` : '', strategyGate, runCouncilShadow });
  return {
    ...result,
    sourceTradeFingerprint,
    sourceAdviceAt,
    sourcePlanId,
  };
}

// ---- 任务表合并:把云端最新的【外部变更】并入内存 working(捕获其它设备新入队 / 取消)----
// drainer 拥有 lease/status 主导权 → 对它已知的 code 保留内存态;
// 对它不知道的 code(其它设备刚 enqueue 的第4只)从 fresh 补入;
// 传播外部取消:fresh 里被标记 canceled/cancelRequested 的,回灌到内存。
export function mergeExternalJobs(workingData, freshData) {
  mergeAdviceBatchCancellations(workingData, freshData);
  const wj = jobsOf(workingData);
  const wr = reviewJobsOf(workingData);
  const fj = jobsOf(freshData || {});
  const fr = reviewJobsOf(freshData || {});
  const mergeTable = (workingJobs, freshJobs) => {
    for (const [code, fjob] of Object.entries(freshJobs)) {
      if (!fjob) continue;
      const cur = workingJobs[code];
      if (!cur) { workingJobs[code] = fjob; continue; }
      const sameJob = !!(fjob.id && cur.id && fjob.id === cur.id);
      if (sameJob && fjob.status === 'canceled') {
        if (isActive(cur)) {
          cur.cancelRequested = true;
          cur.status = 'canceled';
          cur.finishedAt = fjob.finishedAt || Date.now();
          cur.leaseUntil = 0;
          cur.resourceRole = 'none';
          cur.resourceUnits = 0;
          cur.phase = '已取消生成';
          cur.progressAt = fjob.progressAt || Date.now();
        }
      }
      else if (sameJob && fjob.cancelRequested && isActive(cur)) cur.cancelRequested = true;
      else if (
        fjob.id !== cur.id
        && (fjob.at || 0) >= (cur.at || 0)
        && isActive(fjob)
      ) workingJobs[code] = fjob;
    }
  };
  mergeTable(wj, fj);
  mergeTable(wr, fr);
  mergeAdviceBatchCancellations(workingData, {}, Date.now());
  const withBatch = Object.values(wj).filter((job) => job?.batchId);
  const active = withBatch.filter((job) => isActive(job));
  const latest = (active.length ? active : withBatch)
    .reduce((current, job) =>
      !current || (job.at || 0) >= (current.at || 0) ? job : current
    , null);
  workingData.activeAdviceBatchId = latest?.batchId
    || freshData?.activeAdviceBatchId
    || workingData.activeAdviceBatchId
    || '';
}

// ---- 保护式落盘:重读云端最新账号,只叠加服务端权威字段,绝不覆盖用户 plan/holding/account ----
async function persistServer(nick, workingAcc) {
  const fresh = (await readAccount(
    nick,
    undefined,
    { includeAdviceUpdates: false },
  )) || workingAcc;
  if (!isAccountActive(fresh)) return fresh;
  const fdata = fresh.data || (fresh.data = {});
  const wdata = workingAcc.data || {};
  // 先把云端外部变更并入内存(其它设备新入队/取消),再整体回写 jobs(服务端权威)
  mergeExternalJobs(wdata, fdata);
  fdata.jobs = wdata.jobs;
  fdata.reviewJobs = wdata.reviewJobs;
  fdata.adviceEventKeys = {
    ...(fdata.adviceEventKeys || {}),
    ...(wdata.adviceEventKeys || {}),
  };
  fdata.adviceBatchCancellations = {
    ...(wdata.adviceBatchCancellations || {}),
  };
  fdata.adviceAutoPauseUntil = Math.max(
    Number(fdata.adviceAutoPauseUntil) || 0,
    Number(wdata.adviceAutoPauseUntil) || 0,
  );
  fdata.runtimeAdviceAppliedAt = {
    ...(fdata.runtimeAdviceAppliedAt || {}),
    ...(wdata.runtimeAdviceAppliedAt || {}),
  };
  fdata.jobWorker = wdata.jobWorker;
  fdata.activeAdviceBatchId = wdata.activeAdviceBatchId || fdata.activeAdviceBatchId || '';
  if (
    wdata.adviceDailyReport?.summary?.text
    && (
      !fdata.adviceDailyReport
      || (wdata.adviceDailyReport.at || 0)
        >= (fdata.adviceDailyReport.at || 0)
    )
  ) {
    fdata.adviceDailyReport = wdata.adviceDailyReport;
  }
  // 自动刷新运行时间由云端定时器维护，客户端旧快照不能把它覆盖回去。
  const runtimeSettingKeys = [
    'advAuto.holdLastAt', 'advAuto.holdLastTryAt',
    'advAuto.watchLastAt', 'advAuto.watchLastTryAt',
  ];
  if (wdata.settings && typeof wdata.settings === 'object') {
    const settings = { ...(fdata.settings || {}) };
    for (const key of runtimeSettingKeys) {
      if (wdata.settings[key] != null) settings[key] = wdata.settings[key];
    }
    fdata.settings = settings;
  }
  // 进度快照(旧前端仍消费 batchProgress);concurrency=当前 advisor 端点数(供前端单股触发门控)
  fdata.batchProgress = jobsToProgress(wdata, Date.now(), effectiveAdviceConcurrency(wdata));
  // advice 逐条时间戳并入
  const wa = (wdata.advice && typeof wdata.advice === 'object') ? wdata.advice : {};
  const fa = (fdata.advice && typeof fdata.advice === 'object') ? fdata.advice : (fdata.advice = {});
  for (const [k, v] of Object.entries(wa)) {
    if (!v) continue;
    const cur = fa[k];
    if (!cur || (v.at || 0) > (cur.at || 0)) fa[k] = v;
    const effective = fa[k];
    if (effective && effective.advice) {
      projectAdviceAlerts(fdata, k, effective.advice, {
        t1Status: t1StatusOf(fdata.holding || [], fdata.closed || [], k),
        nextTradeDay: nextTradingDayLabel(),
        requirePriceContract: true,
      });
    }
  }
  fdata.evidenceSnapshots = mergeEvidenceSnapshotIndexes(
    {
      ...(fdata.evidenceSnapshots || {}),
      ...evidenceSnapshotsFromData(fdata),
    },
    {
      ...(wdata.evidenceSnapshots || {}),
      ...evidenceSnapshotsFromData(wdata),
    },
  );
  const reviewRecords = new Map(
    (fdata.adviceReviewLog || [])
      .filter((record) => record?.id)
      .map((record) => [record.id, record]),
  );
  for (const record of (wdata.adviceReviewLog || [])) {
    if (!record?.id) continue;
    const current = reviewRecords.get(record.id);
    if (!current || Number(record.at) >= Number(current.at)) {
      reviewRecords.set(record.id, record);
    }
  }
  fdata.adviceReviewLog = [...reviewRecords.values()]
    .sort((left, right) => Number(right.at) - Number(left.at))
    .slice(0, 500);
  // adviceLog 按 id 并集
  const wlog = wdata.adviceLog || [];
  if (wlog.length) {
    const flog = fdata.adviceLog || (fdata.adviceLog = []);
    const seen = new Set(flog.map((x) => x && x.id).filter(Boolean));
    for (const e of wlog) if (e && e.id && !seen.has(e.id)) flog.unshift(e);
    fdata.adviceLog = flog.slice(0, 500);
  }
  // decisionLog 按 id 合并；同一建议的 executed 状态取更新时间更晚的一份。
  const decisions = new Map(((fdata.decisionLog || [])).filter((x) => x && x.id).map((x) => [x.id, x]));
  for (const event of (wdata.decisionLog || [])) {
    if (!event || !event.id) continue;
    const current = decisions.get(event.id);
    if (!current || (event.executedAt || event.at || 0) > (current.executedAt || current.at || 0)) {
      decisions.set(event.id, event);
    }
  }
  fdata.decisionLog = [...decisions.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 1000);
  // qScore/qBias 写回(仅同 code 存在时)
  const stampFrom = (srcArr, dstArr) => {
    for (const s of (srcArr || [])) { if (!s || s.qScore == null) continue; for (const d of (dstArr || [])) if (d && d.code === s.code) { d.qScore = s.qScore; d.qBias = s.qBias; d.qAt = s.qAt; } }
  };
  stampFrom(wdata.holding, fdata.holding);
  stampFrom(wdata.plan, fdata.plan);
  const runtimeState = adviceRuntimeStateFromData(
    fdata,
    Date.now(),
  );
  await retryRuntimeWrite(() =>
    writeAdviceRuntimeState(nick, runtimeState)
  );
  fdata.runtimeStateAppliedAt = runtimeState.updatedAt;
  // 让 drainer 后续以 fresh 为工作副本:fresh 有用户最新 plan/holding + 我们刚写的服务端字段
  return fresh;
}

async function releaseDrainLock(nick, acc, myId, concurrency) {
  const fresh = (await readAccount(nick)) || acc;
  const fdata = fresh.data || (fresh.data = {});
  if (isAccountActive(fresh) && !workerHeldByOther(fdata, myId)) {
    releaseWorkerLock(fdata, myId);
    mergeExternalJobs(acc.data, fdata);
    fdata.jobs = acc.data.jobs;
    fdata.reviewJobs = acc.data.reviewJobs;
    fdata.batchProgress = jobsToProgress(
      acc.data,
      Date.now(),
      concurrency,
    );
    if (acc.data.adviceDailyReport?.summary?.text) {
      fdata.adviceDailyReport = acc.data.adviceDailyReport;
    }
    try { await writeAccount(fresh); } catch { /* ignore */ }
  }
}

// ---- 并发池 drainer:单 Worker 锁下,把 queued 任务以 ≤CONCURRENCY 并发跑完 ----
// 返回 { drained(bool), ok, fail } 或 { skipped:'locked' }。
async function drainAccount(nick, initialAcc) {
  const myId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let acc = initialAcc || (await readAccount(nick));
  if (!isAccountActive(acc)) return { drained: false, ok: 0, fail: 0 };
  let data = acc.data || (acc.data = {});
  reapOrphans(data); gcJobs(data);
  if (!acquireWorkerLock(data, myId)) return { skipped: 'locked' };  // 已有他人在 drain → 交给它
  const persistence = createRecoverableSerialRunner(async () => {
    acc = await persistServer(nick, acc);
    data = acc.data;
    return acc;
  });
  const saveWorking = () => persistence.run();
  acc = await saveWorking();                                           // 公布锁 + 回收结果
  data = acc.data;
  if (cancelDisabledAdviceReviewJobs(data) > 0) {
    acc = await saveWorking();
    data = acc.data;
  }

  const CONC = effectiveAdviceConcurrency(data);
  const REVIEW_CONC = reviewConcurrency();
  // 策略日报只作软证据：复用账号内已有摘要，缺失时直接继续个股生成。
  // ai.js 会再次校验摘要时效，不允许日报生成拆成前置 Worker 阻断主流程。
  const dailyReportSummary = data.adviceDailyReport?.summary || null;
  const inflight = new Map();   // jobId -> { promise, controller, code, role }
  const roleCapacities = {
    advisor: CONC,
    review: REVIEW_CONC,
  };
  let schedulerWake = null;
  const wakeScheduler = () => {
    if (schedulerWake) schedulerWake();
  };
  const createSchedulerWait = () => {
    let active = true;
    let timer = null;
    let finish = null;
    const promise = new Promise((resolve) => {
      finish = () => {
        if (!active) return;
        active = false;
        if (schedulerWake === finish) schedulerWake = null;
        if (timer) clearTimeout(timer);
        resolve(null);
      };
      schedulerWake = finish;
      timer = setTimeout(finish, 1000);
    });
    return {
      promise,
      cancel() {
        if (!active) return;
        active = false;
        if (schedulerWake === finish) schedulerWake = null;
        if (timer) clearTimeout(timer);
      },
    };
  };
  let ok = 0, fail = 0;
  // 深度主研判最多约 535s，后面还要留出委员会复核、OSS 发布和 FC 收尾时间。
  // 本轮后段不再启动新任务；剩余队列由 5 分钟云端定时器接力。
  const startDeadline = Date.now() + (hasDeepAdviceWork(data) ? 40000 : 300000);
  const progressSaver = createAdviceProgressSaveScheduler(saveWorking);
  const queueProgressSave = (force = false) =>
    progressSaver.schedule(force);
  const recordProgress = (code, jobId, role, patch) => {
    const d = acc.data || (acc.data = {});
    const job = findAdviceJob(d, code, { role, jobId });
    if (!job) return;
    const stageChanged = !!(
      patch.stage
      && patch.stage !== job.stage
    );
    const resourcePatch = resourcePatchForJobProgress(
      job,
      patch.stage,
      REVIEW_CONC,
    );
    if (patch.source) {
      const sources = [...(job.sources || [])];
      const idx = sources.findIndex((item) => item.label === patch.source.label);
      if (idx >= 0) sources[idx] = patch.source;
      else sources.push(patch.source);
      updateJobProgress(
        d,
        code,
        { sources, ...resourcePatch },
        Date.now(),
        role,
        jobId,
      );
    } else if (patch.reasoningDelta) {
      updateJobProgress(
        d,
        code,
        {
          reasoning: `${job.reasoning || ''}${patch.reasoningDelta}`,
          ...resourcePatch,
        },
        Date.now(),
        role,
        jobId,
      );
    } else {
      updateJobProgress(
        d,
        code,
        { ...patch, ...resourcePatch },
        Date.now(),
        role,
        jobId,
      );
    }
    if (stageChanged) wakeScheduler();
    void queueProgressSave(stageChanged).catch(() => {});
  };
  const heartbeat = setInterval(() => {
    const d = acc.data || (acc.data = {});
    renewWorkerLock(d, myId);
    for (const task of inflight.values()) {
      renewLease(d, task.code, Date.now(), task.role, task.jobId);
    }
    void queueProgressSave(true).catch(() => {});
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
  const cancelPoll = setInterval(async () => {
    try {
      const fresh = await readAccount(nick);
      const knownJobIds = new Set(
        allAdviceJobs(acc.data).map((job) => String(job.id || '')),
      );
      mergeExternalJobs(acc.data, fresh?.data || {});
      const discoveredWork = allAdviceJobs(acc.data).some((job) =>
        isActive(job)
        && !knownJobIds.has(String(job.id || ''))
      );
      acc.data.settings = mergeAutoRefreshSettings(
        acc.data.settings || {},
        fresh?.data?.settings || {},
      );
      const disabledCanceled = cancelDisabledAdviceReviewJobs(acc.data);
      for (const task of inflight.values()) {
        const local = findAdviceJob(
          acc.data,
          task.code,
          { role: task.role, jobId: task.jobId },
        );
        if (local?.status === 'canceled') {
          task.controller.abort();
          continue;
        }
        const remote = findAdviceJob(
          fresh?.data || {},
          task.code,
          { role: task.role },
        );
        if (remote?.id && remote.id !== task.jobId) {
          const target = task.role === 'review'
            ? reviewJobsOf(acc.data)
            : jobsOf(acc.data);
          target[task.code] = remote;
          task.controller.abort();
        } else if (remote?.status === 'canceled' || remote?.cancelRequested) {
          cancelJob(
            acc.data,
            task.code,
            Date.now(),
            '',
            task.jobId,
            task.role,
          );
          task.controller.abort();
        }
      }
      if (disabledCanceled > 0) await queueProgressSave(true);
      if (disabledCanceled > 0 || discoveredWork) wakeScheduler();
    } catch { /* 下一轮继续检查 */ }
  }, CANCEL_POLL_INTERVAL_MS);
  if (cancelPoll && typeof cancelPoll.unref === 'function') cancelPoll.unref();
  try {
    while (true) {
      data = acc.data;
      reapOrphans(data); gcJobs(data);
      renewWorkerLock(data, myId);
      const startable = Date.now() < startDeadline
        ? selectStartableJobs(
            data,
            roleCapacities,
            new Set(inflight.keys()),
          )
        : [];
      // 处理 queued 里已被外部取消意图标记的
      for (const j of allAdviceJobs(data)) {
        if (j && j.status === 'queued' && j.cancelRequested) {
          j.status = 'canceled';
          j.finishedAt = Date.now();
          j.resourceRole = 'none';
          j.resourceUnits = 0;
        }
      }
      for (const j of startable) {
        const role = adviceJobRole(j);
        const leased = leaseJob(data, j.code, Date.now(), role, j.id);
        if (!leased) continue;
        const code = j.code;
        const jobId = j.id;
        const controller = new AbortController();
        const promise = runJobGen(
          acc,
          code,
          (patch) => recordProgress(code, jobId, role, patch),
          controller.signal,
          !!j.deepMode,
          dailyReportSummary,
          j.trigger || null,
          j.source || '',
        )
          .then((res) => ({ code, jobId, role, res }))
          .catch((err) => ({ code, jobId, role, err }));
        inflight.set(jobId, {
          promise,
          controller,
          code,
          jobId,
          role,
        });
      }
      if (startable.length) acc = await saveWorking();   // 公布 lease

      if (inflight.size === 0) {
        if (!hasPendingWork(acc.data)) break;   // 无在跑 + 无待办 → 完成
        if (Date.now() >= startDeadline) break; // 留给下一次 cron 续跑，避免撞 FC 600s 硬墙
        // 有待办却起不来(理论上 free>0 时不会发生)——保护性跳出
        break;
      }
      const schedulerWait = createSchedulerWait();
      const done = await Promise.race([
        ...[...inflight.values()].map((task) => task.promise),
        schedulerWait.promise,
      ]);
      schedulerWait.cancel();
      if (!done) continue;
      inflight.delete(done.jobId);
      // 应用结果到内存,再保护式落盘
      const d = acc.data;
      const job = findAdviceJob(
        d,
        done.code,
        { role: done.role, jobId: done.jobId },
      );
      let tradeStateCurrent = true;
      if (done.res?.sourceTradeFingerprint) {
        try {
          const latest = await readAccount(nick);
          tradeStateCurrent = !!latest?.data
            && accountTradeStateFingerprint(latest.data)
              === done.res.sourceTradeFingerprint;
        } catch {
          tradeStateCurrent = false;
        }
      }
      if (!job || job.id !== done.jobId) {
        // 同一股票已被新批次替换，旧结果必须丢弃。
      } else if (job.cancelRequested || job.status === 'canceled') { // 运行中被取消 → 丢弃结果
        job.status = 'canceled'; job.finishedAt = Date.now(); job.leaseUntil = 0;
        job.resourceRole = 'none'; job.resourceUnits = 0;
      } else if (!tradeStateCurrent) {
        // 生成期间若用户加/减仓、改成本或补录成交，旧结果里的手数和成本已失效。
        // 不消耗重试次数，直接以最新 OSS 账本重跑，绝不把旧建议落盘。
        requeueAdviceForTradeChange(
          d,
          done.code,
          Date.now(),
          done.role,
          done.jobId,
        );
      } else if (done.res && done.res.cacheItem) {
        const completion = completeJob(d, done.code, Date.now(), {
          evidenceAsOf: Date.parse(
            done.res.cacheItem?.meta?.evidenceSnapshot?.asOf || '',
          ) || 0,
          planRevision: Number(
            done.res.cacheItem?.advice?.continuity?.revision,
          ) || 0,
          role: done.role,
          jobId: done.jobId,
        });
        if (
          completion?.publish
          && done.role === 'review'
          && !reviewResultStillCurrent(
            done.res,
            d.advice?.[done.code],
          )
        ) {
          completion.publish = false;
          completion.status = 'stale';
          job.phase = '复核基准已更新，已丢弃旧结果';
        }
        if (!completion?.publish) {
          acc = await saveWorking();
          data = acc.data;
          continue;
        }
        ok++;
        const completedAt = Number(job.finishedAt) || Date.now();
        done.res.cacheItem.updatedAt = Math.max(
          Number(done.res.cacheItem.updatedAt) || 0,
          completedAt,
        );
        (d.advice || (d.advice = {}))[done.code] = done.res.cacheItem;
        if (done.res.logEntry) {
          const log = d.adviceLog || (d.adviceLog = []);
          const dup = log.find((x) =>
            x.code === done.code
            && x.mode === done.res.logEntry.mode
            && (Date.now() - (x.at || 0)) < 600000
          );
          const decisions = d.decisionLog || (d.decisionLog = []);
          const dupDecision = dup
            ? decisions.find((event) => event?.id === dup.id)
            : null;
          if (dup && dupDecision && dupDecision.status !== 'executed') {
            Object.assign(dup, {
              ...done.res.logEntry,
              verified: false,
              hit: null,
              resultPct: null,
            });
            Object.assign(dupDecision, {
              ...done.res.logEntry,
              status: 'pending',
              executedAt: null,
              linkedExecutionId: null,
              knowledgeActionReview: null,
            });
          } else {
            const id = `${done.res.logEntry.at}_${done.code}`;
            log.unshift({ id, verified: false, hit: null, resultPct: null, ...done.res.logEntry });
            d.adviceLog = log.slice(0, 500);
            decisions.unshift(createRecommendation({ id, ...done.res.logEntry }));
            d.decisionLog = decisions.slice(0, 1000);
          }
        }
        if (done.res.quantScore) applyQuantScore(d, done.code, done.res.quantScore);
        if (done.res.councilShadow) {
          addCouncilShadowRecord(d, done.res.councilShadow);
        }
        if (done.res.reviewRecord) {
          const records = d.adviceReviewLog || (d.adviceReviewLog = []);
          const withoutCurrent = records.filter(
            (record) => record?.id !== done.res.reviewRecord.id,
          );
          d.adviceReviewLog = [
            done.res.reviewRecord,
            ...withoutCurrent,
          ].slice(0, 500);
        }
      } else {
        failJob(
          d,
          done.code,
          done.err
            ? String(done.err.message || done.err)
            : job?.deepMode
              ? '深度建议未完整返回'
              : '生成失败(军师+量化均空)',
          Date.now(),
          done.role,
          done.jobId,
        );
        if (job.status === 'failed') fail++;
      }
      if (job && job.id === done.jobId) {
        try {
          await persistAdviceCompletion(
            nick,
            d,
            done.code,
            CONC,
            done.role,
            done.jobId,
          );
        } catch (runtimeError) {
          // 小对象增量写连续失败时才回退完整快照，避免生成结果丢失。
          await writeAccount(acc, undefined, {
            history: false,
            verify: true,
          });
        }
      }
      // 单股结果已独立持久化；完整账号快照交给节流进度或批次收尾压实。
      void queueProgressSave(false).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancelPoll);
    for (const task of inflight.values()) task.controller.abort();
    await progressSaver.settle();
    await persistence.settle();
    await releaseDrainLock(nick, acc, myId, CONC);
  }
  let continued = false;
  if (hasRunnableAdviceWork(acc.data)) {
    try {
      continued = !!(await scheduleAdviceWorker(nick))?.accepted;
    } catch { /* 5分钟恢复定时器仍会兜底 */ }
  }
  return { drained: true, ok, fail, continued };
}

// 排入某账号的"过期/缺建议"任务(定时兜底 & 全量刷新用)。scope 过滤 hold/watch/all。
const GAP_MS = 6 * 3600 * 1000;
function enqueueStale(data, { scope = 'all', force = false } = {}) {
  const holding = data.holding || [], watch = data.plan || [];
  const advice = (data.advice && typeof data.advice === 'object') ? data.advice : {};
  const holdSet = new Set(holding.map((h) => h.code));
  const isFresh = (code) => { if (force) return false; const a = advice[code]; return !!(a && a.at && (Date.now() - a.at) < GAP_MS); };
  let n = 0;
  const batchId = `cron_${Date.now()}`;
  const add = (code, name, mode) => {
    const { created } = enqueueJob(data, {
      code,
      name,
      mode,
      source: 'cron',
      force,
      batchId,
      idempotencyKey: `cron:${batchId}:${code}:${mode}`,
    });
    if (created) n++;
  };
  if (scope === 'all' || scope === 'hold') {
    for (const code of [...new Set(holding.map((h) => h.code))]) {
      if (isFresh(code)) continue;
      const name = (holding.find((h) => h.code === code) || {}).name || code;
      add(code, name, 'hold_advice');
    }
  }
  if (scope === 'all' || scope === 'watch') {
    for (const code of [...new Set(watch.map((w) => w.code))].filter((c) => !holdSet.has(c))) {
      if (isFresh(code)) continue;
      const name = (watch.find((w) => w.code === code) || {}).name || code;
      add(code, name, 'buy_advice');
    }
  }
  return n;
}

function inAutoRefreshWindow(now = Date.now()) {
  return isContinuousTrading(now);
}

export function cancelDisabledAdviceReviewJobs(data, now = Date.now()) {
  const settings = data?.settings || {};
  const config = autoConfigFromSettings(settings);
  const hasExplicitSelection = Array.isArray(config.holdCodes)
    || Array.isArray(config.watchCodes);
  const selectedCodes = hasExplicitSelection
    ? new Set(selectAutoRefreshCodes({
        config,
        holdings: data?.holding || [],
        watchlist: data?.plan || [],
      }).allCodes)
    : null;
  let canceled = 0;
  for (const job of Object.values(reviewJobsOf(data || {}))) {
    if (
      !job?.code
      || !['auto', 'cron', 'judge'].includes(job.source)
      || (
        isAdviceReviewEnabled(settings, job.code)
        && !(
          job.source === 'auto'
          && selectedCodes
          && !selectedCodes.has(String(job.code))
        )
      )
    ) continue;
    if (
      cancelJob(
        data,
        job.code,
        now,
        '',
        job.id,
        'review',
      )
    ) canceled++;
  }
  return canceled;
}

export function enqueueAutoRefreshDue(data, now = Date.now()) {
  if (!inAutoRefreshWindow(now)) return 0;
  if (Number(data?.adviceAutoPauseUntil) > now) return 0;
  const settings = data.settings || (data.settings = {});
  const config = autoConfigFromSettings(settings);
  const scopes = [
    ...(config.holdEnabled ? ['hold'] : []),
    ...(config.watchEnabled ? ['watch'] : []),
  ];
  if (!scopes.length) return 0;

  const holding = data.holding || [];
  const watch = data.plan || [];
  const advice = data.advice && typeof data.advice === 'object'
    ? data.advice
    : {};
  const holdSet = new Set(
    holding.map((item) => String(item?.code || '')).filter(Boolean),
  );
  const selected = selectAutoRefreshCodes({
    config,
    holdings: holding,
    watchlist: watch,
    scopes,
  });
  const holdCodes = selected.holdCodes;
  const watchCodes = selected.watchCodes;
  const batchId = `auto_${now}`;
  const activeAutoJobs = Object.values(reviewJobsOf(data))
    .filter((job) => job?.source === 'auto' && isActive(job))
    .length;
  const autoBudget = Math.max(0, MAX_AUTO_JOBS_PER_TICK - activeAutoJobs);
  let count = 0;
  let holdCreated = 0;
  let watchCreated = 0;
  const enqueue = (code, name, mode) => {
    const needsPriceMigration = !!advice?.[code]?.advice
      && !sanitizedAdvicePriceContract(advice[code].advice);
    const reviewAt = Number(
      advice?.[code]?.reviewCycle?.nextReviewAt
      ?? advice?.[code]?.advice?.reviewCycle?.nextReviewAt,
    ) || now;
    const scheduleKey = needsPriceMigration
      ? `price-contract:${Math.floor(now / (5 * 60 * 1000))}`
      : reviewAt;
    const { created } = enqueueJob(data, {
      code,
      name,
      mode,
      source: 'auto',
      force: false,
      batchId,
      idempotencyKey: `auto:${code}:${mode}:${scheduleKey}`,
    }, now);
    if (created) {
      count++;
      if (mode === 'hold_advice') holdCreated++;
      else watchCreated++;
    }
  };
  const allowedCodes = [
    ...(scopes.includes('hold') ? holdCodes : []),
    ...(scopes.includes('watch') ? watchCodes : []),
  ].filter((code) =>
    isAdviceReviewEnabled(settings, code)
    && (
      adviceReviewDue(advice[code], now)
      || (
        advice?.[code]?.advice
        && !sanitizedAdvicePriceContract(advice[code].advice)
      )
    )
  );
  const orderedCodes = prioritizeAdviceReviewCodes({
    codes: allowedCodes,
    holdingCodes: holdCodes,
    starredCodes: watch.filter((item) => item?.star).map((item) => item.code),
    alerts: data.alerts || [],
    advice,
    now,
  });
  const names = new Map(
    [...holding, ...watch]
      .filter((item) => item?.code)
      .map((item) => [item.code, item.name || item.code]),
  );
  for (const code of orderedCodes) {
    if (count >= autoBudget) break;
    enqueue(
      code,
      names.get(code) || code,
      holdSet.has(code) ? 'hold_advice' : 'buy_advice',
    );
  }
  if (holdCreated > 0) {
    settings['advAuto.holdLastTryAt'] = now;
    settings['advAuto.holdLastAt'] = now;
  }
  if (watchCreated > 0) {
    settings['advAuto.watchLastTryAt'] = now;
    settings['advAuto.watchLastAt'] = now;
  }
  return count;
}

export async function scheduleAdviceWorker(nick) {
  if (process.env.ADVICE_ASYNC_WORKER === 'true' || process.env.FC_SERVER_PORT) {
    return dispatchAdviceWorker(nick);
  }
  setImmediate(() => {
    drainAccount(nick).catch((error) => {
      console.error(
        '[cron_advice] local worker failed',
        error?.code || error?.name || error?.message,
      );
    });
  });
  return { accepted: true, requestId: 'local-worker' };
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 预热 LLM 配置 → advisorConcurrency() 才能读到最新的端点数(并发上限的权威来源)
  try { await ensureConfig(); } catch { /* 读失败回退 env 基线,不阻断 */ }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const scope = ['all', 'hold', 'watch'].includes(body.scope) ? body.scope : 'all';
  const force = body.force != null ? !!body.force : true;   // 用户主动生成默认强制重生成

  // ====== 分支 A:账号会话鉴权的按需操作(enqueue / cancel / cancelAll / status / drain)======
  const isUser = !!(body.nick && (body.token != null || body.pw != null));
  if (isUser) {
    const nick = String(body.nick || '').trim();
    const pw = String(body.pw || '');
    const token = String(body.token || '');
    if (!nick || (!token && !pw)) {
      return res.end(JSON.stringify({ ok: false, error: '缺少账号凭证' }));
    }
    const acc = await readAccount(nick);
    if (!acc) return res.end(JSON.stringify({ ok: false, error: '账号不存在' }));
    if (!accountCredentialMatches(acc, { pw, token })) {
      return res.end(JSON.stringify({ ok: false, error: '账号鉴权失败' }));
    }
    if (!isAccountActive(acc)) return res.end(JSON.stringify({ ok: false, error: '账号已注销' }));
    const data = acc.data || (acc.data = {});
    const op = body.op || 'enqueue';
    const started = Date.now();
    let CONC = effectiveAdviceConcurrency(data);
    let stopHeartbeat = () => {};

    try {
      if (op === 'status') {
        const recovered = reapOrphans(data);
        gcJobs(data);
        if (recovered > 0) await persistServer(nick, acc);
        let workerScheduled = false;
        if (needsRoleWorkerDispatch(data)) {
          try {
            workerScheduled = !!(await scheduleAdviceWorker(nick))?.accepted;
          } catch (error) {
            console.error(
              '[cron_advice] status worker dispatch failed',
              error?.code || error?.name || error?.message,
            );
          }
        }
        return res.end(JSON.stringify({
          ok: true,
          jobs: jobsOf(data),
          reviewJobs: reviewJobsOf(data),
          progress: jobsToProgress(data, Date.now(), CONC),
          concurrency: CONC,
          running: runningCount(data, Date.now(), 'advisor'),
          reviewRunning: runningCount(data, Date.now(), 'review'),
          workerScheduled,
          recovered,
        }));
      }
      if (op === 'cancel') {
        const targets = Array.isArray(body.targets)
          ? body.targets
            .filter((target) => target?.code)
            .map((target) => ({
              code: String(target.code),
              jobId: String(target.jobId || ''),
              batchId: String(target.batchId || ''),
            }))
          : [];
        const codes = targets.length
          ? []
          : Array.isArray(body.codes)
            ? body.codes.filter(Boolean).map(String)
            : [];
        const batchId = String(body.batchId || '');
        let n = 0;
        for (const target of targets) {
          if (
            cancelJob(
              data,
              target.code,
              Date.now(),
              target.batchId || batchId,
              target.jobId,
            )
          ) n++;
        }
        for (const code of codes) {
          if (cancelJob(data, code, Date.now(), batchId)) n++;
        }
        await persistServer(nick, acc);
        return res.end(JSON.stringify({ ok: true, canceled: n, progress: jobsToProgress(data, Date.now(), CONC) }));
      }
      if (op === 'cancelAll') {
        const batchId = String(body.batchId || '').trim().slice(0, 100);
        if (!batchId) {
          return res.end(JSON.stringify({
            ok: false,
            confirmed: false,
            error: '缺少批次标识',
          }));
        }
        markAdviceBatchCanceled(data, batchId, Date.now());
        const n = cancelAll(data, Date.now(), batchId);
        const persisted = await persistServer(nick, acc);
        const finalData = persisted?.data || data;
        return res.end(JSON.stringify({
          ok: true,
          confirmed: isAdviceBatchCanceled(finalData, batchId),
          batchId,
          canceled: n,
          progress: jobsToProgress(finalData, Date.now(), CONC),
        }));
      }
      // enqueue(默认):把 codes 排入队列(防重),随后 drain(拿不到锁则由在跑的 drainer 接手)
      const codes = Array.isArray(body.codes) ? [...new Set(body.codes.filter(Boolean).map(String))] : [];
      if (!codes.length) return res.end(JSON.stringify({ ok: false, error: '缺少 codes' }));
      const deepMode = body.deepMode === true;
      const modeValidation = validateBatchMode(codes, deepMode);
      if (!modeValidation.ok) {
        return res.end(JSON.stringify({
          ok: false,
          error: '批量模式参数无效',
          code: modeValidation.error,
          limit: modeValidation.limit,
        }));
      }
      const holding = data.holding || [], watch = data.plan || [];
      const holdSet = new Set(holding.map((h) => h.code));
      const nameOf = (c) => (holding.find((h) => h.code === c) || watch.find((w) => w.code === c) || {}).name || c;
      const eligibleCodes = codes.filter((code) =>
        (scope !== 'hold' || holdSet.has(code))
        && (scope !== 'watch' || !holdSet.has(code))
      );
      if (!eligibleCodes.length) {
        return res.end(JSON.stringify({
          ok: false,
          error: '当前范围没有可生成的股票',
        }));
      }
      const requestedBatchId = String(body.batchId || '').trim();
      const batchRequest = !!requestedBatchId;
      const batchId = requestedBatchId
        ? requestedBatchId.slice(0, 100)
        : `ondemand_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const requestId = String(
        body.requestId || requestedBatchId || batchId,
      ).trim().slice(0, 140);
      CONC = effectiveAdviceConcurrency(
        data,
        deepMode,
        batchRequest,
      );
      if (
        batchRequest
        && isAdviceBatchCanceled(data, batchId)
      ) {
        return res.end(JSON.stringify({
          ok: false,
          accepted: false,
          canceled: true,
          confirmed: true,
          batchId,
          error: '该批次已停止',
          progress: jobsToProgress(data, Date.now(), CONC),
        }));
      }
      const admission = advisorAdmission(
        data,
        eligibleCodes,
        CONC,
      );
      if (!admission.accepted) {
        res.statusCode = 409;
        return res.end(JSON.stringify({
          ok: false,
          accepted: false,
          queued: false,
          code: 'ADVISOR_CAPACITY_FULL',
          error: '军师端点已满，请等待当前生成完成',
          busy: admission.busy,
          concurrency: admission.capacity,
          progress: jobsToProgress(
            data,
            Date.now(),
            CONC,
          ),
        }));
      }
      let enq = 0, dup = 0, canceledBeforeQueue = 0;
      for (const code of eligibleCodes) {
        const mode = holdSet.has(code) ? 'hold_advice' : 'buy_advice';
        const { created, canceled } = enqueueJob(data, {
          code, name: nameOf(code), mode, source: 'ondemand', force, batchId, deepMode,
          batchRequest,
          idempotencyKey: `ondemand:${requestId}:${code}:${mode}`,
        });
        if (canceled) canceledBeforeQueue++;
        else if (created) enq++;
        else dup++;
      }
      if (enq > 0) data.activeAdviceBatchId = batchId;
      CONC = effectiveAdviceConcurrency(data, deepMode, batchRequest);
      const persisted = await persistServer(
        nick,
        acc,
      );   // 立刻公布队列(另一设备可见)
      const persistedData = persisted?.data || data;
      if (
        canceledBeforeQueue > 0
        || isAdviceBatchCanceled(persistedData, batchId)
      ) {
        return res.end(JSON.stringify({
          ok: false,
          accepted: false,
          canceled: true,
          confirmed: true,
          batchId,
          error: '该批次已停止',
          progress: jobsToProgress(
            persistedData,
            Date.now(),
            CONC,
          ),
        }));
      }
      let worker = null;
      try {
        if (needsWorkerDispatch(persistedData)) {
          worker = await scheduleAdviceWorker(nick);
        }
      } catch (error) {
        console.error(
          '[cron_advice] worker dispatch failed',
          error?.code || error?.name || error?.message,
        );
        res.statusCode = 503;
        return res.end(JSON.stringify({
          ok: false,
          accepted: true,
          queued: true,
          code: 'WORKER_DISPATCH_FAILED',
          error: '任务已保存，但云端Worker调度失败，将由定时任务自动恢复',
          enqueued: enq,
          dedup: dup,
          concurrency: CONC,
          deepMode,
          progress: jobsToProgress(
            persistedData,
            Date.now(),
            CONC,
          ),
        }));
      }
      res.statusCode = 202;
      return res.end(JSON.stringify({
        ok: true,
        accepted: true,
        workerScheduled: !!worker?.accepted,
        requestId: worker?.requestId || '',
        enqueued: enq,
        dedup: dup,
        concurrency: CONC,
        deepMode,
        progress: jobsToProgress(
          persistedData,
          Date.now(),
          CONC,
        ),
      }));
    } catch (e) {
      stopHeartbeat();
      if (res.headersSent) return endWorkerResponse(res, { ok: false, error: String(e.message || e), elapsedMs: Date.now() - started });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e), elapsedMs: Date.now() - started }));
    }
  }

  // ====== 分支 B:定时兜底(CRON_KEY)——回收孤儿 + 排入过期建议 + drain 所有账号 ======
  const CRON_KEY = process.env.CRON_KEY;
  if (CRON_KEY) {
    const given = req.headers['x-cron-key'] || (req.query && req.query.key) || (req.body && req.body.key);
    if (given !== CRON_KEY) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  }
  const onlyNick = body.nick ? String(body.nick) : null;
  const started = Date.now();
  const stopHeartbeat = startJsonHeartbeat(res);
  try {
    let accounts = await listAllAccounts();
    if (onlyNick) accounts = accounts.filter((a) => a.nick === onlyNick);
    const summary = [];
    let totalOk = 0, totalFail = 0;
    for (const acc0 of accounts) {
      const nick = acc0.nick;
      try {
        const acc = await readAccount(nick);
        if (!acc) continue;
        const data = acc.data || (acc.data = {});
        reapOrphans(data);
        // 定时:排入过期建议(force=false → 6h 新鲜度节流,不烧 token);同时续跑遗留 queued/孤儿
        const enq = body.autoRefresh === true
          ? enqueueAutoRefreshDue(data)
          : body.resumeOnly === true
            ? 0
            : enqueueStale(data, { scope, force: body.force === true });
        await persistServer(nick, acc);
        const dr = hasRunnableAdviceWork(acc.data)
          ? await drainAccount(nick, await readAccount(nick))
          : { drained: false, ok: 0, fail: 0 };
        totalOk += dr.ok || 0; totalFail += dr.fail || 0;
        summary.push({ nick, enqueued: enq, ...(dr.skipped ? { skipped: dr.skipped } : { ok: dr.ok, fail: dr.fail }) });
      } catch (e) { summary.push({ nick, error: String(e.message || e) }); }
    }
    stopHeartbeat();
    return endWorkerResponse(res, { ok: true, scope, accounts: accounts.length, ok2: totalOk, fail: totalFail, elapsedMs: Date.now() - started, summary });
  } catch (e) {
    stopHeartbeat();
    return endWorkerResponse(res, { ok: false, error: String(e.message || e), elapsedMs: Date.now() - started });
  }
}
