// 复盘工具：构造复盘请求 payload + 调用后端 review 模式
// 复盘结论"每只股只留最新一条"，存 planStore.reviews（云端持久化）
import { callAI } from './ai'
import { planStore } from './planStore'

// 北京时间当前分钟数 / 日key
export function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000) }
export function bjMinutes() { const d = nowBJ(); return d.getHours() * 60 + d.getMinutes() }
export function bjDayKey() { const d = nowBJ(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
export function isWeekday() { const g = nowBJ().getDay(); return g !== 0 && g !== 6 }

// 当前应生成的复盘场次：
//   noon  = 午间休市那一刻起(11:30–13:00) → 指导下午
//   close = 收盘那一刻起(15:00–收盘后一段) → 指导次日
//   null  = 非复盘时点
export function currentAutoSession() {
  if (!isWeekday()) return null
  const hm = bjMinutes()
  if (hm >= 690 && hm < 780) return 'noon'   // 11:30–13:00
  if (hm >= 900 && hm <= 990) return 'close'  // 15:00–16:30
  return null
}

// 取某股今日成交（买卖单腿 + 今日做T流水），供复盘点评当日操作
function todayTradesOf(code) {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const t0 = start.getTime()
  const s = planStore.get()
  const out = []
  ;(s.closed || []).forEach((c) => {
    if (c.code !== code) return
    const at = c.at || c.sellAt || c.buyAt || 0
    if (at < t0) return
    const type = c.type || c.kind
    if (type === 'BUY') out.push({ side: 'buy', price: c.price, qty: c.qty })
    else if (type === 'SELL' || type === 'CLOSE') out.push({ side: 'sell', price: c.sellPrice ?? c.price, qty: c.qty })
    else if (type === 'T') out.push({ side: 't', buy: c.buyPrice, sell: c.sellPrice, qty: c.qty })
  })
  // 今日未结算做T流水
  ;(s.holding || []).filter((h) => h.code === code).forEach((h) => {
    (h.tFlows || []).forEach((f) => { if (f.at >= t0) out.push({ side: f.side, price: f.price, qty: f.qty }) })
  })
  return out.slice(0, 20)
}

function tradeHistoryOf(code) {
  const s = planStore.get()
  return (s.closed || [])
    .filter((c) => c.code === code)
    .slice(0, 10)
    .map((c) => ({
      type: c.kind || c.type,
      buy: c.buyPrice != null ? +Number(c.buyPrice).toFixed(3) : null,
      sell: c.sellPrice != null ? +Number(c.sellPrice).toFixed(3) : null,
      qty: c.qty, pnl: c.netPnl != null ? +Number(c.netPnl).toFixed(0) : null,
    }))
}

// 生成一次复盘并写入 store。opts: { code, name, session, hold:{cost,qty,pnlPct}|null }
// 成功返回 review 对象，失败返回 { error }
export async function generateReview({ code, name, session, hold }) {
  if (!code) return { error: '缺少股票代码' }
  const payload = {
    code, name, session,
    hold: hold ? { cost: hold.cost, qty: hold.qty, pnlPct: hold.pnlPct } : null,
    holdCost: hold ? hold.cost : null,
    holdQty: hold ? hold.qty : null,
    todayTrades: todayTradesOf(code),
    tradeHistory: tradeHistoryOf(code),
  }
  const r = await callAI('review', payload)
  if (r.ok && r.result) {
    const review = {
      code, name, session, dayKey: bjDayKey(), at: Date.now(),
      result: r.result,
    }
    planStore.saveReview(code, review)
    return review
  }
  return { error: r.error || '复盘生成失败' }
}

// 场次中文
export function sessionLabel(s) {
  return s === 'noon' ? '午盘复盘' : s === 'close' ? '收盘复盘' : '复盘'
}

// ===== 自动复盘调度 =====
// 午间休市(11:30起)、收盘(15:00起)那一刻，对所有持仓股各生成一条复盘（每只只留最新一条）。
// 用 localStorage 标记 "已跑过的 场次" 避免重复；每场次每天只自动跑一次。
const AUTO_KEY = 'auto_review_done_v1'
function loadDone() { try { return JSON.parse(localStorage.getItem(AUTO_KEY) || '{}') } catch { return {} } }
function saveDone(o) { try { localStorage.setItem(AUTO_KEY, JSON.stringify(o)) } catch { /* ignore */ } }
function markDone(session) {
  const key = `${bjDayKey()}:${session}`
  const o = loadDone(); o[key] = Date.now(); saveDone(o)
}
function isDone(session) {
  const key = `${bjDayKey()}:${session}`
  return !!loadDone()[key]
}

let _autoRunning = false
// 检查并执行当前场次的自动复盘。quoteMap: {code: {price}} 供算浮盈亏。
// 返回是否触发了一轮自动复盘。
export async function runAutoReviewIfDue(quoteMap) {
  if (_autoRunning) return false
  const session = currentAutoSession()
  if (!session) return false
  if (isDone(session)) return false
  const holding = planStore.get().holding || []
  if (!holding.length) { markDone(session); return false }  // 无持仓也标记，避免反复检查
  _autoRunning = true
  // 先占位标记，避免多标签/多次触发；失败的单只不影响整体标记
  markDone(session)
  try {
    // 按 code 去重（同股多笔持仓合并成本）
    const byCode = new Map()
    for (const h of holding) {
      const o = byCode.get(h.code) || { code: h.code, name: h.name, qty: 0, costSum: 0 }
      o.qty += h.qty || 0
      o.costSum += (h.buyPrice || 0) * (h.qty || 0)
      byCode.set(h.code, o)
    }
    for (const o of byCode.values()) {
      const cost = o.qty ? +(o.costSum / o.qty).toFixed(3) : 0
      const price = quoteMap && quoteMap[o.code] ? quoteMap[o.code].price : null
      const pnlPct = (price && cost) ? +(((price - cost) / cost) * 100).toFixed(2) : null
      try {
        await generateReview({ code: o.code, name: o.name, session, hold: { cost, qty: o.qty, pnlPct } })
      } catch { /* 单只失败跳过 */ }
    }
    return true
  } finally {
    _autoRunning = false
  }
}

