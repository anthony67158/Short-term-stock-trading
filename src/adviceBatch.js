// 「批量一次性生成 AI 操作建议」控制器。
// 用户在自选/候选区多选(或全选)若干只股票 → 一键后台批量生成 AI 操作建议。
// 特点:
//   1) 模块级单例 + pub/sub —— 关闭面板/切 Tab 也照跑,回来还能看到实时进度(后台处理)。
//   2) 串行生成(CONCURRENCY=1):一次只生成一只,且每只都完整生成完再进行下一只,避免半成品/打爆网关配额。
//   3) 复用与手动生成完全同源的 spec 构造(buildHoldSpec/buildWatchSpec)与后台 runner(startAdvice)。
//   4) 不做新鲜度节流:用户勾选了哪些就重生成哪些(选择权完全交给用户)。
//   5) 可取消:cancel() 停止派发后续任务(已在途的那批跑完即止)。
import { planStore, computePortfolio } from './planStore'
import { getAdvice } from './adviceCache'
import { startAdvice, getRunningList, getResult } from './adviceRunner'
import { buildHoldSpec, buildWatchSpec } from './adviceDaily'
import { triggerServerAdvice, canServerAdvice, cancelServerAdvice } from './serverAdvice'

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
  items: [],           // 有序:每只 {code, name, status:'pending'|'running'|'ok'|'fail'|'skipped'}
  startedAt: 0, finishedAt: 0,
  cancelRequested: false,
  serverMode: false,   // true=进度来自服务端(本机点了「服务端生成」或另一设备正在生成,经云端回灌)
  _cloudAt: 0,         // 已消费的云端进度时间戳(去重/防旧盖新)
  concurrency: 1,      // 并发上限=服务端 advisor 端点数(云端进度回灌覆盖;首屏由 seedConcurrency 预置)
}
const subs = new Set()
function notify() { subs.forEach((fn) => { try { fn() } catch { /* ignore */ } }) }
export function subscribeBatch(fn) { subs.add(fn); return () => subs.delete(fn) }
// 并发上限(=承接 advisor 角色的端点数)。首屏可由 /api/llm_config 预置(seedConcurrency),
// 之后随云端 batchProgress.concurrency 覆盖为权威值。
export function getConcurrency() { return Math.max(1, Number(state.concurrency) || 1) }
export function seedConcurrency(n) { const v = Math.max(1, Number(n) || 0); if (v) { state.concurrency = v; notify() } }
// 同步窥视端点占用(供批量入口 UI 先行门控)。excludeCodes=本批要生成的 code(须排除自占)。
// 返回 { busy:[{code,name}], concurrency, full }。full=true 表示端点已被非本批单股生成占满。
export function peekBatchBusy(excludeCodes) {
  const ex = new Set((excludeCodes || []).filter(Boolean).map(String))
  const busy = externalBusyCodes(ex)
  const concurrency = getConcurrency()
  return { busy, concurrency, full: busy.length >= concurrency }
}
// 取只读快照(current 转数组,便于组件直接用)
export function getBatchState() {
  return {
    running: state.running,
    total: state.total, done: state.done, ok: state.ok, fail: state.fail, skipped: state.skipped,
    current: [...state.current],
    items: state.items.map((x) => ({ ...x })),
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    cancelRequested: state.cancelRequested,
    serverMode: state.serverMode,
    concurrency: getConcurrency(),
    pct: state.total ? Math.round((state.done / state.total) * 100) : 0,
  }
}
export function isBatchRunning() { return state.running }
// 取消整批:
//   · 服务端模式 → 通知 FC 取消全部活跃任务(queued 立即取消、running 协作式停),状态经云端回灌;
//   · 本地模式 → 置 cancelRequested,已在途那只跑完即止。
export function cancelBatch() {
  if (!state.running) return
  if (state.serverMode) { cancelServerAdvice([]); state.cancelRequested = true; notify(); return }
  state.cancelRequested = true; notify()
}
// 取消单只(服务端模式):只取消这一只,其余继续。乐观地把该项标记为 skipped,真实态随云端回灌覆盖。
export function cancelOne(code) {
  if (!code) return
  if (state.serverMode) cancelServerAdvice([String(code)])
  const it = state.items.find((x) => x.code === code)
  if (it && (it.status === 'pending' || it.status === 'running')) { it.status = 'skipped'; notify() }
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
export function applyCloudBatch(bp) {
  if (!bp || typeof bp !== 'object') return
  const at = Number(bp.at || 0)
  if (!at || at <= state._cloudAt) return                 // 不是更新的进度 → 忽略
  if (state.running && !state.serverMode) return           // 本机本地批量进行中 → 不打架
  state._cloudAt = at
  state.serverMode = true
  if (Number(bp.concurrency) > 0) state.concurrency = Number(bp.concurrency)   // 权威并发上限=服务端 advisor 端点数
  state.running = !!bp.running
  state.total = bp.total || 0
  state.done = bp.done || 0
  state.ok = bp.ok || 0
  state.fail = bp.fail || 0
  state.skipped = bp.skipped || 0
  state.current = new Set(Array.isArray(bp.current) ? bp.current : [])
  state.items = Array.isArray(bp.items) ? bp.items.map((x) => ({ ...x })) : []
  state.startedAt = bp.startedAt || at
  state.finishedAt = bp.running ? 0 : (bp.finishedAt || at)
  notify()
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
function externalBusyCodes(excludeSet) {
  const map = new Map()
  try { for (const it of getRunningList()) if (it && it.code) map.set(String(it.code), it.name || it.code) } catch { /* ignore */ }
  try { for (const c of state.current) { const code = String(c); if (!map.has(code)) map.set(code, code) } } catch { /* ignore */ }
  if (excludeSet) for (const c of excludeSet) map.delete(String(c))
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
  if (!uniq.length) return { status: 'empty' }

  // ===== 规则:端点占用门控 =====
  // 一次性生成也要看端点占用。剔除本批自身 code 后统计「非本批单股生成」占用数:
  //   · 占满(≥端点数)→ 拒绝启动,返回 full(UI 弹「端点已满 + 正在生成清单」);
  //   · 未满 → 剩几个用几个,后续单股空出来再补(见下方本地并行池 / 服务端 drainAccount)。
  const batchSet = new Set(uniq.map(String))
  const limit = getConcurrency()
  const busyExt = externalBusyCodes(batchSet)
  if (busyExt.length >= limit) return { status: 'full', busy: busyExt, concurrency: limit }

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
    const fired = triggerServerAdvice(uniq, { scope: opts.scope || 'all', force: true })
    if (fired) {
      state.serverMode = true
      state.running = true
      state.cancelRequested = false
      state.total = uniq.length
      state.done = 0; state.ok = 0; state.fail = 0; state.skipped = 0
      state.current = new Set()
      state.items = uniq.map((code) => ({ code, name: nameOf(code), status: 'pending' }))
      state.startedAt = Date.now(); state.finishedAt = 0
      state._cloudAt = 0   // 允许后续云端 tick 覆盖这份乐观占位
      notify()
      return { status: 'started', mode: 'server' }
    }
  }

  // ===== 兜底:本地浏览器生成(未登录云端 / 触发失败) =====
  // 初始化进度
  state.serverMode = false
  state.running = true
  state.cancelRequested = false
  state.total = uniq.length
  state.done = 0; state.ok = 0; state.fail = 0; state.skipped = 0
  state.current = new Set()
  state.items = uniq.map((code) => ({ code, name: nameOf(code), status: 'pending' }))
  state.startedAt = Date.now(); state.finishedAt = 0
  notify()

  // 单只任务:构造 spec(持仓走 hold,自选走 buy)→ 后台 runner → await 完成
  const runOne = async (code) => {
    if (state.cancelRequested) { setItemStatus(code, 'skipped'); state.skipped++; state.done++; notify(); return }
    const name = nameOf(code)
    const spec = holdSet.has(code)
      ? buildHoldSpec(code, name, quoteMap || {}, portfolio, st.account)
      : buildWatchSpec(code, name, quoteMap || {}, portfolio, st.account)
    state.current.add(code); setItemStatus(code, 'running'); notify()
    try {
      await startAdvice(spec)   // runner 内部落缓存/记决策;这里等它完成
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
        const a = getAdvice(code)
        good = !!(a && a.at && (Date.now() - a.at) < 5 * 60 * 1000)
      }
      setItemStatus(code, good ? 'ok' : 'fail')
      good ? state.ok++ : state.fail++
    } catch {
      setItemStatus(code, 'fail'); state.fail++
    } finally {
      state.current.delete(code); state.done++; notify()
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
      await runOne(code)
    }
  }
  // 首轮并行度 = 端点数 − 已被单股生成占用的端点(动态复算,至少 1);随单只跑完自然补槽。
  const freeSlots = Math.max(1, getConcurrency() - externalBusyCodes(batchSet).length)
  const poolSize = Math.min(freeSlots, uniq.length)
  const workers = Array.from({ length: poolSize }, () => worker())
  await Promise.all(workers)

  state.running = false
  state.finishedAt = Date.now()
  notify()
  return { status: 'started', mode: 'local' }
}
