import { useSyncExternalStore } from 'react'
import { planStore } from './planStore'

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
  return `${t.label} ${OP_LABEL[a.op] || ''} ${a.value}${t.unit}`
}

// 判断单条规则是否命中（q=该股实时报价）
function hit(a, q) {
  if (!q) return null
  const cmp = (v, op, target) => (op === 'lte' ? v <= target : v >= target)
  switch (a.type) {
    case 'price': {
      // 现价必须 > 0 才判定到价:休市/接口异常会返回 0,否则「≤止损价」类预警会被误触发
      if (q.price == null || !(Number(q.price) > 0)) return null
      if (cmp(q.price, a.op, a.value)) return `现价 ${q.price} ${OP_LABEL[a.op]} ${a.value}`
      return null
    }
    case 'pct': {
      if (q.pct == null) return null
      if (cmp(q.pct, a.op, a.value)) return `涨跌幅 ${q.pct.toFixed(2)}% ${OP_LABEL[a.op]} ${a.value}%`
      return null
    }
    case 'vol': {
      if (q.volRatio == null) return null
      if (cmp(q.volRatio, a.op, a.value)) return `量比 ${q.volRatio.toFixed(2)} ${OP_LABEL[a.op]} ${a.value}`
      return null
    }
    case 'turnover': {
      if (q.turnover == null) return null
      if (cmp(q.turnover, a.op, a.value)) return `换手 ${q.turnover.toFixed(2)}% ${OP_LABEL[a.op]} ${a.value}%`
      return null
    }
    case 'limitup':
      if (q.pct != null && q.pct >= 9.5) return `${q.name || ''} 涨幅 ${q.pct.toFixed(2)}%，临近/触及涨停`
      return null
    case 'limitdown':
      if (q.pct != null && q.pct <= -9.5) return `${q.name || ''} 跌幅 ${q.pct.toFixed(2)}%，临近/触及跌停`
      return null
    default:
      return null
  }
}

// ---- 站内通知中心状态 ----
let state = { notifications: [], unread: 0, permission: (typeof Notification !== 'undefined' ? Notification.permission : 'default') }
const listeners = new Set()
function emit() { state = { ...state }; listeners.forEach((l) => l()) }

// 声音：用 WebAudio 生成短促“叮”，无需外部资源
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.connect(g); g.connect(ctx.destination)
    o.type = 'sine'; o.frequency.value = 880
    g.gain.setValueAtTime(0.001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
    o.start(); o.stop(ctx.currentTime + 0.36)
    o.onended = () => ctx.close()
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

  // 记录一条站内通知
  push(n) {
    state.notifications = [{ id: Date.now() + '_' + Math.random().toString(36).slice(2, 6), at: Date.now(), read: false, ...n }, ...state.notifications].slice(0, 100)
    state.unread += 1
    emit()
  },
  markAllRead() { state.notifications = state.notifications.map((x) => ({ ...x, read: true })); state.unread = 0; emit() },
  clearAll() { state.notifications = []; state.unread = 0; emit() },

  // 核心：对一批实时报价 quotes(map code→q) 跑一遍所有启用的规则
  evaluate(quoteMap) {
    const book = planStore.get()
    const alerts = (book.alerts || []).filter((a) => a.enabled)
    if (!alerts.length) return
    for (const a of alerts) {
      const q = quoteMap[a.code]
      const msg = hit(a, q)
      if (msg) {
        const title = `⚡ 预警触发 · ${a.name || a.code}`
        const body = `${describeAlert(a)}｜${msg}`
        this.push({ code: a.code, name: a.name, title, body, alertId: a.id })
        notify(title, body)
        planStore.markAlertTriggered(a.id, msg) // 触发后自动停用，防重复
      }
    }
  },
}

export function useAlertStore() {
  return useSyncExternalStore(alertStore.subscribe, alertStore.get)
}
