// 「批量一次性生成 AI 操作建议」控制器。
// 用户在自选/候选区多选(或全选)若干只股票 → 一键后台批量生成 AI 操作建议。
// 特点:
//   1) 模块级单例 + pub/sub —— 关闭面板/切 Tab 也照跑,回来还能看到实时进度(后台处理)。
//   2) 动态并发:普通模式按 advisor 端点数填槽，深度模式最多两路。
//   3) 复用与手动生成完全同源的 spec 构造(buildHoldSpec/buildWatchSpec)与后台 runner(startAdvice)。
//   4) 不做新鲜度节流:用户勾选了哪些就重生成哪些(选择权完全交给用户)。
//   5) 可取消:批次墓碑立即阻止后续派发，并协作中止在途请求。
import { planStore, computePortfolio } from './planStore'
import { getAdvice } from './adviceCache'
import { startAdvice, getRunningList, getResult, cancelAdvice } from './adviceRunner'
import { buildHoldSpec, buildWatchSpec } from './adviceDaily'
import {
  triggerServerAdvice,
  canServerAdvice,
  cancelServerAdviceBatch,
  cancelServerAdvice,
  startServerAdviceStatusSync,
} from './serverAdvice'
import { shouldApplyCloudBatch } from '../shared/adviceUiState.js'
import {
  batchConcurrency,
  generationOptions,
  validateBatchMode,
} from '../shared/adviceBatchPolicy.js'
import {
  activeAdviceCancellationTargets,
  beginAdviceCancellation,
  completeAdviceCancellation,
  settleQueuedAdviceCancellations,
} from '../shared/adviceCancellation.js'

// 本地兜底并发不再写死为 1:改为「动态并行填槽」——容量 = 端点数 − 非本批占用数,
// 谁跑完就补谁的槽,与服务端 drainAccount 的调度模型一致(见 runBatchAdvice 末尾的 worker)。

// 进度状态(单例):
//   running(bool)、total、done、ok、fail、skipped、
//   current(Set<code> 正在跑)、doneCodes(Set)、failCodes(Set)、
//   startedAt、finishedAt、cancelRequested、items([{code,name,status}])
const state = {
  running: false,
  total: 0, done: 0, ok: 0, fail: 0, skipped: 0,
  current: new Set(),
  advisorBusy: new Set(),
  items: [],           // 有序:每只 {code, name, status:'pending'|'running'|'ok'|'fail'|'skipped'}
  reviews: [],         // 独立 review 队列；不参与一次生成批次的 running/done 统计
  startedAt: 0, finishedAt: 0,
  cancelRequested: false,
  cancelError: '',
  batchId: '',
  deepMode: false,
  serverMode: false,   // true=进度来自服务端(本机点了「服务端生成」或另一设备正在生成,经云端回灌)
  _cloudAt: 0,         // 已消费的云端进度时间戳(去重/防旧盖新)
  _submissionPromise: null,
  _cancelingCodes: new Set(),
  _cancelAllRequested: false,
  _canceledBatchIds: new Set(),
  _cancelBatchPromise: null,
  _cancelOnePromises: new Map(),
  concurrency: 1,      // 并发上限=服务端 advisor 端点数(云端进度回灌覆盖;首屏由 seedConcurrency 预置)
}
const subs = new Set()
function notify() { subs.forEach((fn) => { try { fn() } catch { /* ignore */ } }) }
export function subscribeBatch(fn) { subs.add(fn); return () => subs.delete(fn) }
// 并发上限(=承接 advisor 角色的端点数)。首屏可由 /api/llm_config 预置(seedConcurrency),
// 之后随云端 batchProgress.concurrency 覆盖为权威值。
export function getConcurrency() { return Math.max(1, Number(state.concurrency) || 1) }
export function seedConcurrency(n) { const v = Math.max(1, Number(n) || 0); if (v) { state.concurrency = v; notify() } }
// 同步窥视 advisor 端点占用(供批量入口 UI 先行门控)。
// 返回 { busy:[{code,name}], concurrency, full }。full=true 表示端点已被非本批单股生成占满。
export function peekBatchBusy(excludeCodes, deepMode = false) {
  const ex = new Set((excludeCodes || []).filter(Boolean).map(String))
  const busy = advisorBusyCodes()
  const concurrency = batchConcurrency(getConcurrency(), deepMode)
  const hasNewWork = [...ex].some((code) =>
    !busy.some((item) => item.code === code)
  )
  return {
    busy,
    concurrency,
    full: hasNewWork && busy.length >= concurrency,
  }
}
// 取只读快照(current 转数组,便于组件直接用)
export function getBatchState() {
  return {
    running: state.running,
    total: state.total, done: state.done, ok: state.ok, fail: state.fail, skipped: state.skipped,
    current: [...state.current],
    advisorBusy: [...state.advisorBusy],
    items: state.items.map((x) => ({ ...x })),
    reviews: state.reviews.map((x) => ({ ...x })),
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    cancelRequested: state.cancelRequested,
    cancelError: state.cancelError,
    batchId: state.batchId,
    deepMode: state.deepMode,
    serverMode: state.serverMode,
    concurrency: getConcurrency(),
    pct: state.total ? Math.round((state.done / state.total) * 100) : 0,
  }
}
export function isBatchRunning() { return state.running }
function rememberCanceledBatch(batchId) {
  const key = String(batchId || '')
  if (!key) return
  state._canceledBatchIds.add(key)
  while (state._canceledBatchIds.size > 20) {
    state._canceledBatchIds.delete(
      state._canceledBatchIds.values().next().value,
    )
  }
}
// 取消整批:
//   · 服务端模式 → 当前批次写取消墓碑，跨批次任务按 jobId 精确取消;
//   · 本地模式 → 立即 Abort 所有在途请求并停止后续派发。
function prepareBatchCancellation() {
  const targets = activeAdviceCancellationTargets(state.items)
  for (const target of targets) state._cancelingCodes.add(target.code)
  state._cancelAllRequested = true
  rememberCanceledBatch(state.batchId)
  const canceling = beginAdviceCancellation(state.items)
  state.items = canceling.items
  state.cancelRequested = true
  state.cancelError = ''
  notify()
  return { targets, abortCodes: canceling.abortCodes }
}

function cancelLocalBatch(prepared) {
  const settled = settleQueuedAdviceCancellations(state.items)
  state.items = settled.items
  for (const code of prepared.abortCodes) cancelAdvice(code)
  state.skipped = state.items.filter((item) => item.status === 'skipped').length
  state.done = state.items.filter((item) =>
    ['ok', 'fail', 'skipped'].includes(item.status)
  ).length
  notify()
  return {
    ok: true,
    confirmed: true,
    canceled: prepared.targets.length,
  }
}

async function cancelBatchInternal() {
  if (!state.running) return { ok: true, confirmed: true, canceled: 0 }
  const prepared = prepareBatchCancellation()
  if (state.serverMode) {
    const batchId = state.batchId
    const pendingSubmission = state._submissionPromise
    if (pendingSubmission) {
      const itemSnapshot = state.items.map((item) => ({ ...item }))
      void pendingSubmission.finally(() => {
        if (!state._canceledBatchIds.has(batchId)) return
        void cancelServerAdviceBatch(batchId, itemSnapshot)
      })
    }
    const result = await cancelServerAdviceBatch(
      batchId,
      state.items,
    )
    if (result.progress) applyCloudBatch(result.progress, true)
    if (result.confirmed) {
      state.items = state.items.map((item) =>
        completeAdviceCancellation(item).item
      )
      state.skipped = state.items.filter(
        (item) => item.status === 'skipped',
      ).length
      state.done = state.items.filter((item) =>
        ['ok', 'fail', 'skipped'].includes(item.status)
      ).length
      state.current = new Set()
      state.advisorBusy = new Set()
      state.running = false
      state.finishedAt = Date.now()
      state._cancelingCodes.clear()
      state._cancelAllRequested = false
      state.cancelRequested = false
      state.cancelError = ''
      notify()
    } else {
      state.cancelError = result.error || '停止请求未确认，请重试'
      state.cancelRequested = false
      for (const item of state.items) {
        if (item.status === 'canceling') item.phase = state.cancelError
      }
      notify()
    }
    return result
  }
  return cancelLocalBatch(prepared)
}

export function cancelBatch() {
  if (state._cancelBatchPromise) return state._cancelBatchPromise
  const operation = cancelBatchInternal()
  state._cancelBatchPromise = operation
  const cleanup = () => {
    if (state._cancelBatchPromise === operation) {
      state._cancelBatchPromise = null
    }
  }
  void operation.then(cleanup, cleanup)
  return operation
}

function cancelLocalOne(key) {
  cancelAdvice(key)
  state._cancelingCodes.delete(key)
  const index = state.items.findIndex(
    (item) => String(item.code) === key,
  )
  if (index < 0) {
    return { ok: true, confirmed: true, canceled: 1 }
  }
  const item = state.items[index]
  if (['pending', 'queued'].includes(item.status)) {
    const completed = completeAdviceCancellation(item)
    state.items[index] = completed.item
    if (completed.changed) {
      state.skipped++
      state.done++
    }
  } else if (['running', 'canceling'].includes(item.status)) {
    state.items[index] = {
      ...item,
      cancelPreviousStatus: item.cancelPreviousStatus || item.status,
      status: 'canceling',
      phase: '正在取消生成',
    }
  }
  if (state.done >= state.total) {
    state.running = false
    state.finishedAt = Date.now()
  }
  notify()
  return { ok: true, confirmed: true, canceled: 1 }
}

async function cancelOneInternal(code) {
  if (!code) return { ok: true, confirmed: true, canceled: 0 }
  const key = String(code)
  let it = state.items.find((item) => String(item.code) === key)
  if (state.serverMode && it) {
    const previous = { ...it }
    state._cancelingCodes.add(key)
    it.cancelPreviousStatus = it.status
    it.status = 'canceling'
    it.phase = '正在确认停止'
    notify()
    if (state._submissionPromise) {
      try { await state._submissionPromise } catch { /* 后续按当前模式处理 */ }
    }
    if (!state.serverMode) {
      state._cancelingCodes.delete(key)
      return cancelLocalOne(key)
    }
    it = state.items.find((item) => String(item.code) === key)
    const result = await cancelServerAdvice(it ? [it] : [])
    if (result.progress) applyCloudBatch(result.progress, true)
    state._cancelingCodes.delete(key)
    if (!result.confirmed) {
      const current = state.items.find(
        (item) => String(item.code) === key,
      )
      if (current?.status === 'canceling') {
        current.status = current.cancelPreviousStatus
          || previous.status
          || 'running'
        current.phase = result.error || '停止失败，点击重试'
        delete current.cancelPreviousStatus
      }
      notify()
    }
    return result
  }
  return cancelLocalOne(key)
}

// 取消单只:云端等待权威终态，本地等待 Abort 后由原 worker 结算。
export function cancelOne(code) {
  const key = String(code || '')
  if (!key) return Promise.resolve({
    ok: true,
    confirmed: true,
    canceled: 0,
  })
  const existing = state._cancelOnePromises.get(key)
  if (existing) return existing
  const operation = cancelOneInternal(key)
  state._cancelOnePromises.set(key, operation)
  const cleanup = () => {
    if (state._cancelOnePromises.get(key) === operation) {
      state._cancelOnePromises.delete(key)
    }
  }
  void operation.then(cleanup, cleanup)
  return operation
}
// 失败重生成:把 items 里 status==='fail' 的重新入队(服务端优先)。返回重生成的只数。
export function regenerateFailed(quoteMap) {
  const failed = state.items.filter((x) => x.status === 'fail').map((x) => x.code)
  if (!failed.length) return 0
  runBatchAdvice(failed, quoteMap || {})
  return failed.length
}

// ===== 服务端批量进度回灌(跨设备同步) =====
// authStore.pull 每 45s(批量中加速)拉云端账号,把其中 data.batchProgress 喂进来。
// 这样【另一台设备上正在跑的服务端批量】,本机也能实时看到同一个进度条(手机生成、电脑同步看到)。
// 规则:
//   · 仅当云端进度的 at 比已消费的更新才应用(防旧盖新/重复渲染);
//   · 本机正在跑【本地】批量(serverMode=false 且 running)时不被云端覆盖,避免两套进度打架;
//   · finished 后 8s 由 UI 自行淡出(与本地一致)。
export function applyCloudBatch(bp, force = false) {
  if (!bp || typeof bp !== 'object') return
  const at = Number(bp.at || 0)
  const cloudBatchId = String(bp.batchId || '')
  if (
    cloudBatchId
    && state._canceledBatchIds.has(cloudBatchId)
    && (
      (bp.running && bp.batchCanceled !== true)
      || (
        state.running
        && state.batchId
        && cloudBatchId !== state.batchId
      )
    )
  ) return
  if (state.running && !state.serverMode) return           // 本机本地批量进行中 → 不打架
  if (!force && at > 0 && at <= state._cloudAt) return
  const reviews = Array.isArray(bp.reviews)
    ? bp.reviews.map((item) => ({ ...item }))
    : []
  if (!shouldApplyCloudBatch(bp)) {
    const hadVisibleBatch = state.total > 0
      || state.items.length > 0
      || state.finishedAt > 0
      || state.reviews.length > 0
    state._cloudAt = Math.max(state._cloudAt, at)
    state.serverMode = true
    state.running = false
    state.deepMode = false
    state.cancelRequested = false
    state.cancelError = ''
    state.total = 0; state.done = 0; state.ok = 0; state.fail = 0; state.skipped = 0
    state.current = new Set(); state.advisorBusy = new Set()
    state.items = []; state.reviews = reviews
    state.startedAt = 0; state.finishedAt = 0
    if (hadVisibleBatch || reviews.length) notify()
    return
  }
  if (!force && !at) return
  state._cloudAt = Math.max(state._cloudAt, at)
  state.serverMode = true
  state.cancelRequested = (
    state._cancelAllRequested
    && !state.cancelError
  )
  if (!state._cancelAllRequested) state.cancelError = ''
  state.batchId = String(bp.batchId || state.batchId || '')
  state.deepMode = !!bp.deepMode
  if (Number(bp.concurrency) > 0) state.concurrency = Number(bp.concurrency)   // 权威并发上限=服务端 advisor 端点数
  state.running = !!bp.running
  state.total = bp.total || 0
  state.done = bp.done || 0
  state.ok = bp.ok || 0
  state.fail = bp.fail || 0
  state.skipped = bp.skipped || 0
  state.current = new Set(Array.isArray(bp.current) ? bp.current : [])
  state.advisorBusy = new Set(
    Array.isArray(bp.advisorBusy)
      ? bp.advisorBusy
      : bp.current || [],
  )
  state.items = Array.isArray(bp.items) ? bp.items.map((x) => ({ ...x })) : []
  state.reviews = reviews
  for (const item of state.items) {
    if (
      state._cancelingCodes.has(String(item.code))
      && ['pending', 'queued', 'running'].includes(item.status)
    ) {
      item.cancelPreviousStatus = item.status
      item.status = 'canceling'
      item.phase = '正在确认停止'
    }
  }
  state.startedAt = bp.startedAt || at
  state.finishedAt = bp.running ? 0 : (bp.finishedAt || at)
  notify()
}

export function startBatchStatusSync() {
  startServerAdviceStatusSync(applyCloudBatch)
}

function setItemStatus(code, status) {
  const it = state.items.find((x) => x.code === code)
  if (it) it.status = status
}

// 6 小时内已有新鲜建议 → 跳过(与 adviceDaily.isFresh 同口径)
// (已按需求移除:批量生成不再做新鲜度节流,用户勾选哪些就重生成哪些)

// 「外部占用端点」= 非本批的单股生成正在占用的端点(本地 runner ∪ 服务端 current)。
// 与 adviceGate.generatingList 同口径,但直接读本模块 state 避免循环依赖。
// excludeSet:本批要生成的 code(它们进入 running 后也会出现在 getRunningList/current,须排除以免自占)。
function advisorBusyCodes() {
  const map = new Map()
  try { for (const it of getRunningList()) if (it && it.code) map.set(String(it.code), it.name || it.code) } catch { /* ignore */ }
  try { for (const c of state.advisorBusy) { const code = String(c); if (!map.has(code)) map.set(code, code) } } catch { /* ignore */ }
  return [...map.entries()].map(([code, name]) => ({ code, name }))
}

// 批量入口。
//   codes: 用户勾选的股票代码数组(来自自选/候选池)
//   quoteMap: {code:{price,...}} 供算账户/浮盈亏(可空)
//   opts: { force(bool) 保留参数占位,当前始终重生成 }
// 返回:
//   { status:'running' }                             —— 已有批量在跑(幂等,不重入)
//   { status:'empty' }                               —— 无有效 code
//   { status:'full', busy:[{code,name}], concurrency } —— 端点已被单股生成占满,拒绝启动
//   { status:'started', mode:'server'|'local' }      —— 已启动
export async function runBatchAdvice(codes, quoteMap, opts = {}) {
  if (state.running) return { status: 'running' }
  const uniq = [...new Set((codes || []).filter(Boolean))]
  const modeValidation = validateBatchMode(uniq, opts.deepMode === true)
  if (!modeValidation.ok) {
    return {
      status: modeValidation.error,
      limit: modeValidation.limit,
      count: modeValidation.count,
    }
  }
  const generation = generationOptions(modeValidation.deepMode)

  // ===== 规则:端点占用门控 =====
  // 一次性生成也要看端点占用。剔除本批自身 code 后统计「非本批单股生成」占用数:
  //   · 占满(≥端点数)→ 拒绝启动,返回 full(UI 弹「端点已满 + 正在生成清单」);
  //   · 未满 → 剩几个用几个,后续单股空出来再补(见下方本地并行池 / 服务端 drainAccount)。
  const batchSet = new Set(uniq.map(String))
  const limit = batchConcurrency(getConcurrency(), generation.deepMode)
  const busyExt = advisorBusyCodes()
  const hasNewWork = [...batchSet].some((code) =>
    !busyExt.some((item) => item.code === code)
  )
  if (hasNewWork && busyExt.length >= limit) {
    return { status: 'full', busy: busyExt, concurrency: limit }
  }

  const st = planStore.get()
  const holding = st.holding || []
  const watch = st.plan || []
  const portfolio = computePortfolio(holding, quoteMap || {}, st.account)
  const holdSet = new Set(holding.map((h) => h.code))
  const nameOf = (code) =>
    (holding.find((h) => h.code === code) || watch.find((w) => w.code === code) || {}).name || code

  // ===== 优先走【服务端生成】(已登录云端账号) =====
  // 生成搬到 FC 后端:退到后台/锁屏/关页面也照跑完(解决"退后台就生成失败"),
  // 进度写回云端 → 本机与其它设备都靠 authStore.pull 轮询同一份进度(手机生成、电脑同步看到)。
  // 立刻本地点亮一个 running 进度条(乐观 UI),真实进度随首个云端 tick 覆盖。
  if (opts.local !== true && canServerAdvice()) {
    const batchId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    state.serverMode = true
    state.running = true
    state.cancelRequested = false
    state.cancelError = ''
    state._cancelingCodes.clear()
    state._cancelAllRequested = false
    state.batchId = batchId
    state.deepMode = generation.deepMode
    state.total = uniq.length
    state.done = 0; state.ok = 0; state.fail = 0; state.skipped = 0
    state.current = new Set()
    state.advisorBusy = new Set()
    state.items = uniq.map((code) => ({
      code,
      name: nameOf(code),
      batchId,
      status: 'pending',
      phase: '正在提交云端任务',
    }))
    state.startedAt = Date.now(); state.finishedAt = 0
    state._cloudAt = 0
    notify()
    const submissionPromise = triggerServerAdvice(uniq, {
      scope: opts.scope || 'all',
      force: true,
      batchId,
      deepMode: generation.deepMode,
    })
    state._submissionPromise = submissionPromise
    let submission
    try {
      submission = await submissionPromise
    } finally {
      if (state._submissionPromise === submissionPromise) {
        state._submissionPromise = null
      }
    }
    if (
      state._canceledBatchIds.has(batchId)
      || submission?.canceled === true
    ) {
      return { status: 'canceled', mode: 'server' }
    }
    if (submission === true || submission?.ok || submission?.queued) {
      return {
        status: 'started',
        mode: 'server',
        queued: !!submission?.queued,
        error: submission?.error || '',
      }
    }
    if (submission?.code === 'ADVISOR_CAPACITY_FULL') {
      state.running = false
      state.total = 0
      state.done = 0
      state.ok = 0
      state.fail = 0
      state.skipped = 0
      state.current = new Set()
      state.advisorBusy = new Set()
      state.items = []
      state.startedAt = 0
      state.finishedAt = 0
      notify()
      return {
        status: 'full',
        mode: 'server',
        busy: Array.isArray(submission.busy)
          ? submission.busy
          : [],
        concurrency: Number(submission.concurrency) || limit,
      }
    }
    state.running = false
    notify()
  }

  // ===== 兜底:本地浏览器生成(未登录云端 / 触发失败) =====
  // 初始化进度
  state.serverMode = false
  state.running = true
  state.cancelRequested = false
  state.cancelError = ''
  state._cancelingCodes.clear()
  state._cancelAllRequested = false
  state.batchId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  state.deepMode = generation.deepMode
  state.total = uniq.length
  state.done = 0; state.ok = 0; state.fail = 0; state.skipped = 0
  state.current = new Set()
  state.advisorBusy = new Set()
  state.items = uniq.map((code) => ({ code, name: nameOf(code), status: 'pending' }))
  state.startedAt = Date.now(); state.finishedAt = 0
  notify()

  // 单只任务:构造 spec(持仓走 hold,自选走 buy)→ 后台 runner → await 完成
  const runOne = async (code) => {
    const queuedItem = state.items.find((item) => item.code === code)
    if (!queuedItem || queuedItem.status === 'skipped') return
    const name = nameOf(code)
    const spec = holdSet.has(code)
      ? buildHoldSpec(code, name, quoteMap || {}, portfolio, st.account)
      : buildWatchSpec(code, name, quoteMap || {}, portfolio, st.account)
    spec.deepMode = generation.deepMode
    state.current.add(code); state.advisorBusy.add(code)
    setItemStatus(code, 'running'); notify()
    try {
      // ★超时护栏:startAdvice 内部走 SSE,极端情况下(移动端切后台/网关半挂)可能长时间不 settle。
      //   若不设上限,该 worker 会永久卡在 await → Promise.all 永不 resolve → state.running 永远为 true
      //   → 之后所有批量都被 `if(state.running)` 挡死。给单只 180s 上限:超时即放行 worker 继续,
      //   底层生成仍在 runner 后台自行管理(不受影响),这里按结果判定为成功/失败即可。
      await Promise.race([
        startAdvice(spec),   // runner 内部落缓存/记决策;这里等它完成
        new Promise((resolve) => setTimeout(resolve, generation.timeoutMs)),
      ])
      const item = state.items.find((entry) => entry.code === code)
      if (
        item
        && (
          state.cancelRequested
          || item.status === 'canceling'
          || item.status === 'skipped'
        )
      ) {
        const index = state.items.indexOf(item)
        const completed = completeAdviceCancellation(item)
        state.items[index] = completed.item
        if (completed.changed) state.skipped++
        return
      }
      // ★成功判定★ 直接读本次运行的权威结果(runner 的 results),不再用脆弱的「60 秒新鲜度」:
      //   · 有 advice/result 且无 error → ok(真成功)
      //   · runner 记了 error → fail(真失败,如实上报,绝不假成功)
      //   · 本地中断已转云端(pending) → 记 ok(云端会继续跑完并回灌;不算失败,避免误报)
      //   · 兜底:results 里没有 → 回看 adviceCache 是否落了新鲜建议
      const res = getResult(code)
      let good
      if (res) {
        if (res.pending) good = true
        else if (res.error) good = false
        else good = !!(res.advice || res.result)
      } else {
        const a = getAdvice(code, spec.mode)
        good = !!(a && a.at && (Date.now() - a.at) < 5 * 60 * 1000)
      }
      setItemStatus(code, good ? 'ok' : 'fail')
      good ? state.ok++ : state.fail++
    } catch {
      const item = state.items.find((entry) => entry.code === code)
      if (
        item
        && (
          state.cancelRequested
          || item.status === 'canceling'
          || item.status === 'skipped'
        )
      ) {
        const index = state.items.indexOf(item)
        const completed = completeAdviceCancellation(item)
        state.items[index] = completed.item
        if (completed.changed) state.skipped++
      } else {
        setItemStatus(code, 'fail'); state.fail++
      }
    } finally {
      state.current.delete(code); state.advisorBusy.delete(code)
      state.done++; notify()
    }
  }

  // ===== 并行填槽池(镜像服务端 drainAccount) =====
  // 容量 = 端点数 − 非本批单股生成占用数(至少 1)。谁跑完就补谁的槽,把整批做完;
  // 单股生成结束、端点空出后本方法内的下一轮 while 会自动取到更多任务(容量在循环内动态复算)。
  let cursor = 0
  const drainMarkSkipped = () => {
    while (cursor < uniq.length) {
      const c = uniq[cursor++]
      const it = state.items.find((x) => x.code === c)
      if (it && it.status === 'pending') { it.status = 'skipped'; state.skipped++; state.done++ }
    }
    notify()
  }
  const worker = async () => {
    while (cursor < uniq.length) {
      if (state.cancelRequested) { drainMarkSkipped(); break }
      const code = uniq[cursor++]
      const item = state.items.find((entry) => entry.code === code)
      if (!item || item.status === 'skipped') continue
      await runOne(code)
    }
  }
  // 首轮并行度 = 端点数 − 已被单股生成占用的端点(动态复算,至少 1);随单只跑完自然补槽。
  const modeConcurrency = batchConcurrency(getConcurrency(), generation.deepMode)
  const freeSlots = Math.max(1, modeConcurrency - advisorBusyCodes().length)
  const poolSize = Math.min(freeSlots, uniq.length)
  const workers = Array.from({ length: poolSize }, () => worker())
  try {
    await Promise.all(workers)
  } finally {
    // ★无论 worker 是否抛错,都必须复位 running,否则整个批量入口会被永久锁死。
    state.running = false
    state.cancelRequested = false
    state._cancelAllRequested = false
    state._cancelingCodes.clear()
    state.finishedAt = Date.now()
    notify()
  }
  return { status: 'started', mode: 'local' }
}
