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
    pct: state.total ? Math.round((state.done / state.total) * 100) : 0,
  }
}
export function isBatchRunning() { return state.running }
export function cancelBatch() { if (state.running) { state.cancelRequested = true; notify() } }

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

  // 初始化进度
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
