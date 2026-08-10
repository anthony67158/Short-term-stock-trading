import { useSyncExternalStore } from 'react'
import { planStore, t1StatusOf } from './planStore'
import { getAdvice } from './adviceCache'
import { api } from './apiBase'
import { confirmationPolicy } from '../shared/confirmPolicy.js'
import { applyT1ToAlert } from '../shared/t1AdvicePolicy.js'

// ============ 盯盘预警引擎 ============
// 统一轮询自选/持仓相关个股实时报价，逐条判断预警规则是否命中；
// 命中 → 浏览器通知 + 声音 + 站内红点 + 回写 planStore（自动停用避免重复）。
// 预警规则存于 planStore.alerts（随账号云端持久化）。

// 规则类型：
//   price    到价：现价 op 目标价
//   pct      涨跌幅：当日涨跌幅% op 阈值
//   vol      量比：量比 op 阈值
//   turnover 换手率%：op 阈值
//   limitup  临近涨停：涨幅 >= 9.5
//   limitdown 临近跌停：涨幅 <= -9.5
// op: gte(>=) | lte(<=)

const OP_LABEL = { gte: '≥', lte: '≤' }
export const ALERT_TYPES = [
  { key: 'price', label: '到价', unit: '元', needValue: true, needOp: true },
  { key: 'pct', label: '涨跌幅', unit: '%', needValue: true, needOp: true },
  { key: 'vol', label: '量比', unit: '', needValue: true, needOp: true },
  { key: 'turnover', label: '换手率', unit: '%', needValue: true, needOp: true },
  { key: 'limitup', label: '临近涨停', unit: '', needValue: false, needOp: false },
  { key: 'limitdown', label: '临近跌停', unit: '', needValue: false, needOp: false },
]

// 生成一条规则的可读描述
export function describeAlert(a) {
  const t = ALERT_TYPES.find((x) => x.key === a.type)
  if (!t) return ''
  if (a.type === 'limitup') return '临近涨停(涨幅≥9.5%)'
  if (a.type === 'limitdown') return '临近跌停(跌幅≥9.5%)'
  // 行动点预警(补仓/减仓):用「补仓点 ≤ X元 · 补1手」这类口径,一眼看清价位+要做什么
  if (a.type === 'price' && a.actKind) {
    const label = a.actKind === 'add' ? '补仓点' : '减仓点'
    const qty = a.opQty ? ' · ' + a.opQty : ''
    return `${label} ${OP_LABEL[a.op] || ''} ${a.value}元${qty}`
  }
  return `${t.label} ${OP_LABEL[a.op] || ''} ${a.value}${t.unit}`
}

// 到价后的"确认再动手"提示：价位预警(止盈/止损/买点/补仓/减仓)只是触发观察线，不是见价即成交。
// 依据 note/actKind 给一句时机提醒，引导用户去详情页看AI建议的"到价后怎么做"。
function confirmHint(a) {
  if (!a || a.type !== 'price') return ''
  // 行动点(补仓/减仓):带上建议里的具体确认口径(timing),没有则给通用一句
  if (a.actKind === 'add') {
    const tail = a.timing ? '：' + a.timing : '：等分时止跌/站回均价线再补，别追一瞬价。'
    return '\n🎯到操作点=开始盯，先确认再动手' + tail + ' 详情见AI建议「到价后怎么做」。'
  }
  if (a.actKind === 'reduce') {
    const tail = a.timing ? '：' + a.timing : '：反弹放量滞涨/冲高回落再减，锁定部分利润即可。'
    return '\n🎯到操作点=开始盯，先确认再动手' + tail + ' 详情见AI建议「到价后怎么做」。'
  }
  const note = a.note || ''
  if (/止损/.test(note)) return '\n⚠️到价=开始盯，别急砍：确认是否放量/收盘跌破，只是瞬时插针又拉回可先缓一手。详情见AI建议「到价后怎么做」。'
  if (/止盈/.test(note)) return '\n💡到价=开始盯，别一次清光：可先减一部分锁利，剩余用移动止盈跟着走。详情见AI建议「到价后怎么做」。'
  if (/买点/.test(note)) return '\n💡到价=开始盯，别追一瞬价：等缩量企稳/站回均线再进。详情见AI建议「到价后怎么做」。'
  return ''
}

// ============ 到价预警「距触发」可视化元数据 (A-2) ============
// 依据规则类型 + 现价 q，算出:方向语义(add/reduce/buy/up/down/warn)、可读方向名、
// 距触发百分比(仅对价位类有意义)、进度(0~100,越接近触发越满)、是否临近(≤2%)。
// 供 AlertPanel / AlertCenter 统一渲染进度条与方向徽标。
export function alertMeta(a, q) {
  // 方向语义:优先看行动点(补/减),再看 note(止盈/止损/买点),最后按 type
  let dir = 'warn', dirLabel = '预警'
  if (a.type === 'price' && a.actKind === 'add') { dir = 'add'; dirLabel = '补仓' }
  else if (a.type === 'price' && a.actKind === 'reduce') { dir = 'reduce'; dirLabel = '减仓' }
  else if (a.type === 'limitup') { dir = 'up'; dirLabel = '涨停' }
  else if (a.type === 'limitdown') { dir = 'down'; dirLabel = '跌停' }
  else if (a.type === 'price') {
    const note = a.note || ''
    if (/止盈/.test(note)) { dir = 'reduce'; dirLabel = '止盈' }
    else if (/止损/.test(note)) { dir = 'down'; dirLabel = '止损' }
    else if (/买点|买入/.test(note)) { dir = 'buy'; dirLabel = '买点' }
    else { dir = a.op === 'gte' ? 'up' : 'down'; dirLabel = a.op === 'gte' ? '涨到' : '跌到' }
  } else if (a.type === 'pct') { dir = a.op === 'gte' ? 'up' : 'down'; dirLabel = '涨跌幅' }
  else { dir = 'warn'; dirLabel = { vol: '量比', turnover: '换手' }[a.type] || '预警' }

  // 距触发:只有「价位类(type=price)」且有现价才算得出准确百分比
  let distPct = null, progress = null, near = false
  const price = q && q.price != null ? Number(q.price) : null
  if (a.type === 'price' && price != null && price > 0 && a.value != null) {
    const target = Number(a.value)
    if (target > 0) {
      // 相对现价还差多少到目标价(带方向:gte 时价要往上，lte 时价要往下)
      const raw = (target - price) / price * 100
      // 已越过触发线 → 距触发=0
      const crossed = a.op === 'gte' ? price >= target : price <= target
      distPct = crossed ? 0 : Math.abs(raw)
      // 进度:把 [10% 以外 → 0%] 映射为 [0 → 100]，越近越满(10% 视作起点，可覆盖多数波段)
      const span = 10
      progress = crossed ? 100 : Math.max(0, Math.min(100, (1 - distPct / span) * 100))
      near = !crossed && distPct <= 2   // 距触发 ≤2% 视为临近
    }
  }
  return { dir, dirLabel, distPct, progress, near, price }
}

// 交易语义 → 中文动作词(与后端 _confirm.sideOf / ACTION_ZH 同口径)
const ACTION_ZH = { buy: '买入', sell: '卖出', stop: '止损离场' }
function sideOf(a) {
  if (!a) return 'buy'
  const note = a.note || ''
  if (a.actKind === 'add') return 'buy'
  if (a.actKind === 'reduce') return 'sell'
  if (/止损/.test(note)) return 'stop'
  if (/止盈|减仓/.test(note)) return 'sell'
  if (/买点|补仓|买入/.test(note)) return 'buy'
  if (a.op === 'gte') return 'sell'
  return 'buy'
}

// 判断单条规则是否命中（q=该股实时报价）
function hit(a, q) {
  if (!q) return null
  // 数值型字段统一取有限数:接口异常/字符串/NaN 时返回 null(不判定),
  // 避免后续 .toFixed 在字符串上抛错(会中断整个 evaluate 预警循环)或渲染出字面 "NaN"。
  const fin = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
  const cmp = (v, op, target) => (op === 'lte' ? v <= target : v >= target)
  switch (a.type) {
    case 'price': {
      // 现价必须 > 0 才判定到价:休市/接口异常会返回 0,否则「≤止损价」类预警会被误触发
      const price = fin(q.price)
      if (price == null || !(price > 0)) return null
      if (cmp(price, a.op, a.value)) return `现价 ${price} ${OP_LABEL[a.op]} ${a.value}`
      return null
    }
    case 'pct': {
      const pct = fin(q.pct)
      if (pct == null) return null
      if (cmp(pct, a.op, a.value)) return `涨跌幅 ${pct.toFixed(2)}% ${OP_LABEL[a.op]} ${a.value}%`
      return null
    }
    case 'vol': {
      const volRatio = fin(q.volRatio)
      if (volRatio == null) return null
      if (cmp(volRatio, a.op, a.value)) return `量比 ${volRatio.toFixed(2)} ${OP_LABEL[a.op]} ${a.value}`
      return null
    }
    case 'turnover': {
      const turnover = fin(q.turnover)
      if (turnover == null) return null
      if (cmp(turnover, a.op, a.value)) return `换手 ${turnover.toFixed(2)}% ${OP_LABEL[a.op]} ${a.value}%`
      return null
    }
    case 'limitup': {
      const pct = fin(q.pct)
      if (pct != null && pct >= 9.5) return `${q.name || ''} 涨幅 ${pct.toFixed(2)}%，临近/触及涨停`
      return null
    }
    case 'limitdown': {
      const pct = fin(q.pct)
      if (pct != null && pct <= -9.5) return `${q.name || ''} 跌幅 ${pct.toFixed(2)}%，临近/触及跌停`
      return null
    }
    default:
      return null
  }
}

// ---- 站内通知中心状态 ----
let state = { notifications: [], unread: 0, permission: (typeof Notification !== 'undefined' ? Notification.permission : 'default') }
const listeners = new Set()
// 智能确认在途去重:记录正在请求 /api/confirm_signal 的预警 id,避免同一预警跨轮并发重复判定
const _confirming = new Set()
function emit() { state = { ...state }; listeners.forEach((l) => { try { l() } catch (e) { console.error('[store] listener error', e) } }) }

// 声音：用 WebAudio 生成短促“叮”，无需外部资源。
// ★复用单个 AudioContext:浏览器对 AudioContext 数量有上限(约 6 个),原来每次 beep 都 new 一个且不一定被
//   及时回收,频繁预警时会耗尽配额导致后续静音甚至抛错。改为惰性单例 + resume(应对自动播放策略挂起)。
let _audioCtx = null
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    if (!_audioCtx) _audioCtx = new AC()
    const ctx = _audioCtx
    if (ctx.state === 'suspended') { try { ctx.resume() } catch { /* ignore */ } }
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.connect(g); g.connect(ctx.destination)
    o.type = 'sine'; o.frequency.value = 880
    g.gain.setValueAtTime(0.001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
    o.start(); o.stop(ctx.currentTime + 0.36)
    o.onended = () => { try { o.disconnect(); g.disconnect() } catch { /* ignore */ } }  // 断开节点即可,ctx 复用不 close
  } catch { /* ignore */ }
}

function notify(title, body) {
  // 浏览器系统通知
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/favicon.svg', tag: 'alert-' + Date.now() })
    }
  } catch { /* ignore */ }
  beep()
}

export const alertStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return state },

  async requestPermission() {
    try {
      if (typeof Notification === 'undefined') return 'unsupported'
      const p = await Notification.requestPermission()
      state.permission = p; emit()
      return p
    } catch { return 'default' }
  },

  // 记录一条站内通知(去重:同一预警 30 分钟内不重复留档,避免同规则反复刷屏)
  push(n) {
    if (n && n.alertId) {
      const dup = state.notifications.find((x) => x.alertId === n.alertId && (Date.now() - (x.at || 0)) < 1800000)
      if (dup) return
    }
    state.notifications = [{ id: Date.now() + '_' + Math.random().toString(36).slice(2, 6), at: Date.now(), read: false, ...n }, ...state.notifications].slice(0, 100)
    state.unread += 1
    emit()
  },
  markAllRead() { state.notifications = state.notifications.map((x) => ({ ...x, read: true })); state.unread = 0; emit() },
  clearAll() { state.notifications = []; state.unread = 0; emit() },

  // 核心：对一批实时报价 quotes(map code→q) 跑一遍所有启用的规则
  // 智能确认(两段式,与后端 cron_alert.processAccount 同口径):
  //   · 非智能预警(手动到价/涨跌幅/量比/涨跌停,或无 phase)→ 命中即强提示 + 停用(老逻辑)。
  //   · 智能预警(价位类 + 带 phase + settings.smartConfirm!==false):
  //       armed  命中 → 发【弱提醒】(到点位·观察确认中) → 置 watching,继续监控真正时机。
  //       watching → 异步 POST /api/confirm_signal(LLM Judge 留后端) 判定:
  //         confirm → 发【强提示】(✅ 可以买入/卖出) + 置 confirmed 停用;
  //         invalid → 发【失效说明】(⛔ 已失效·暂不操作) + 置 invalid 停用;
  //         wait    → 静默维持 watching。
  //   evaluate 为同步函数;watching 的确认调用是异步「即发即忘」,不阻塞本轮遍历。
  evaluate(quoteMap) {
    const book = planStore.get()
    const smartOn = !(book.settings && book.settings.smartConfirm === false)
    const alerts = (book.alerts || []).filter((a) => a.enabled)
    if (!alerts.length) return
    // 该预警是否走智能二段确认:仅【价位类 + 带 phase(AI 派生)】;手动/涨跌幅/量比/涨跌停 → 老逻辑
    const isSmart = (a) => smartOn && a.type === 'price' && !!a.phase && a.phase !== 'confirmed' && a.phase !== 'invalid'
    for (const storedAlert of alerts) {
      const a = applyT1ToAlert(storedAlert, t1StatusOf(storedAlert.code))
      if (a.t1Blocked) continue
      const q = quoteMap[a.code]
      if (!isSmart(a)) {
        // —— 老逻辑:命中即强推并停用(向后兼容)——
        const msg = hit(a, q)
        if (!msg) continue
        const actLabel = a.actKind === 'add' ? '补仓' : (a.actKind === 'reduce' ? '减仓' : '')
        const title = actLabel
          ? `🎯 到${actLabel}操作点 · ${a.name || a.code}`
          : `⚡ 预警触发 · ${a.name || a.code}`
        const tail = confirmHint(a)
        const body = `${describeAlert(a)}｜${msg}${tail}`
        this.push({ code: a.code, name: a.name, title, body, alertId: a.id })
        notify(title, body)
        planStore.markAlertTriggered(a.id, msg) // 触发后自动停用，防重复
        continue
      }

      // —— 智能二段确认 ——
      if (a.phase === 'armed' || !a.phase) {
        // 阶段一:价格触及关键价位 → 发【弱提醒】,进入「观察确认中」,继续监控真正时机(不停用)
        const msg = hit(a, q)
        if (!msg) continue
        const side = sideOf(a)
        const actZh = ACTION_ZH[side] || '操作'
        const title = `👀 到点位·观察确认中 · ${a.name || a.code}`
        const body = `${describeAlert(a)}｜${msg}\n⏳已到${actZh}价位,但「到价≠立刻动手」。系统正在盯盘确认真正时机,确认后会再发一次「✅ 可以${actZh}」的强提示,先别急。`
        this.push({ code: a.code, name: a.name, title, body, alertId: 'watch-' + a.id })
        notify(title, body)
        planStore.markAlertWatching(a.id, msg, q && q.price)
        continue
      }

      if (a.phase === 'watching') {
        // 阶段二:异步调用智能确认闸门(LLM Judge 在后端),不阻塞本轮遍历
        this._confirmWatching(a, q)
      }
    }
  },

  // 观察确认中 → 请求后端 /api/confirm_signal 判定真正交易时机(即发即忘,带在途去重)
  _confirmWatching(a, q) {
    if (_confirming.has(a.id)) return // 同一预警上一次判定还没回来,跳过,避免并发重复请求
    const side = sideOf(a)
    const interval = side === 'stop' ? 20000 : side === 'sell' ? 30000 : 45000
    if (a.lastJudgeAt && Date.now() - a.lastJudgeAt < interval) return
    const minObserveMs = confirmationPolicy(side).minObserveMs
    if (a.watchingAt && Date.now() - a.watchingAt < minObserveMs) return
    _confirming.add(a.id)
    // ★超时护栏 + 同步异常兜底:若 fetch 同步抛错(URL 异常)或请求长时间不回,
    //   必须保证 _confirming 里的 id 最终被清除,否则该预警将永久卡在「判定中」再也无法确认。
    const ac = new AbortController()
    const timer = setTimeout(() => { try { ac.abort() } catch { /* ignore */ } }, 20000)
    const clear = () => { clearTimeout(timer); _confirming.delete(a.id) }
    try {
      const advEntry = getAdvice(a.code)
      const payload = { alert: a, advice: advEntry && advEntry.advice, quote: q }
      fetch(api('/api/confirm_signal'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      })
        .then((r) => r.json())
        .then((v) => {
          if (!v || !v.ok) return
          const side = v.side || sideOf(a)
          const actZh = ACTION_ZH[side] || '操作'
          planStore.markAlertJudged(a.id, v, q && q.price)
          if (v.decision === 'confirm') {
            const conf = v.confidence != null ? `(把握${v.confidence})` : ''
            const title = `✅ 可以${actZh} · ${a.name || a.code}`
            const body = `${describeAlert(a)}｜确认时机已到${conf}\n📌${v.reason || '多项信号共振确认'}`
            this.push({ code: a.code, name: a.name, title, body, alertId: 'confirm-' + a.id })
            notify(title, body)
            planStore.markAlertConfirmed(a.id, `确认${actZh}:${v.reason || ''}`, v, q && q.price)
          } else if (v.decision === 'invalid') {
            const title = `⛔ 已失效·暂不${actZh} · ${a.name || a.code}`
            const body = `${describeAlert(a)}｜原${actZh}逻辑已被破坏\n📌${v.reason || '关键条件已破坏,建议重新评估'}`
            this.push({ code: a.code, name: a.name, title, body, alertId: 'invalid-' + a.id })
            notify(title, body)
            planStore.markAlertInvalid(a.id, `已失效:${v.reason || ''}`)
          }
          // wait → 维持 watching,静默继续观察
        })
        .catch(() => { /* 网络/解析/超时失败 → 静默,下轮再判 */ })
        .finally(clear)
    } catch { clear() }  // fetch 同步抛错:立即清理,避免 id 永久滞留
  },
}

export function useAlertStore() {
  return useSyncExternalStore(alertStore.subscribe, alertStore.get)
}
