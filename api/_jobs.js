// ============ 服务端「AI 操作建议」持久任务表(生命周期 / 断点续跑 / 防重 / 取消)============
// 背景/为什么存在:
//   原先生成"任务"只活在一次浏览器 SSE 或一次 FC 请求里——页面切后台/FC 超时崩溃 → 任务丢失,
//   无状态、无重试、无取消、点两次起两份。本模块把"任务"沉到账号 data.jobs(OSS 持久),
//   服务端为唯一权威源;phone+PC 都汇入同一张表 → 跨端天然一致、并发上限天然共享。
//
// 数据结构(挂在 acc.data 下,不动用户的 plan/holding/closed/account):
//   data.jobs      = { [code]: Job }         // 每 code 一条"当前任务"(天然防重:同 code 不并存两个活跃任务)
//   data.jobWorker = { id, lockUntil }       // 单 Worker 锁:同一时刻只有一个 drainer,干净地全局限流
//
// Job:
//   { id, code, name, mode('hold_advice'|'buy_advice'),
//     status('queued'|'running'|'done'|'failed'|'canceled'),
//     attempts, maxAttempts, at, startedAt, finishedAt, leaseUntil, error, source, cancelRequested }
//
// 生命周期:
//   enqueue → queued → (worker 领取)running(带 lease)→ done | failed(可重试回 queued)| canceled
//   断点续跑:running 但 leaseUntil < now(FC 崩了没续租)→ 视为孤儿 → 回收成 queued,下次 drain 重跑。
//   防重:同 code 已有 queued/running 活跃任务 → enqueue 复用,不新建(除非 force 重生成)。

export const CONCURRENCY = Number(process.env.ADVICE_CONCURRENCY || 3); // 全局并发上限【默认/回退】(运行时优先按承接 advisor 角色的端点数,见 cron_advice.js)
export const LEASE_MS = 200 * 1000;      // 单只运行租约:超过未续租视为孤儿,回收重跑(genOne 内部预算 150s)
export const LOCK_TTL_MS = 60 * 1000;    // Worker 锁 TTL:drainer 周期续租;崩溃后此后过期,他人接管
export const MAX_ATTEMPTS = 3;           // 失败最多重试次数
const JOB_TTL_MS = 24 * 3600 * 1000;     // 终态任务保留 24h 后清理(避免无限堆积)

const ACTIVE = new Set(['queued', 'running']);
export const isActive = (j) => !!(j && ACTIVE.has(j.status));

// 运行中但租约已过期 → 孤儿(FC 崩了/被回收)
export function isOrphan(j, now = Date.now()) {
  return !!(j && j.status === 'running' && (j.leaseUntil || 0) < now);
}

// 取任务表(惰性初始化,不覆盖已有)
export function jobsOf(data) {
  if (!data.jobs || typeof data.jobs !== 'object') data.jobs = {};
  return data.jobs;
}

// 当前"占用槽位"的任务数:running 且租约未过期。孤儿不计(已可被回收)。
export function runningCount(data, now = Date.now()) {
  const jobs = jobsOf(data);
  let n = 0;
  for (const j of Object.values(jobs)) if (j && j.status === 'running' && (j.leaseUntil || 0) >= now) n++;
  return n;
}

// 回收孤儿:running 且租约过期 → 回退 queued(保留 attempts,等待重跑)。返回回收数量。
export function reapOrphans(data, now = Date.now()) {
  const jobs = jobsOf(data);
  let n = 0;
  for (const j of Object.values(jobs)) {
    if (isOrphan(j, now)) {
      j.status = 'queued'; j.leaseUntil = 0; j.error = '(中断,自动续跑)'; n++;
    }
  }
  return n;
}

// 清理终态老任务(done/failed/canceled 且超过 TTL)
export function gcJobs(data, now = Date.now()) {
  const jobs = jobsOf(data);
  for (const [code, j] of Object.entries(jobs)) {
    if (!j) { delete jobs[code]; continue; }
    if (!ACTIVE.has(j.status) && (now - (j.finishedAt || j.at || 0)) > JOB_TTL_MS) delete jobs[code];
  }
}

// 入队一只。dedup:同 code 已有活跃任务且未 force → 返回既有任务(不新建,防重复提交)。
// mode 由调用方按持仓/自选判定。返回 { job, created(bool) }。
export function enqueueJob(data, { code, name, mode, source = 'ondemand', force = false }, now = Date.now()) {
  const jobs = jobsOf(data);
  const cur = jobs[code];
  if (cur && isActive(cur) && !force) return { job: cur, created: false };
  const job = {
    id: `${code}_${now}`,
    code, name: name || code, mode: mode || 'buy_advice',
    status: 'queued',
    attempts: 0, maxAttempts: MAX_ATTEMPTS,
    at: now, startedAt: 0, finishedAt: 0, leaseUntil: 0,
    error: '', source, cancelRequested: false,
  };
  jobs[code] = job;
  return { job, created: true };
}

// 领取一只 queued 任务 → running,占用租约。调用前须已确认有空槽。
export function leaseJob(data, code, now = Date.now()) {
  const jobs = jobsOf(data);
  const j = jobs[code];
  if (!j || j.status !== 'queued') return null;
  j.status = 'running';
  j.attempts = (j.attempts || 0) + 1;
  j.startedAt = j.startedAt || now;
  j.leaseUntil = now + LEASE_MS;
  j.error = '';
  return j;
}

// 续租(drainer 周期调用,防止长任务被误判孤儿)
export function renewLease(data, code, now = Date.now()) {
  const j = jobsOf(data)[code];
  if (j && j.status === 'running') j.leaseUntil = now + LEASE_MS;
}

export function completeJob(data, code, now = Date.now()) {
  const j = jobsOf(data)[code];
  if (!j) return;
  j.status = 'done'; j.finishedAt = now; j.leaseUntil = 0; j.error = '';
}

// 失败:还有重试次数 → 回 queued(下次 drain 重跑);否则 failed 终态。
export function failJob(data, code, err, now = Date.now()) {
  const j = jobsOf(data)[code];
  if (!j) return;
  j.error = String(err || '生成失败');
  if ((j.attempts || 0) < (j.maxAttempts || MAX_ATTEMPTS)) {
    j.status = 'queued'; j.leaseUntil = 0;   // 重试
  } else {
    j.status = 'failed'; j.finishedAt = now; j.leaseUntil = 0;
  }
}

// 取消一只:queued → 直接 canceled;running → 置 cancelRequested(drainer 协作式在下一步前停)。
export function cancelJob(data, code, now = Date.now()) {
  const j = jobsOf(data)[code];
  if (!j || !isActive(j)) return false;
  if (j.status === 'queued') { j.status = 'canceled'; j.finishedAt = now; j.leaseUntil = 0; }
  else { j.cancelRequested = true; }
  return true;
}

// 取消全部活跃任务
export function cancelAll(data, now = Date.now()) {
  const jobs = jobsOf(data);
  let n = 0;
  for (const code of Object.keys(jobs)) if (isActive(jobs[code])) { cancelJob(data, code, now); n++; }
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
  const jobs = jobsOf(data);
  for (const j of Object.values(jobs)) {
    if (j && (j.status === 'queued' || isOrphan(j, now))) return true;
  }
  return false;
}

// 生成对旧前端兼容的 batchProgress 快照(老逻辑仍消费 data.batchProgress)。
// running/total/done/ok/fail/skipped/items([{code,name,status}])/startedAt/finishedAt/at/source/concurrency
// concurrency:本轮生效的并发上限(运行时由承接 advisor 角色的端点数决定;前端据此做单股触发门控)。
export function jobsToProgress(data, now = Date.now(), concurrency = CONCURRENCY) {
  const jobs = jobsOf(data);
  const arr = Object.values(jobs).filter(Boolean);
  // 只统计"本轮相关"的:近 6h 内有活动的任务(避免历史 done 混入总数)
  const recent = arr.filter((j) => (now - (j.at || 0)) < 6 * 3600 * 1000);
  const mapStatus = (s) => (s === 'done' ? 'ok' : s === 'failed' ? 'fail' : s === 'canceled' ? 'skipped' : s); // queued/running 原样
  const items = recent
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .map((j) => ({ code: j.code, name: j.name, status: mapStatus(j.status), error: j.error || '' }));
  const ok = recent.filter((j) => j.status === 'done').length;
  const fail = recent.filter((j) => j.status === 'failed').length;
  const skipped = recent.filter((j) => j.status === 'canceled').length;
  const active = recent.filter((j) => isActive(j));
  const current = recent.filter((j) => j.status === 'running').map((j) => j.code);
  const total = recent.length;
  const done = ok + fail + skipped;
  return {
    running: active.length > 0,
    total, done, ok, fail, skipped,
    current,
    items,
    startedAt: recent.reduce((m, j) => Math.min(m || Infinity, j.at || Infinity), 0) || now,
    finishedAt: active.length ? 0 : now,
    at: now,
    source: 'server',
    concurrency: Math.max(1, Number(concurrency) || CONCURRENCY),
  };
}
