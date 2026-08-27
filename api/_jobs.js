// ============ 服务端「AI 操作建议」持久任务表(生命周期 / 断点续跑 / 防重 / 取消)============
// 背景/为什么存在:
//   原先生成"任务"只活在一次浏览器 SSE 或一次 FC 请求里——页面切后台/FC 超时崩溃 → 任务丢失,
//   无状态、无重试、无取消、点两次起两份。本模块把"任务"沉到账号的角色队列(OSS 持久),
//   服务端为唯一权威源;phone+PC 都汇入同一状态机 → 跨端天然一致、角色容量天然隔离。
//
// 数据结构(挂在 acc.data 下,不动用户的 plan/holding/closed/account):
//   data.jobs       = { [code]: Job }         // advisor:单股/一次生成
//   data.reviewJobs = { [code]: Job }         // review:定时/Judge/后续复核
//   data.jobWorker  = { id, lockUntil }       // 单协调器锁；执行容量按角色分别计算
//
// Job:
//   { id, role('advisor'|'review'), resourceRole, code, name, mode,
//     status('queued'|'running'|'done'|'failed'|'canceled'),
//     attempts, maxAttempts, at, startedAt, finishedAt, leaseUntil, error, source, cancelRequested }
//
// 生命周期:
//   enqueue → queued → (worker 领取)running(带 lease)→ done | failed(可重试回 queued)| canceled
//   断点续跑:running 但 leaseUntil < now(FC 崩了没续租)→ 视为孤儿 → 回收成 queued,下次 drain 重跑。
//   防重:同 role + code 已有 queued/running 活跃任务 → enqueue 复用；advisor/review 互不覆盖。
import {
  generationOptions,
  isCompleteAdviceEntry,
} from '../shared/adviceBatchPolicy.js';

export const CONCURRENCY = Number(process.env.ADVICE_CONCURRENCY || 3); // 全局并发上限【默认/回退】(运行时优先按承接 advisor 角色的端点数,见 cron_advice.js)
export const LEASE_MS = 270 * 1000;      // 单只运行租约:大于批量单股 225s 护栏；Worker 每 20s 续租，中断后约 4.5 分钟可回收
export const LOCK_TTL_MS = 60 * 1000;    // Worker 锁 TTL:drainer 周期续租;崩溃后此后过期,他人接管
export const MAX_ATTEMPTS = 3;           // 失败最多重试次数
const JOB_TTL_MS = 24 * 3600 * 1000;     // 终态任务保留 24h 后清理(避免无限堆积)
const BATCH_CANCEL_TTL_MS = 24 * 3600 * 1000;
const ADVICE_AUTO_PAUSE_MS = 30 * 60 * 1000;
const EVENT_KEY_TTL_MS = 24 * 3600 * 1000;
const EVENT_KEY_LIMIT = 1000;

const ACTIVE = new Set(['queued', 'running']);
const REVIEW_SOURCES = new Set([
  'auto',
  'cron',
  'judge',
  'review',
  'scheduled',
]);
export const isActive = (j) => !!(j && ACTIVE.has(j.status));

function effectiveJobMaxAttempts(job) {
  return generationOptions(job?.deepMode === true).maxAttempts;
}

export function adviceJobRole(job = {}) {
  if (job?.role === 'review') return 'review';
  if (job?.role === 'advisor') return 'advisor';
  if (
    job?.mode === 'review'
    || REVIEW_SOURCES.has(String(job?.source || ''))
  ) return 'review';
  return 'advisor';
}

function jobStamp(job) {
  return Math.max(
    Number(job?.progressAt) || 0,
    Number(job?.finishedAt) || 0,
    Number(job?.startedAt) || 0,
    Number(job?.at) || 0,
  );
}

function ensureJobTables(data) {
  if (!data.jobs || typeof data.jobs !== 'object') data.jobs = {};
  if (
    !data.reviewJobs
    || typeof data.reviewJobs !== 'object'
    || Array.isArray(data.reviewJobs)
  ) data.reviewJobs = {};
  for (const [key, job] of Object.entries(data.jobs)) {
    if (!job || adviceJobRole(job) !== 'review') continue;
    const code = String(job.code || key);
    const current = data.reviewJobs[code];
    if (!current || jobStamp(job) >= jobStamp(current)) {
      data.reviewJobs[code] = {
        ...job,
        role: 'review',
        resourceRole: job.resourceRole || 'review',
      };
    }
    delete data.jobs[key];
  }
  for (const job of Object.values(data.jobs)) {
    if (job && !job.role) job.role = 'advisor';
  }
  for (const job of Object.values(data.reviewJobs)) {
    if (job && !job.role) job.role = 'review';
  }
}

function eventKeysOf(data) {
  if (
    !data.adviceEventKeys
    || typeof data.adviceEventKeys !== 'object'
    || Array.isArray(data.adviceEventKeys)
  ) data.adviceEventKeys = {};
  return data.adviceEventKeys;
}

function gcAdviceEventKeys(data, now = Date.now()) {
  const keys = eventKeysOf(data);
  for (const [key, at] of Object.entries(keys)) {
    if (now - (Number(at) || 0) > EVENT_KEY_TTL_MS) delete keys[key];
  }
  const entries = Object.entries(keys)
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  for (const [key] of entries.slice(EVENT_KEY_LIMIT)) delete keys[key];
}

function eventKeySeen(data, key, now = Date.now()) {
  const normalized = String(key || '').trim();
  if (!normalized) return false;
  gcAdviceEventKeys(data, now);
  return Number(eventKeysOf(data)[normalized]) > 0;
}

function rememberEventKey(data, key, now = Date.now()) {
  const normalized = String(key || '').trim();
  if (!normalized) return;
  eventKeysOf(data)[normalized] = Number(now) || Date.now();
  gcAdviceEventKeys(data, now);
}

// 运行中但租约已过期 → 孤儿(FC 崩了/被回收)
export function isOrphan(j, now = Date.now()) {
  return !!(j && j.status === 'running' && (j.leaseUntil || 0) < now);
}

// 取任务表(惰性初始化,不覆盖已有)
export function jobsOf(data) {
  ensureJobTables(data);
  return data.jobs;
}

export function reviewJobsOf(data) {
  ensureJobTables(data);
  return data.reviewJobs;
}

export function allAdviceJobs(data) {
  return [
    ...Object.values(jobsOf(data)),
    ...Object.values(reviewJobsOf(data)),
  ].filter(Boolean);
}

function jobTable(data, role) {
  return role === 'review' ? reviewJobsOf(data) : jobsOf(data);
}

export function findAdviceJob(
  data,
  code,
  {
    role = '',
    jobId = '',
  } = {},
) {
  const targetCode = String(code || '');
  if (role) {
    const candidate = jobTable(data, role)[targetCode] || null;
    if (!jobId) return candidate;
    return String(candidate?.id || '') === String(jobId)
      ? candidate
      : null;
  }
  if (jobId) {
    const found = allAdviceJobs(data).find((job) =>
      String(job?.id || '') === String(jobId)
    );
    return found || null;
  }
  return jobsOf(data)[targetCode]
    || reviewJobsOf(data)[targetCode]
    || null;
}

function batchCancellationsOf(data) {
  if (
    !data.adviceBatchCancellations
    || typeof data.adviceBatchCancellations !== 'object'
  ) data.adviceBatchCancellations = {};
  return data.adviceBatchCancellations;
}

function gcAdviceBatchCancellations(data, now = Date.now()) {
  const cancellations = batchCancellationsOf(data);
  for (const [batchId, canceledAt] of Object.entries(cancellations)) {
    if (now - (Number(canceledAt) || 0) > BATCH_CANCEL_TTL_MS) {
      delete cancellations[batchId];
    }
  }
}

export function markAdviceBatchCanceled(
  data,
  batchId,
  now = Date.now(),
) {
  const key = String(batchId || '').trim().slice(0, 100);
  if (!key) return false;
  const cancellations = batchCancellationsOf(data);
  cancellations[key] = Math.max(
    Number(cancellations[key]) || 0,
    Number(now) || Date.now(),
  );
  gcAdviceBatchCancellations(data, now);
  return true;
}

export function isAdviceBatchCanceled(
  data,
  batchId,
  now = Date.now(),
) {
  const key = String(batchId || '').trim();
  if (!key) return false;
  const canceledAt = Number(
    data?.adviceBatchCancellations?.[key],
  );
  return Number.isFinite(canceledAt)
    && canceledAt > 0
    && now - canceledAt <= BATCH_CANCEL_TTL_MS;
}

export function mergeAdviceBatchCancellations(
  target,
  source,
  now = Date.now(),
) {
  const merged = batchCancellationsOf(target);
  for (const [batchId, canceledAt] of Object.entries(
    source?.adviceBatchCancellations || {},
  )) {
    merged[batchId] = Math.max(
      Number(merged[batchId]) || 0,
      Number(canceledAt) || 0,
    );
  }
  gcAdviceBatchCancellations(target, now);
  let canceled = 0;
  for (const job of Object.values(jobsOf(target))) {
    if (
      isActive(job)
      && job.batchId
      && isAdviceBatchCanceled(target, job.batchId, now)
      && cancelJob(
        target,
        job.code,
        now,
        job.batchId,
        job.id,
        adviceJobRole(job),
      )
    ) canceled++;
  }
  return canceled;
}

// 当前"占用槽位"的任务数:running 且租约未过期。孤儿不计(已可被回收)。
export function runningCount(data, now = Date.now(), role = '') {
  let n = 0;
  for (const j of allAdviceJobs(data)) {
    if (
      j
      && j.status === 'running'
      && (j.leaseUntil || 0) >= now
      && (!role || adviceJobRole(j) === role)
    ) n++;
  }
  return n;
}

// 回收孤儿:running 且租约过期 → 未达上限则回退 queued；达到上限则失败，避免无限从头重跑。
export function reapOrphans(data, now = Date.now()) {
  let n = 0;
  for (const j of allAdviceJobs(data)) {
    if (isOrphan(j, now)) {
      const maxAttempts = effectiveJobMaxAttempts(j);
      j.maxAttempts = maxAttempts;
      if ((j.attempts || 0) >= maxAttempts) {
        j.status = 'failed'; j.finishedAt = now; j.leaseUntil = 0;
        j.resourceRole = 'none'; j.resourceUnits = 0;
        j.error = '任务连续中断，已停止自动重试';
        j.phase = '生成中断次数过多';
      } else {
        j.status = 'queued'; j.leaseUntil = 0; j.error = '(中断,自动续跑)';
        j.resourceRole = adviceJobRole(j); j.resourceUnits = 1;
        j.phase = '任务中断，等待云端自动续跑';
      }
      j.progressAt = now; n++;
    }
  }
  return n;
}

// 清理终态老任务(done/failed/canceled 且超过 TTL)
export function gcJobs(data, now = Date.now()) {
  for (const jobs of [jobsOf(data), reviewJobsOf(data)]) {
    for (const [code, j] of Object.entries(jobs)) {
      if (!j) { delete jobs[code]; continue; }
      if (!ACTIVE.has(j.status) && (now - (j.finishedAt || j.at || 0)) > JOB_TTL_MS) delete jobs[code];
    }
  }
  gcAdviceBatchCancellations(data, now);
  gcAdviceEventKeys(data, now);
}

// 入队一只。dedup:同 code 已有活跃任务时始终返回既有任务；终态任务可以重建。
// 这样刷新后重复点击不会把 running 覆盖回 queued，避免任务永远在排队。
// mode 由调用方按持仓/自选判定。返回 { job, created(bool) }。
export function enqueueJob(data, {
  code, name, mode, source = 'ondemand', batchId = '', deepMode = false,
  batchRequest = false, trigger = null, idempotencyKey = '', role = '',
}, now = Date.now()) {
  if (
    batchRequest
    && batchId
    && isAdviceBatchCanceled(data, batchId, now)
  ) {
    return {
      job: null,
      created: false,
      canceled: true,
      deferred: false,
    };
  }
  const resolvedRole = adviceJobRole({ role, source, mode });
  const jobs = jobTable(data, resolvedRole);
  const cur = jobs[code];
  const eventKey = String(idempotencyKey || '').trim().slice(0, 180);
  if (
    eventKey
    && (
      eventKeySeen(data, eventKey, now)
      || cur?.idempotencyKey === eventKey
      || cur?.pendingTrigger?.idempotencyKey === eventKey
    )
  ) {
    return {
      job: cur || null,
      created: false,
      canceled: false,
      deferred: false,
      replayed: true,
    };
  }
  if (cur && isActive(cur)) {
    if (trigger && typeof trigger === 'object') {
      if (cur.status === 'queued') {
        const generation = generationOptions(false);
        cur.source = 'judge';
        cur.trigger = trigger;
        cur.at = Math.max(Number(cur.at) || 0, Number(trigger.at) || now);
        cur.maxAttempts = generation.maxAttempts;
        cur.deepMode = false;
        cur.batchRequest = false;
        cur.batchId = '';
        cur.phase = '军师执行确认已触发，等待复核';
        cur.progressAt = now;
        cur.idempotencyKey = eventKey;
        return { job: cur, created: false, deferred: false };
      }
      const previousAt = Number(cur.pendingTrigger?.at) || 0;
      if ((Number(trigger.at) || now) >= previousAt) {
        cur.pendingTrigger = {
          ...trigger,
          idempotencyKey: eventKey,
        };
      }
      return { job: cur, created: false, deferred: true };
    }
    return { job: cur, created: false, deferred: false };
  }
  const generation = generationOptions(deepMode);
  const job = {
    id: `${resolvedRole === 'review' ? 'review_' : ''}${code}_${now}`,
    role: resolvedRole,
    resourceRole: resolvedRole,
    resourceUnits: 1,
    code, name: name || code, mode: mode || 'buy_advice',
    status: 'queued',
    attempts: 0, maxAttempts: generation.maxAttempts,
    at: now, startedAt: 0, finishedAt: 0, leaseUntil: 0,
    error: '', source, cancelRequested: false,
    batchId: String(batchId || ''),
    idempotencyKey: eventKey,
    deepMode: generation.deepMode,
    batchRequest: !!batchRequest,
    ...(trigger && typeof trigger === 'object' ? { trigger } : {}),
    stage: 'queued',
    phase: resolvedRole === 'review'
      ? '排队等待云端复核'
      : '排队等待云端生成',
    sources: [], reasoning: '', quant: null, model: '', endpoint: '', progressAt: now,
  };
  jobs[code] = job;
  return { job, created: true };
}

// 领取一只 queued 任务 → running,占用租约。调用前须已确认有空槽。
export function leaseJob(
  data,
  code,
  now = Date.now(),
  role = '',
  jobId = '',
) {
  const j = findAdviceJob(data, code, { role, jobId });
  if (!j || j.status !== 'queued') return null;
  j.status = 'running';
  j.stage = 'preparing';
  j.resourceRole = adviceJobRole(j);
  j.resourceUnits = 1;
  j.attempts = (j.attempts || 0) + 1;
  j.maxAttempts = effectiveJobMaxAttempts(j);
  j.startedAt = j.startedAt || now;
  j.leaseUntil = now + LEASE_MS;
  j.error = '';
  j.phase = '正在准备分析';
  j.progressAt = now;
  return j;
}

// 续租(drainer 周期调用,防止长任务被误判孤儿)
export function renewLease(
  data,
  code,
  now = Date.now(),
  role = '',
  jobId = '',
) {
  const j = findAdviceJob(data, code, { role, jobId });
  if (j && j.status === 'running') j.leaseUntil = now + LEASE_MS;
}

function visibleChineseReasoning(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /[\u4e00-\u9fff]/.test(line))
  const text = lines.join('\n')
  if (text.length <= 6000) return text
  return `${text.slice(0, 800)}\n…\n${text.slice(-5197)}`
}

export function updateJobProgress(
  data,
  code,
  patch = {},
  now = Date.now(),
  role = '',
  jobId = '',
) {
  const job = findAdviceJob(data, code, { role, jobId })
  if (!job) return null
  if (['done', 'failed', 'canceled'].includes(job.status)) return job
  if (patch.stage != null) {
    job.stage = String(patch.stage).slice(0, 40)
  }
  if (patch.phase != null) job.phase = String(patch.phase).slice(0, 160)
  if (Array.isArray(patch.sources)) {
    job.sources = patch.sources.slice(-12).map((source) => ({
      label: String(source?.label || '').slice(0, 60),
      ok: !!source?.ok,
    }))
  }
  if (patch.reasoning != null) job.reasoning = visibleChineseReasoning(patch.reasoning)
  if (patch.quant && typeof patch.quant === 'object') {
    job.quant = {
      summary: String(patch.quant.summary || '').slice(0, 300),
    }
  }
  if (patch.model != null) job.model = String(patch.model).slice(0, 100)
  if (patch.endpoint != null) job.endpoint = String(patch.endpoint).slice(0, 120)
  if (['advisor', 'review', 'none'].includes(patch.resourceRole)) {
    job.resourceRole = patch.resourceRole
  }
  if (Number.isFinite(Number(patch.resourceUnits))) {
    job.resourceUnits = Math.max(0, Number(patch.resourceUnits))
  }
  job.progressAt = now
  return job
}

export function completeJob(
  data,
  code,
  now = Date.now(),
  {
    evidenceAsOf = 0,
    planRevision = 0,
    role = '',
    jobId = '',
  } = {},
) {
  const j = findAdviceJob(data, code, { role, jobId });
  if (!j) return { status: 'missing', publish: false, jobId: '' };
  rememberEventKey(data, j.idempotencyKey, now);
  const pendingTrigger = j.pendingTrigger;
  if (pendingTrigger && typeof pendingTrigger === 'object') {
    const pendingAt = Number(pendingTrigger.at) || 0;
    const pendingRevision = Number(pendingTrigger.planRevision) || 0;
    const coveredByEvidence = (
      Number(evidenceAsOf) > 0
      && pendingAt > 0
      && pendingAt <= Number(evidenceAsOf)
    );
    const coveredByPlan = (
      Number(planRevision) > 0
      && pendingRevision > 0
      && pendingRevision >= Number(planRevision)
    );
    if (coveredByEvidence || coveredByPlan) {
      rememberEventKey(data, pendingTrigger.idempotencyKey, now);
      j.pendingTrigger = null;
      j.status = 'done';
      j.finishedAt = now;
      j.leaseUntil = 0;
      j.error = '';
      j.stage = 'done';
      j.resourceRole = 'none';
      j.resourceUnits = 0;
      j.phase = '生成完成';
      j.progressAt = now;
      return {
        status: 'done',
        publish: true,
        jobId: j.id || '',
      };
    }
    const triggerAt = Number(pendingTrigger.at) || now;
    Object.assign(j, {
      id: `${code}_${now}_judge`,
      status: 'queued',
      attempts: 0,
      at: triggerAt,
      startedAt: 0,
      finishedAt: 0,
      leaseUntil: 0,
      error: '',
      source: 'judge',
      role: 'review',
      resourceRole: 'review',
      resourceUnits: 1,
      cancelRequested: false,
      batchId: '',
      deepMode: false,
      batchRequest: false,
      stage: 'queued',
      phase: '军师执行确认已触发，等待复核',
      sources: [],
      reasoning: '',
      quant: null,
      model: '',
      endpoint: '',
      progressAt: now,
      trigger: pendingTrigger,
      idempotencyKey: pendingTrigger.idempotencyKey || '',
      pendingTrigger: null,
    });
    return {
      status: 'requeued',
      publish: false,
      jobId: j.id || '',
    };
  }
  j.status = 'done'; j.stage = 'done'; j.finishedAt = now; j.leaseUntil = 0; j.error = '';
  j.resourceRole = 'none'; j.resourceUnits = 0;
  j.phase = '生成完成'; j.progressAt = now;
  return {
    status: 'done',
    publish: true,
    jobId: j.id || '',
  };
}

// 失败:还有重试次数 → 回 queued(下次 drain 重跑);否则 failed 终态。
export function failJob(
  data,
  code,
  err,
  now = Date.now(),
  role = '',
  jobId = '',
) {
  const j = findAdviceJob(data, code, { role, jobId });
  if (!j) return;
  j.error = String(err || '生成失败');
  const maxAttempts = effectiveJobMaxAttempts(j);
  j.maxAttempts = maxAttempts;
  if ((j.attempts || 0) < maxAttempts) {
    j.status = 'queued'; j.stage = 'retrying'; j.leaseUntil = 0; j.resourceRole = adviceJobRole(j); j.resourceUnits = 1; j.phase = `生成失败，准备第${(j.attempts || 0) + 1}次重试`; j.progressAt = now;
  } else {
    j.status = 'failed'; j.stage = 'failed'; j.finishedAt = now; j.leaseUntil = 0; j.resourceRole = 'none'; j.resourceUnits = 0; j.phase = '生成失败'; j.progressAt = now;
  }
}

// 取消一只:立即进入 canceled 终态并释放租约。Worker 看到 cancelRequested 后中止上游请求并丢弃结果。
export function cancelJob(
  data,
  code,
  now = Date.now(),
  batchId = '',
  jobId = '',
  role = '',
) {
  const j = findAdviceJob(data, code, { role, jobId });
  if (!j || !isActive(j)) return false;
  if (batchId && j.batchId !== batchId) return false;
  if (jobId && j.id !== jobId) return false;
  j.cancelRequested = true;
  j.status = 'canceled';
  j.finishedAt = now;
  j.leaseUntil = 0;
  j.resourceRole = 'none';
  j.resourceUnits = 0;
  j.phase = '已取消生成';
  j.progressAt = now;
  return true;
}

// 取消全部活跃任务
export function cancelAll(
  data,
  now = Date.now(),
  batchId = '',
  cancelBefore = now,
) {
  const jobs = jobsOf(data);
  const cutoff = Math.min(
    Number(cancelBefore) || Number(now) || Date.now(),
    Number(now) || Date.now(),
  );
  const cancellable = Object.values(jobs).filter((job) =>
    isActive(job)
    && (
      String(job.batchId || '') === String(batchId || '')
      || Number(job.at || job.startedAt || 0) <= cutoff
    )
  );
  const canceledBatchIds = new Set(
    cancellable
      .map((job) => String(job?.batchId || '').trim())
      .filter(Boolean),
  );
  if (batchId) canceledBatchIds.add(String(batchId).trim());
  if (batchId) {
    data.adviceAutoPauseUntil = Math.max(
      Number(data.adviceAutoPauseUntil) || 0,
      Number(now) + ADVICE_AUTO_PAUSE_MS,
    );
  }
  for (const canceledBatchId of canceledBatchIds) {
    markAdviceBatchCanceled(data, canceledBatchId, now);
  }
  let n = 0;
  for (const job of cancellable) {
    if (
      cancelJob(
        data,
        job.code,
        now,
        '',
        job.id,
        'advisor',
      )
    ) n++;
  }
  return n;
}

// ---- Worker 锁:保证同一时刻只有一个 drainer(干净的全局限流)----
// 返回 true=拿到锁;false=已有他人持锁(未过期)。myId 用于释放/续租校验。
export function acquireWorkerLock(data, myId, now = Date.now()) {
  const w = data.jobWorker;
  if (w && w.id && w.id !== myId && (w.lockUntil || 0) > now) return false;
  data.jobWorker = { id: myId, lockUntil: now + LOCK_TTL_MS };
  return true;
}
export function renewWorkerLock(data, myId, now = Date.now()) {
  const w = data.jobWorker;
  if (w && w.id === myId) w.lockUntil = now + LOCK_TTL_MS;
}
export function releaseWorkerLock(data, myId) {
  const w = data.jobWorker;
  if (w && w.id === myId) data.jobWorker = { id: '', lockUntil: 0 };
}
export function workerHeldByOther(data, myId, now = Date.now()) {
  const w = data.jobWorker;
  return !!(w && w.id && w.id !== myId && (w.lockUntil || 0) > now);
}

// 有无可做的活儿(queued 或可回收的孤儿)
export function hasPendingWork(data, now = Date.now()) {
  for (const j of allAdviceJobs(data)) {
    if (j && (j.status === 'queued' || isOrphan(j, now))) return true;
  }
  return false;
}

export function needsWorkerDispatch(data, now = Date.now()) {
  if (!hasPendingWork(data, now)) return false;
  const worker = data?.jobWorker;
  return !(
    worker
    && worker.id
    && (worker.lockUntil || 0) > now
  );
}

export function compareAdviceJobs(left, right) {
  const priority = (job) => {
    if (job?.source === 'judge') return 0
    if (job?.source === 'ondemand' && job?.batchRequest === true) return 1
    if (job?.source === 'ondemand') return 2
    return 3
  }
  return priority(left) - priority(right)
    || (Number(left?.at) || 0) - (Number(right?.at) || 0)
}

function resourceRoleOf(job) {
  const explicit = String(job?.resourceRole || '');
  if (['advisor', 'review', 'none'].includes(explicit)) return explicit;
  return adviceJobRole(job);
}

function resourceUnitsOf(job) {
  const units = Number(job?.resourceUnits);
  return Number.isFinite(units) && units >= 0 ? units : 1;
}

export function resourcePatchForJobProgress(
  job,
  stage,
) {
  if (adviceJobRole(job) === 'review') {
    return { resourceRole: 'review', resourceUnits: 1 };
  }
  if (stage === 'finalize') {
    return { resourceRole: 'none', resourceUnits: 0 };
  }
  if (stage) {
    return { resourceRole: 'advisor', resourceUnits: 1 };
  }
  return {};
}

export function roleCapacityUsage(
  data,
  role,
  now = Date.now(),
) {
  return allAdviceJobs(data).reduce((total, job) => {
    if (
      job?.status !== 'running'
      || (job.leaseUntil || 0) < now
      || resourceRoleOf(job) !== role
    ) return total;
    return total + resourceUnitsOf(job);
  }, 0);
}

export function selectStartableJobs(
  data,
  capacities = {},
  inflightJobIds = new Set(),
  now = Date.now(),
) {
  const used = {
    advisor: roleCapacityUsage(data, 'advisor', now),
    review: roleCapacityUsage(data, 'review', now),
  };
  const limits = {
    advisor: Math.max(0, Number(capacities.advisor) || 0),
    review: Math.max(0, Number(capacities.review) || 0),
  };
  const selected = [];
  for (const job of allAdviceJobs(data)
    .filter((item) =>
      item?.status === 'queued'
      && !item.cancelRequested
      && !inflightJobIds.has(String(item.id || ''))
    )
    .sort(compareAdviceJobs)) {
    const role = adviceJobRole(job);
    if (used[role] >= limits[role]) continue;
    selected.push(job);
    used[role] += 1;
  }
  return selected;
}

export function advisorAdmission(
  data,
  codes,
  capacity,
  now = Date.now(),
) {
  const requested = new Set((codes || []).map(String));
  const active = allAdviceJobs(data).filter((job) =>
    job?.status === 'running'
    && adviceJobRole(job) === 'advisor'
    && resourceRoleOf(job) === 'advisor'
    && !isOrphan(job, now)
  );
  const hasNewWork = [...requested].some((code) =>
    !active.some((job) => String(job.code) === code)
  );
  const limit = Math.max(1, Number(capacity) || 1);
  return {
    accepted: !hasNewWork || roleCapacityUsage(
      data,
      'advisor',
      now,
    ) < limit,
    running: roleCapacityUsage(data, 'advisor', now),
    capacity: limit,
    busy: active.map((job) => ({
      code: String(job.code || ''),
      name: String(job.name || job.code || ''),
      jobId: String(job.id || ''),
    })),
  };
}

export function shouldContinueAdviceWorker(data, now = Date.now()) {
  return hasPendingWork(data, now)
}

// 生成对旧前端兼容的 batchProgress 快照(老逻辑仍消费 data.batchProgress)。
// running/total/done/ok/fail/skipped/items([{code,name,status}])/startedAt/finishedAt/at/source/concurrency
// concurrency:本轮生效的并发上限(运行时由承接 advisor 角色的端点数决定;前端据此做单股触发门控)。
export function jobsToProgress(data, now = Date.now(), concurrency = CONCURRENCY) {
  const advisorJobs = Object.values(jobsOf(data)).filter(Boolean);
  const reviewJobs = Object.values(reviewJobsOf(data)).filter(Boolean);
  // 当前批次的终态 + 所有跨批次活跃任务都必须可见。否则连续点击不同个股时，
  // activeAdviceBatchId 会让先启动的任务从前端消失，看起来像被后一次点击取消。
  const activeBatchId = String(data.activeAdviceBatchId || '');
  const recent = activeBatchId
    ? advisorJobs.filter((j) => j.batchId === activeBatchId || isActive(j))
    : advisorJobs.filter((j) => (now - (j.at || 0)) < 6 * 3600 * 1000);
  const recentReviews = reviewJobs.filter((job) =>
    isActive(job) || (now - (job.at || 0)) < 6 * 3600 * 1000
  );
  const hasPublishedAdvice = (job) => {
    if (job?.status !== 'done') return true;
    return isCompleteAdviceEntry(
      data?.advice?.[String(job.code || '')],
      job.mode,
    );
  };
  const mapStatus = (job) => {
    if (job.cancelRequested && job.status === 'running') return 'canceling';
    return job.status === 'done'
      ? (hasPublishedAdvice(job) ? 'ok' : 'publishing')
      : job.status === 'failed' ? 'fail'
        : job.status === 'canceled' ? 'skipped'
          : job.status;
  };
  const mapItem = (j) => {
    const status = mapStatus(j);
    const publishing = status === 'publishing';
    return {
    code: j.code,
    jobId: j.id || '',
    batchId: j.batchId || '',
    name: j.name,
    role: adviceJobRole(j),
    source: j.source || '',
    status,
    error: j.error || '',
    warning: j.dailyReportWarning || '',
    stage: publishing ? 'finalize' : (j.stage || ''),
    phase: publishing
      ? '正在核验并发布最终结论'
      : (j.phase || ''),
    sources: Array.isArray(j.sources) ? j.sources : [],
    reasoning: j.reasoning || '',
    quant: j.quant || null,
    model: j.model || '',
    endpoint: j.endpoint || '',
    progressAt: j.progressAt || j.at || 0,
    attempts: j.attempts || 0,
    deepMode: !!j.deepMode,
    batchRequest: !!j.batchRequest,
    };
  };
  const items = recent
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .map(mapItem);
  const reviews = recentReviews
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .map(mapItem);
  const publishing = recent.filter((j) => mapStatus(j) === 'publishing');
  const ok = recent.filter((j) => mapStatus(j) === 'ok').length;
  const fail = recent.filter((j) => j.status === 'failed').length;
  const skipped = recent.filter((j) => j.status === 'canceled').length;
  const active = [
    ...recent.filter((j) => isActive(j)),
    ...publishing,
  ];
  const current = recent
    .filter((j) => j.status === 'running' || mapStatus(j) === 'publishing')
    .map((j) => j.code);
  const advisorBusy = recent
    .filter((job) =>
      job.status === 'running'
      && resourceRoleOf(job) === 'advisor'
    )
    .map((job) => job.code);
  const total = recent.length;
  const done = ok + fail + skipped;
  const snapshotAt = recent.reduce(
    (latest, j) => Math.max(latest, j.progressAt || 0, j.finishedAt || 0, j.at || 0),
    0,
  );
  const reviewSnapshotAt = recentReviews.reduce(
    (latest, job) => Math.max(
      latest,
      job.progressAt || 0,
      job.finishedAt || 0,
      job.at || 0,
    ),
    0,
  );
  const finishedAt = active.length
    ? 0
    : recent.reduce((latest, j) => Math.max(latest, j.finishedAt || 0), 0);
  const progressBatchId = activeBatchId
    || recent.reduce((latest, job) =>
      !latest || (job.at || 0) >= (latest.at || 0)
        ? job
        : latest
    , null)?.batchId
    || '';
  return {
    running: active.length > 0,
    total, done, ok, fail, skipped,
    current,
    advisorBusy,
    items,
    reviewRunning: recentReviews.some((job) =>
      job.status === 'running' || mapStatus(job) === 'publishing'
    ),
    reviewCurrent: recentReviews
      .filter((job) =>
        job.status === 'running' || mapStatus(job) === 'publishing'
      )
      .map((job) => job.code),
    reviews,
    startedAt: recent.reduce((m, j) => Math.min(m || Infinity, j.at || Infinity), 0) || 0,
    finishedAt: finishedAt || snapshotAt,
    at: Math.max(snapshotAt, reviewSnapshotAt),
    source: 'server',
    batchId: progressBatchId,
    batchCanceled: isAdviceBatchCanceled(data, progressBatchId, now),
    deepMode: recent.some((job) => !!job.deepMode),
    concurrency: Math.max(1, Number(concurrency) || CONCURRENCY),
  };
}
