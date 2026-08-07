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
import { startAdvice } from './adviceRunner'
import { buildHoldSpec, buildWatchSpec } from './adviceDaily'
import { triggerServerAdvice, canServerAdvice, cancelServerAdvice } from './serverAdvice'

const CONCURRENCY = 1                 // 串行:一次只生成一只,确保每只都完整生成完再下一只

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
}
const subs = new Set()
function notify() { subs.forEach((fn) => { try { fn() } catch { /* ignore */ } }) }
export function subscribeBatch(fn) { subs.add(fn); return () => subs.delete(fn) }
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

// 批量入口。
//   codes: 用户勾选的股票代码数组(来自自选/候选池)
//   quoteMap: {code:{price,...}} 供算账户/浮盈亏(可空)
//   opts: { force(bool) 保留参数占位,当前始终重生成 }
// 返回 Promise,批量全部结束后 resolve。已在跑 → 直接返回(幂等,不重入)。
export async function runBatchAdvice(codes, quoteMap, opts = {}) {
  if (state.running) return false
  const uniq = [...new Set((codes || []).filter(Boolean))]
  if (!uniq.length) return false

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
      return true
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
      // 判定成功:缓存里出现了新鲜建议
      const a = getAdvice(code)
      const good = !!(a && a.at && (Date.now() - a.at) < 60 * 1000)
      setItemStatus(code, good ? 'ok' : 'fail')
      good ? state.ok++ : state.fail++
    } catch {
      setItemStatus(code, 'fail'); state.fail++
    } finally {
      state.current.delete(code); state.done++; notify()
    }
  }

  // 并发限流:维护一个游标,最多 CONCURRENCY 个 worker 同时取任务
  let cursor = 0
  const worker = async () => {
    while (cursor < uniq.length) {
      if (state.cancelRequested) {
        // 取消:把剩余未开始的直接标记 skipped
        while (cursor < uniq.length) {
          const c = uniq[cursor++]
          const it = state.items.find((x) => x.code === c)
          if (it && it.status === 'pending') { it.status = 'skipped'; state.skipped++; state.done++ }
        }
        notify()
        break
      }
      const code = uniq[cursor++]
      await runOne(code)
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, uniq.length) }, () => worker())
  await Promise.all(workers)

  state.running = false
  state.finishedAt = Date.now()
  notify()
  return true
}
