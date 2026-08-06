// 「每日定时重生成 AI 操作建议」调度器。
// 统一数据源口径:持仓卡主行动、复盘、计划止盈止损全部取自 AI 操作建议(adviceCache)。
// 因此每天开盘前/复盘时点,对【持仓个股】与【自选(候选)个股】各自重新生成一次 AI 操作建议——
//   持仓股 → mode='hold_advice'(加/减/持/清 + 具体价位,含账户/目标资产/做T净手数上下文)
//   自选股 → mode='buy_advice'(立即买入/回调再买/小仓试错/观望 四档),二者内容差异由后端 prompt 区分。
// 生成走模块级后台 runner(adviceRunner.startAdvice),关闭页面也照跑完、落缓存、记决策,与手动生成完全同源。
import { api } from './apiBase'
import { planStore, livePositionOf, computeTFlows, computePortfolio, t1StatusOf } from './planStore'
import { nextTradingDayLabel } from './review'
import { getAdvice } from './adviceCache'
import { startAdvice } from './adviceRunner'
import { bjDayKey, isWeekday, bjMinutes } from './review'

const DONE_KEY = 'stock_advice_daily_v1'  // { day: 'YYYY-MM-DD', done: true }
const GAP_MS = 6 * 3600 * 1000            // 同一只 6 小时内已生成过则跳过(避免与手动生成/上一场次重复)

function loadDone() {
  try { return JSON.parse(localStorage.getItem(DONE_KEY) || '{}') } catch { return {} }
}
function markDone(day) {
  try { localStorage.setItem(DONE_KEY, JSON.stringify({ day, done: true })) } catch { /* ignore */ }
}
function isDone(day) {
  const d = loadDone()
  return d && d.day === day && d.done
}

// 军师历史战绩(真实回测胜率)→ 传后端做自我校准(与 StockDetail.loadQuant 同口径)
function advisorTrackFor(mode) {
  try {
    const s = planStore.adviceStats()
    if (!s || s.total < 5) return null
    const g = (s.groups || []).find((x) => x.mode === mode) || null
    let theoryScores = null
    try {
      const t = planStore.theoryStats()
      const tg = ((t && t.groups) || []).filter((x) => x.total >= 3)
      if (tg.length) theoryScores = tg.map((x) => ({ theory: x.theory, winRate: x.winRate, total: x.total, avgPct: x.avgPct }))
    } catch { /* ignore */ }
    return {
      overallWinRate: s.winRate, overallAvgPct: s.avgPct, overallTotal: s.total,
      modeWinRate: g ? g.winRate : null, modeAvgPct: g ? g.avgPct : null, modeTotal: g ? g.total : 0,
      theoryScores,
    }
  } catch { return null }
}

function accountFrom(portfolio, account) {
  return {
    totalAssets: (portfolio && portfolio.totalAssets) ?? (account && account.totalAssets) ?? null,
    cash: (portfolio && portfolio.available) ?? (account && account.cash) ?? null,
    position: portfolio && portfolio.position != null ? portfolio.position : null,
    holdMktValue: portfolio && portfolio.holdMktValue != null ? portfolio.holdMktValue : null,
    goal: portfolio && portfolio.goal != null ? portfolio.goal : null,
    goalProgress: portfolio && portfolio.goalProgress != null ? portfolio.goalProgress : null,
    goalGap: portfolio && portfolio.goalGap != null ? portfolio.goalGap : null,
    goalReturnPct: portfolio && portfolio.goalReturnPct != null ? portfolio.goalReturnPct : null,
  }
}

// T+1 买入时间锁定字段:注入 aiPayload,让军师知道"今天买的手数当日不可卖"。
// boughtTodayQty=今日买入手数(建仓/加仓/今日做T买腿,T+1锁定); sellableTodayQty=今日最多可卖手数;
// t1Locked=true 表示存在今日买入(有锁定手数); nextTradeDay=真实下一交易日(锁定手数最早可卖日)。
function t1Fields(code, holdQty) {
  try {
    const t1 = t1StatusOf(code)
    if (!t1) return {}
    const sellable = t1.sellableToday != null ? t1.sellableToday : holdQty
    return {
      boughtTodayQty: t1.boughtToday,
      sellableTodayQty: sellable,
      t1Locked: t1.boughtToday > 0,
      todayBuys: (t1.buys || []).map((b) => ({ price: b.price, qty: b.qty, kind: b.kind })),
      nextTradeDay: nextTradingDayLabel(),
    }
  } catch { return {} }
}

// 6 小时内已有新鲜建议 → 跳过,不重复生成(节流,省算力/网关配额)
function isFresh(code) {
  const a = getAdvice(code)
  return !!(a && a.at && (Date.now() - a.at) < GAP_MS)
}

// 生成【持仓个股】的 AI 操作建议(hold_advice):带成本/手数/做T净手数/账户占比/目标资产
// 只【构造 spec】,不直接发起 —— 供每日调度与「批量一次性生成」两条链路复用同一口径。
export function buildHoldSpec(code, name, quoteMap, portfolio, account) {
  const lp = livePositionOf(code)  // {qty,cost,hasOpenT,tNetHands} 或 null(底仓被反T卖光)
  let holdCost, holdQty, openTNet
  if (lp) {
    holdCost = lp.cost; holdQty = lp.qty; openTNet = lp.hasOpenT ? lp.tNetHands : 0
  } else {
    // 反T卖光未接回:用底仓成本作参考,holdQty=0,openTNet为负 → 让军师指导"接回/加仓"
    const hs = (planStore.get().holding || []).filter((h) => h.code === code)
    let tNet = 0, baseCostSum = 0, baseQtySum = 0
    for (const h of hs) {
      const rr = computeTFlows(h.tFlows)
      tNet += (rr.openBuy || 0) - (rr.openSell || 0)
      baseCostSum += (h.buyPrice || 0) * (h.qty || 0); baseQtySum += (h.qty || 0)
    }
    holdCost = baseQtySum > 0 ? +(baseCostSum / baseQtySum).toFixed(3) : null
    holdQty = 0; openTNet = tNet
  }
  const hp = (holdCost != null && holdQty != null) ? `&holdCost=${holdCost}&holdQty=${holdQty}` : ''
  const quantUrl = api(`/api/stock_detail?code=${code}&klt=101&lmt=60&quant=1${hp}&_t=${Date.now()}`)
  const stockWeight = (() => {
    const p = portfolio && portfolio.positions ? portfolio.positions.find((x) => x.code === code) : null
    return p && p.weight != null ? p.weight : null
  })()
  const aiPayload = {
    code, name,
    holdCost, holdQty,
    openTNet,
    // T+1 买入时间锁定：今日买入手数当日绝对不可卖(A股T+1)，今日最多可卖=可卖手数
    ...t1Fields(code, holdQty),
    advisorTrack: advisorTrackFor('hold_advice'),
    account: { ...accountFrom(portfolio, account), stockWeight },
  }
  const priceHint = (quoteMap && quoteMap[code] && quoteMap[code].price) || holdCost || null
  return { code, mode: 'hold_advice', name, myHold: true, aiPayload, quantUrl, priceHint }
}

// 生成【自选/非持仓个股】的 AI 操作建议(buy_advice):四档买点结论,不含持仓上下文
export function buildWatchSpec(code, name, quoteMap, portfolio, account) {
  const quantUrl = api(`/api/stock_detail?code=${code}&klt=101&lmt=60&quant=1&_t=${Date.now()}`)
  const aiPayload = {
    code, name,
    advisorTrack: advisorTrackFor('buy_advice'),
    account: accountFrom(portfolio, account),
  }
  const priceHint = (quoteMap && quoteMap[code] && quoteMap[code].price) || null
  return { code, mode: 'buy_advice', name, myHold: false, aiPayload, quantUrl, priceHint }
}

function startForHolding(code, name, quoteMap, portfolio, account) {
  startAdvice(buildHoldSpec(code, name, quoteMap, portfolio, account))
}
function startForWatch(code, name, quoteMap, portfolio, account) {
  startAdvice(buildWatchSpec(code, name, quoteMap, portfolio, account))
}

// 是否到「每日重生成」时点:交易日的开盘前(08:30–09:15)或收盘后(15:00+),各触发一次(当天去重)。
// 这样早上拿到的是"面向今日"的建议、收盘后拿到的是"面向次日"的建议,与复盘场次呼应。
function isDailyDue() {
  if (!isWeekday()) return false
  const hm = bjMinutes()
  return (hm >= 510 && hm < 555) || hm >= 900  // 08:30–09:15 盘前 / 15:00+ 收盘后
}

let _running = false
// 每日定时重生成入口:由 App.jsx 的分钟级调度器调用(与 runAutoReviewIfDue 并列)。
// quoteMap: {code:{price,...}} 供算浮盈亏/账户仓位。当天已完整跑过一轮 → 直接返回。
export async function runDailyAdviceIfDue(quoteMap) {
  if (_running) return false
  if (!isDailyDue()) return false
  const day = bjDayKey()
  if (isDone(day)) return false
  _running = true
  try {
    const st = planStore.get()
    const holding = st.holding || []
    const watch = st.plan || []
    const portfolio = computePortfolio(holding, quoteMap, st.account)
    // 持仓股(实时持仓口径,已并表反T)
    const holdCodes = [...new Set(holding.map((h) => h.code))]
    for (const code of holdCodes) {
      if (isFresh(code)) continue
      const name = (holding.find((h) => h.code === code) || {}).name || code
      startForHolding(code, name, quoteMap, portfolio, st.account)
    }
    // 自选股(候选池),排除已在持仓里的,避免同股两套 mode 冲突(持仓优先 hold_advice)
    const holdSet = new Set(holdCodes)
    const watchCodes = [...new Set(watch.map((w) => w.code))].filter((c) => !holdSet.has(c))
    for (const code of watchCodes) {
      if (isFresh(code)) continue
      const name = (watch.find((w) => w.code === code) || {}).name || code
      startForWatch(code, name, quoteMap, portfolio, st.account)
    }
    markDone(day)  // 已发起本日这一轮(runner 后台跑完并落缓存);当天不再重复触发
    return true
  } finally {
    _running = false
  }
}
