// 复盘工具：构造复盘请求 payload + 调用后端 review 模式
// 复盘结论"每只股只留最新一条"，存 planStore.reviews（云端持久化）
import { callAI, callAIStream } from './ai'
import { planStore, livePositionOf, computeTFlows } from './planStore'

// 北京时间当前分钟数 / 日key
export function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000) }
export function bjMinutes() { const d = nowBJ(); return d.getHours() * 60 + d.getMinutes() }
export function bjDayKey() { const d = nowBJ(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
export function isWeekday() { const g = nowBJ().getDay(); return g !== 0 && g !== 6 }

// A股法定节假日(闭市)——每年初可补充维护；用于"下一交易日"计算，避免"明天开盘"落在周末/假期
const A_SHARE_HOLIDAYS = new Set([
  // 2026(示例，按实际公布调整)
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-06', '2026-05-01', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
])
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
// 从今天(北京时间)算下一个交易日：跳过周末与已知节假日
export function nextTradingDay() {
  const d = nowBJ(); d.setHours(0, 0, 0, 0)
  for (let i = 1; i <= 12; i++) {
    const n = new Date(d.getTime() + i * 86400000)
    const g = n.getDay()
    if (g === 0 || g === 6) continue
    if (A_SHARE_HOLIDAYS.has(ymd(n))) continue
    return n
  }
  return new Date(d.getTime() + 86400000)
}
// 下一交易日的友好标签：如"下周一(08-03)"/"明天(08-01)"
export function nextTradingDayLabel() {
  const today = nowBJ(); today.setHours(0, 0, 0, 0)
  const nt = nextTradingDay()
  const diffDays = Math.round((nt.getTime() - today.getTime()) / 86400000)
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][nt.getDay()]
  const md = `${String(nt.getMonth() + 1).padStart(2, '0')}-${String(nt.getDate()).padStart(2, '0')}`
  if (diffDays === 1) return `明天(${wk} ${md})`
  return `下一交易日${wk}(${md})`
}

// 当前应生成的复盘场次：
//   noon  = 午间休市那一刻起(11:30–13:00) → 指导下午
//   close = 收盘后(15:00 起，一直到当天结束/次日盘前) → 指导次日
//   null  = 非复盘时点(盘前、盘中)
export function currentAutoSession() {
  if (!isWeekday()) return null
  const hm = bjMinutes()
  if (hm >= 690 && hm < 780) return 'noon'    // 11:30–13:00 午间
  if (hm >= 900) return 'close'               // 15:00 之后(收盘~当天结束)都可补生成，不再限 16:30
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

// 账户资产(总资产/可用现金/目标资产)——供 AI 算补仓金额、仓位占比、预期收益、以终为始节奏
function acctInfo() {
  const a = planStore.get().account || {}
  return {
    totalAssets: a.totalAssets ?? null,
    cash: a.cash ?? null,
    goal: a.goal ?? null,
    // 目标缺口/所需涨幅：让复盘也能"以终为始"，据离目标远近调仓位节奏(不凌驾止损)
    goalGap: (a.goal != null && a.goal > 0 && a.totalAssets != null) ? +(a.goal - a.totalAssets).toFixed(2) : null,
    goalReturnPct: (a.goal != null && a.goal > 0 && a.totalAssets > 0) ? +(((a.goal - a.totalAssets) / a.totalAssets) * 100).toFixed(1) : null,
  }
}

// 生成一次复盘并写入 store。opts: { code, name, session, hold:{cost,qty,pnlPct}|null, onPhase? }
// onPhase({text}) 存在时走流式，把数据采集进度实时回调；成功返回 review 对象，失败返回 { error }
export async function generateReview({ code, name, session, hold, onPhase }) {
  if (!code) return { error: '缺少股票代码' }
  const payload = {
    code, name, session,
    hold: hold ? { cost: hold.cost, qty: hold.qty, pnlPct: hold.pnlPct } : null,
    holdCost: hold ? hold.cost : null,
    holdQty: hold ? hold.qty : null,
    openTNet: hold ? (hold.openTNet || 0) : 0,   // 未结算做T净手数(正=已净加仓/负=已净减仓)
    nextTradeDay: nextTradingDayLabel(),          // 真实下一交易日(跳过周末/节假日)，避免"明天"落在周末
    account: acctInfo(),                           // 账户总资产/可用，用于算仓位占比与补仓金额
    todayTrades: todayTradesOf(code),
    tradeHistory: tradeHistoryOf(code),
  }
  const r = onPhase ? await callAIStream('review', payload, onPhase) : await callAI('review', payload)
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

// 某只持仓是否"今天还没有复盘"(用于"补生成"只补缺口，不重复覆盖已有)
export function isReviewMissingToday(code) {
  const review = (planStore.get().reviews || {})[code]
  return !review || review.dayKey !== bjDayKey()
}
// 今天缺复盘的持仓只数(供按钮显示"补 N 只"或在全部就绪时禁用)
export function missingReviewCount() {
  const holding = planStore.get().holding || []
  const codes = [...new Set(holding.map((h) => h.code))]
  return codes.filter((c) => isReviewMissingToday(c)).length
}

let _autoRunning = false
// 对持仓股逐只按【实时持仓】口径生成复盘。返回 {ok, fail, skipped}。供自动调度 + 手动补生成共用。
// opts.onlyMissing=true 时只对"今天还没有复盘"的持仓生成(补缺口，不覆盖已有)——用于顶部"补生成"按钮，
// 与单卡上的"重生成"(强制覆盖单只)职责分离，消除重复。
async function reviewAllHoldings(session, quoteMap, opts = {}) {
  const onlyMissing = !!opts.onlyMissing
  const holding = planStore.get().holding || []
  const codes = [...new Set(holding.map((h) => h.code))]
  let ok = 0, fail = 0, skipped = 0
  for (const code of codes) {
    if (onlyMissing && !isReviewMissingToday(code)) { skipped++; continue }
    const name = (holding.find((h) => h.code === code) || {}).name || code
    const price = quoteMap && quoteMap[code] ? quoteMap[code].price : null
    const lp = livePositionOf(code)  // {qty,cost,hasOpenT,tNetHands} 或 null(底仓被反T卖光)
    let cost, qty, openTNet
    if (lp) {
      cost = lp.cost; qty = lp.qty; openTNet = lp.hasOpenT ? lp.tNetHands : 0
    } else {
      // 反T(先卖后买)把底仓全部卖出、尚未接回→实时可卖持仓为0。不能跳过,否则用户看不到"该接回"的指导。
      // 用底仓成本作参考,holdQty=0,openTNet为负,让复盘去指导接回/加仓而非"继续持有"。
      const hs = holding.filter((h) => h.code === code)
      let tNet = 0, baseCostSum = 0, baseQtySum = 0
      for (const h of hs) {
        const rr = computeTFlows(h.tFlows)
        tNet += (rr.openBuy || 0) - (rr.openSell || 0)
        baseCostSum += (h.buyPrice || 0) * (h.qty || 0); baseQtySum += (h.qty || 0)
      }
      if (tNet >= 0) continue  // 非"卖光未接回"场景(真的空仓)才跳过
      cost = baseQtySum > 0 ? +(baseCostSum / baseQtySum).toFixed(3) : null
      qty = 0; openTNet = tNet
    }
    const pnlPct = (price && cost) ? +(((price - cost) / cost) * 100).toFixed(2) : null
    try {
      // 关键:必须走流式(传 onPhase)。批量复盘逐只串行,慢票(如涨停+反T要重分析,可耗时60~90s)
      // 用非流式 callAI 会被网关/浏览器空闲超时静默掐断→"只有最慢的那只没复盘成功"(泰坦股份复现)。
      // 流式期间后端持续发 phase 心跳事件,连接不空闲,慢票也能跑完。onProgress 供上层回显进度。
      const onPhase = opts.onProgress ? (p) => opts.onProgress(code, name, p) : () => {}
      let r = await generateReview({ code, name, session, hold: { cost, qty, pnlPct, openTNet }, onPhase })
      // 慢票偶发失败(超时/网络抖动)再重试一次:批量场景下"只有一只没成功"多是瞬时问题,重试即可救回。
      if (!r || r.error) {
        if (opts.onProgress) opts.onProgress(code, name, { text: '首次未成功，正在重试…' })
        r = await generateReview({ code, name, session, hold: { cost, qty, pnlPct, openTNet }, onPhase })
      }
      if (r && !r.error) ok++; else fail++
    } catch { fail++ }
  }
  return { ok, fail, skipped }
}

// 检查并执行当前场次的自动复盘。quoteMap: {code: {price}} 供算浮盈亏。
// 关键：只有【至少成功生成一只】才标记完成；全失败则不标记，下一分钟自动重试(修复"占位后失败=永久不再生成")。
export async function runAutoReviewIfDue(quoteMap) {
  if (_autoRunning) return false
  const session = currentAutoSession()
  if (!session) return false
  if (isDone(session)) return false
  const holding = planStore.get().holding || []
  if (!holding.length) { markDone(session); return false }  // 无持仓也标记，避免反复检查
  _autoRunning = true
  try {
    const { ok } = await reviewAllHoldings(session, quoteMap)
    if (ok > 0) markDone(session)   // 成功至少一只才标记；否则保留未完成，下轮重试
    return ok > 0
  } finally {
    _autoRunning = false
  }
}

// 手动补生成：对持仓生成复盘。默认 onlyMissing=true → 只补"今天还没有复盘"的持仓(顶部"补生成"按钮的语义)。
// 单卡上的"重生成"走 generateReview 直接覆盖单只，二者职责分离不重复。
// session 传 'close'/'noon'/'manual'；成功后按需标记完成，避免之后又自动重复跑。
export async function forceGenerateReviews(session, quoteMap, opts = {}) {
  if (_autoRunning) return { ok: 0, fail: 0, busy: true }
  _autoRunning = true
  try {
    const s = session || currentAutoSession() || 'manual'
    const onlyMissing = opts.onlyMissing !== false // 默认只补缺口
    const res = await reviewAllHoldings(s, quoteMap, { onlyMissing, onProgress: opts.onProgress })
    if (res.ok > 0 && (s === 'close' || s === 'noon')) markDone(s)
    return res
  } finally {
    _autoRunning = false
  }
}

