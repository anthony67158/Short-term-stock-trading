import { useSyncExternalStore } from 'react'
import { getAdvice, getAllAdvice, setAllAdvice, mergeAdvice, registerAdviceSync } from './adviceCache.js'
import { computeSellAllowance } from '../shared/decisionGuards.js'
import { appendExecution, createRecommendation, decisionLedgerStats, removeExecutions } from '../shared/decisionLedger.js'
import { proposalAlertSpec, sanitizeTradeProposal } from '../shared/tradeProposal.js'
import { applyT1ToAlert } from '../shared/t1AdvicePolicy.js'
import { adviceSupportsIntent, buildJudgeAdviceContext } from '../shared/judgeAdviceContext.js'
import {
  applyAccountCashFlow,
  deriveAccountValuation,
} from '../shared/accountValuation.js'
import {
  ADVICE_OUTCOME_POLICY_VERSION,
  adviceActionKind,
  adviceNeedsVerification,
  isAdviceOutcomeCurrent,
  summarizeAdviceOutcomes,
} from '../shared/adviceOutcome.js'
// 注意:adviceBatch 只在 mergeCloud 运行时用到,这里【不能】做顶层静态 import——
// 否则 planStore→adviceBatch→adviceRunner→serverAdvice→authStore 形成模块初始化环,
// 而 authStore 顶层会调用 planStore.registerSaver(),此时 planStore 尚未初始化 → 整包崩(白屏卡启动)。
// 改为运行时按需 import(),彻底打断这条初始化环。

// 唯一 id（分笔持仓/记录用）
let _seq = 0
function uid() { return Date.now().toString(36) + '_' + (_seq++).toString(36) }

// 价格按量级取合适小数位:<10 用3位,否则2位(全局统一口径)
function roundPx(v) {
  if (v == null || isNaN(v)) return null
  const n = Number(v)
  return n < 10 ? +n.toFixed(3) : +n.toFixed(2)
}

function replaceLocalDate(timestamp, dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const source = new Date(Number(timestamp) || Date.now())
  const next = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    source.getHours(),
    source.getMinutes(),
    source.getSeconds(),
    source.getMilliseconds(),
  )
  if (
    next.getFullYear() !== Number(match[1]) ||
    next.getMonth() !== Number(match[2]) - 1 ||
    next.getDate() !== Number(match[3])
  ) return null
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (dateText > todayKey) return null
  return next.getTime()
}

function shiftRecordDate(record, dateText) {
  const primary = record.at || record.sellAt || record.buyAt
  const nextPrimary = replaceLocalDate(primary, dateText)
  if (!nextPrimary) return null
  const shift = (value) => value ? replaceLocalDate(value, dateText) : value
  return {
    ...record,
    at: record.at ? shift(record.at) : nextPrimary,
    buyAt: record.buyAt ? shift(record.buyAt) : record.buyAt,
    sellAt: record.sellAt ? shift(record.sellAt) : record.sellAt,
    editedAt: Date.now(),
  }
}
// 从最新 AI 操作建议缓存里取【标准化】的止盈(tp)/止损(sl)——全局唯一口径。
// AI 建议字段:targetPrice=目标价(止盈)、stopPrice=止损价;统一映射成持仓/候选卡的 tp/sl。
// 这样「个股详情页的AI建议」与「持仓卡的止盈/止损」永远同源同值,不会各算各的。
export function advicePlan(code) {
  try {
    const a = getAdvice(code)
    const adv = a && a.advice
    if (!adv) return null
    const tp = adv.targetPrice != null && !isNaN(adv.targetPrice) ? roundPx(adv.targetPrice) : null
    const sl = adv.stopPrice != null && !isNaN(adv.stopPrice) ? roundPx(adv.stopPrice) : null
    if (tp == null && sl == null) return null
    // 计划「理由」同源:优先具体操作计划,其次一句话结论/理由/时机,供持仓卡计划自动跟随
    const reason = adv.actionPlan || adv.title || adv.reason || adv.timing || ''
    return { tp, sl, reason, action: adv.action || adv.stance || '', tone: adv.tone || '', at: a.at }
  } catch { return null }
}

// 从最新 AI 操作建议缓存里取【一句话主行动】——供持仓卡「主行动条」展示,与个股详情页同源同值。
// 返回 { badge(动作词), text(操作指导一句话), tone('red'|'green'|'muted'), at, action, actionPlan, title }。
// 无 AI 建议 → null,调用方据此提示用户「去生成AI建议」。取值优先级:
//   badge = action/stance(如 立即买入/回调再买/加仓/减仓/持有/清仓/观望)
//   text  = actionPlan(具体操作计划) → title → reason,尽量给一句可执行的话
export function adviceFocus(code) {
  try {
    const a = getAdvice(code)
    const adv = a && a.advice
    if (!adv) return null
    const badge = adv.action || adv.stance || ''
    const text = adv.actionPlan || adv.title || adv.reason || adv.timing || ''
    if (!badge && !text) return null
    // tone:红=偏多(买入/加仓/持有),绿=偏空(卖出/减仓/清仓),其余取 adv.tone 或 muted
    let tone = adv.tone || ''
    if (!['red', 'green'].includes(tone)) {
      if (/买入|加仓|持有|建仓|回调再买|试错/.test(badge)) tone = 'red'
      else if (/卖出|减仓|清仓|止盈|离场/.test(badge)) tone = 'green'
      else tone = 'muted'
    }
    return { badge, text, tone, at: a.at, action: adv.action || adv.stance || '', actionPlan: adv.actionPlan || '', title: adv.title || '' }
  } catch { return null }
}

// ---- 理论归因：把军师 theoryNote 自由文本归一化成【规范理论标签】，供事后按理论算胜率 ----
// 每条建议可能引用 1~2 个理论；命中多个则都记入。顺序 = 优先级(靠前更具体)。
const THEORY_TAGS = [
  { tag: '利弗莫尔关键点',   re: /利弗莫尔|关键点|飞刀|金字塔加仓|错了.{0,3}认错|绝不摊亏/ },
  { tag: '欧奈尔CANSLIM',    re: /欧奈尔|奈尔|can\s*slim|canslim|8%.{0,3}止损|buy\s*point|买点突破/i },
  { tag: '米勒维尼VCP',      re: /米勒维尼|维尼|vcp|缩量收缩|均线多头排列/i },
  { tag: '威科夫量价',       re: /威科夫|wyckoff|吸筹|派发|聪明钱|主力.{0,3}脚印/i },
  { tag: '温斯坦阶段',       re: /温斯坦|weinstein|阶段分析|第二上升|30周线|生命线/i },
  { tag: '道氏趋势',         re: /道氏|dow|趋势三级|顺大势|顺势/ },
  { tag: '均值回归',         re: /均值回归|超买超卖|布林|回归中轨|震荡区间|高抛低吸/ },
  { tag: '凯利/R风控',       re: /凯利|kelly|撒普|r\s*倍数|盈亏比|风险敞口|单笔风险|仓位管理/i },
  { tag: '处置效应',         re: /处置效应|让利润奔跑|亏损快砍|截短亏损|赚一点就跑|亏了死扛/ },
  { tag: '索罗斯反身性',     re: /索罗斯|反身性|泡沫|拐点/ },
  { tag: '科斯托拉尼钟摆',   re: /科斯托拉尼|情绪钟摆|众人贪婪|众人恐慌|追顶|割底/ },
]
// 返回命中的规范标签数组(最多2个)；无匹配 → []
function theoryTagsOf(note) {
  if (!note || typeof note !== 'string') return []
  const hits = []
  for (const t of THEORY_TAGS) {
    if (t.re.test(note)) { hits.push(t.tag); if (hits.length >= 2) break }
  }
  return hits
}


// 计划 / 持仓 交易闭环 store（云端账号驱动：数据由 authStore 登录后注入，变更自动回存云端）
// plan:   候选   { code, name, note, addedAt }
// holding: 持仓  { code, name, buyPrice, buyAt, qty, buyFee }  qty=手, buyFee=该持仓总买入手续费
// closed:  已平仓 { code, name, buyPrice, sellPrice, qty, buyFee, sellFee, grossPnl, netPnl, pnlPct, buyAt, sellAt }

// ---- 交易类型枚举 ----
// BUY=纯买入(建/加仓,单腿,无盈亏) SELL=纯卖出(减/清仓,单腿,可带盈亏)
// CLOSE=回合平仓(旧数据兼容) T=做T配对差价
export const TXN = {
  BUY:   { key: 'BUY',   label: '买入', cls: 'buy' },
  SELL:  { key: 'SELL',  label: '卖出', cls: 'sell' },
  CLOSE: { key: 'CLOSE', label: '平仓', cls: 'close' },
  T:     { key: 'T',     label: '做T', cls: 't' },
}

// ---- A股手续费参数（可调）----
export const FEE = {
  commissionRate: 0.0003, // 佣金 万三
  commissionMin: 5,       // 佣金最低 5 元
  stampRate: 0.0005,      // 印花税 千0.5（仅卖出）
  transferRate: 0.00001,  // 过户费 万0.1（买卖都收）
}
// 买入手续费 = 佣金 + 过户费
export function calcBuyFee(amount) {
  const commission = Math.max(amount * FEE.commissionRate, FEE.commissionMin)
  const transfer = amount * FEE.transferRate
  return +(commission + transfer).toFixed(2)
}
// 卖出手续费 = 佣金 + 印花税 + 过户费
export function calcSellFee(amount) {
  const commission = Math.max(amount * FEE.commissionRate, FEE.commissionMin)
  const stamp = amount * FEE.stampRate
  const transfer = amount * FEE.transferRate
  return +(commission + stamp + transfer).toFixed(2)
}

// 归一化交易记录：补 type + realizedPnl（向后兼容）
function normalizeClosed(closed) {
  return (closed || []).map((c) => {
    if (c.type) return c
    const type = c.kind === 'T' ? 'T' : 'CLOSE'
    const realizedPnl = c.realizedPnl != null ? c.realizedPnl : (c.netPnl != null ? c.netPnl : null)
    return { ...c, type, realizedPnl }
  })
}

let state = { plan: [], holding: [], closed: [], account: null, alerts: [], reviews: {}, adviceLog: [], decisionLog: [], settings: {} }
const listeners = new Set()

// ===== 撤销栈：交易类操作前存快照，支持一步步撤回 =====
// 只存交易相关的四类数据的深拷贝；不进云端存储，刷新后清空（撤回是“本次会话内的后悔药”）
let _undoStack = []
const UNDO_LIMIT = 30
function snapshot(label) {
  try {
    _undoStack.push({
      label,
      at: Date.now(),
      data: JSON.parse(JSON.stringify({
        plan: state.plan, holding: state.holding, closed: state.closed,
        account: state.account, alerts: state.alerts, reviews: state.reviews, adviceLog: state.adviceLog, decisionLog: state.decisionLog,
      })),
    })
    if (_undoStack.length > UNDO_LIMIT) _undoStack.shift()
  } catch { /* 快照失败不阻断操作 */ }
}

// 云端回存：authStore 登录后注册 saver；每次数据变更防抖保存
let _saver = null
let _saveTimer = null
let _suspend = false // setData 注入时不触发回存
function scheduleSave() {
  if (_suspend || !_saver) return
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    _saver({ plan: state.plan, holding: state.holding, closed: state.closed, account: state.account, alerts: state.alerts, reviews: state.reviews, adviceLog: state.adviceLog, decisionLog: state.decisionLog, advice: getAllAdvice(), settings: state.settings || {} })
  }, 800)
}
// 立即落盘(不等 800ms 防抖):页面隐藏/关闭前把待写数据抢存一次,避免"改完立刻切走/关页 → 800ms 内没保存到云端"丢数据。
function flushSave() {
  if (_suspend || !_saver) return
  if (!_saveTimer) return   // 没有待写任务(数据已存过) → 无需重复保存
  clearTimeout(_saveTimer); _saveTimer = null
  try {
    _saver({ plan: state.plan, holding: state.holding, closed: state.closed, account: state.account, alerts: state.alerts, reviews: state.reviews, adviceLog: state.adviceLog, decisionLog: state.decisionLog, advice: getAllAdvice(), settings: state.settings || {} })
  } catch { /* ignore */ }
}
// 浏览器环境:页面切后台(visibilitychange→hidden)或即将卸载(pagehide/beforeunload)时,抢存一次待写数据。
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const kick = () => { if (document.visibilityState === 'hidden') flushSave() }
  document.addEventListener('visibilitychange', kick)
  window.addEventListener('pagehide', flushSave)
  window.addEventListener('beforeunload', flushSave)
}
function emit() { state = { ...state }; listeners.forEach((l) => { try { l() } catch (e) { console.error('[store] listener error', e) } }); scheduleSave() }

// 把某笔持仓上已配对的做T收益，归档为独立的 closed 记录(kind:'T')；
// 未配平的开口腿按净额方向归档为 加仓(BUY) / 减仓(SELL)，避免"当天没追平底仓"时无处归类。
// batchId：同一次结算/清仓产生的记录共享，删除时可按批级联，保证各分类联动一致。
function archiveTFlows(h, batchId) {
  const r = computeTFlows(h.tFlows)
  const out = []
  // 1) 已配对的做T差价
  for (const p of (r.pairList || [])) {
    out.push({
      id: uid(), batchId, type: 'T', kind: 'T', code: h.code, name: h.name,
      qty: p.qty, buyPrice: p.buyPrice, sellPrice: p.sellPrice,
      buyFee: p.buyFee, sellFee: p.sellFee,
      grossPnl: p.grossPnl, netPnl: p.netPnl, realizedPnl: p.netPnl,
      cashFlow: p.netPnl, cashApplied: !!p.cashApplied,
      pnlPct: p.buyPrice ? +(p.netPnl / (p.buyPrice * p.qty * 100 + p.buyFee) * 100).toFixed(2) : 0,
      tDir: p.tDir, holdingId: h.id,
      buyAt: p.buyAt, sellAt: p.sellAt, at: p.at,
    })
  }
  // 2) 开口净买入 → 加仓（BUY，单腿，无已实现盈亏）
  if (r.openBuy > 0 && r.openBuyAvg != null) {
    const amount = +(r.openBuyAvg * r.openBuy * 100).toFixed(2)
    out.push({
      id: uid(), batchId, type: 'BUY', code: h.code, name: h.name, side: 'buy',
      qty: r.openBuy, price: r.openBuyAvg, fee: r.openBuyFee, amount,
      cashFlow: -(amount + r.openBuyFee), realizedPnl: null,
      cashApplied: !!r.openBuyCashApplied,
      holdingId: h.id, at: r.openBuyAt || Date.now(), note: '做T净买入(加仓)',
    })
  }
  // 3) 开口净卖出 → 减仓/清仓（SELL，以底仓成本为基准算已实现盈亏）
  if (r.openSell > 0 && r.openSellAvg != null) {
    const shares = r.openSell * 100
    const amount = +(r.openSellAvg * shares).toFixed(2)
    const cost = (h.buyPrice || 0) * shares
    // 底仓买入费按卖出比例分摊
    const buyFeePart = h.qty ? +(((h.buyFee || 0) * (r.openSell / h.qty))).toFixed(2) : 0
    const netPnl = +((amount - cost) - r.openSellFee - buyFeePart).toFixed(2)
    out.push({
      id: uid(), batchId, type: 'SELL', kind: 'SELL', code: h.code, name: h.name, side: 'sell',
      qty: r.openSell, price: r.openSellAvg, amount, fee: r.openSellFee,
      cashFlow: +(amount - r.openSellFee).toFixed(2),
      cashApplied: !!r.openSellCashApplied,
      costPrice: h.buyPrice, buyPrice: h.buyPrice, sellPrice: r.openSellAvg,
      buyFee: buyFeePart, sellFee: r.openSellFee,
      grossPnl: +(amount - cost).toFixed(2), netPnl, realizedPnl: netPnl,
      pnlPct: cost ? +(netPnl / (cost + buyFeePart) * 100).toFixed(2) : 0,
      holdingId: h.id, at: r.openSellAt || Date.now(), sellAt: r.openSellAt || Date.now(), note: '做T净卖出(减仓)',
    })
  }
  return out
}

// 生成一条纯买入(BUY)交易记录：单腿，现金流出，无已实现盈亏
function makeBuyTxn(code, name, price, qty, fee, holdingId) {
  const amount = +(price * qty * 100).toFixed(2)
  return {
    id: uid(), type: 'BUY', code, name, side: 'buy',
    qty, price, fee, amount,
    cashFlow: -(amount + fee),        // 买入=现金流出
    realizedPnl: null,                // 纯买入无已实现盈亏
    holdingId, at: Date.now(),
  }
}

function updateAccountCash(cashFlow) {
  const result = applyAccountCashFlow(state.account, cashFlow)
  if (result.applied) state.account = result.account
  return result.applied
}

function tFlowCashFlow(side, price, qty, fee) {
  const amount = Number(price) * Number(qty) * 100
  return side === 'buy'
    ? +(-(amount + Number(fee || 0))).toFixed(2)
    : +(amount - Number(fee || 0)).toFixed(2)
}

export const planStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return state },
  // 由 authStore 登录/登出时注入数据（不触发回存云端，避免刚拉就写回）
  setData(d) {
    _suspend = true
    const holding = Array.isArray(d && d.holding) ? d.holding : []
    const heldCodes = new Set(holding.map((item) => String(item && item.code || '')).filter(Boolean))
    const plan = (Array.isArray(d && d.plan) ? d.plan : [])
      .filter((item) => !heldCodes.has(String(item && item.code || '')))
    state = {
      plan,
      holding,
      closed: normalizeClosed(Array.isArray(d && d.closed) ? d.closed : []),
      account: (d && d.account) || null,   // { totalAssets, cash, goal, updatedAt }
      alerts: Array.isArray(d && d.alerts) ? d.alerts : [],        // 预警规则集
      reviews: (d && d.reviews) || {},      // 复盘结论：key=code → { code,name,at,session(noon/close/manual),text,... }
      adviceLog: Array.isArray(d && d.adviceLog) ? d.adviceLog : [],  // AI建议决策记录：{id,code,name,mode,at,action,entry,stop,target,trust,resonance,verified,hit,...}
      decisionLog: Array.isArray(d && d.decisionLog) ? d.decisionLog : [], // 建议与真实执行分离的事件账本
      settings: (d && d.settings) || {},    // 跨设备同步的个性化设置(如 AI 每日精选/自动开关等)
    }
    // AI 操作建议【结果】跨设备回灌：用云端数据整体覆盖本地建议缓存(登出/空账号→清空)
    setAllAdvice((d && d.advice) || {})
    listeners.forEach((l) => { try { l() } catch (e) { console.error('[store] listener error', e) } })
    _suspend = false
    // 登录/切换账号载入后，自动结算跨天未结算的做T（会触发一次云端回存）
    this.autoSettleTFlows()
  },
  // authStore 注册云端保存回调
  registerSaver(fn) { _saver = fn },
  // 运行时【定期】把云端数据合并进本地(跨设备同步:手机生成的AI建议→电脑自动看到,无需刷新)。
  // 与 setData(登录时整体覆盖) 不同:这里是运行态的【非破坏式增量合并】——
  //   · AI操作建议(advice):按逐条时间戳合并,只补更新的,不删本机更新的(见 mergeAdvice)
  //   · adviceLog(决策记录):按 id 去重并入,保留两端全集(仅新增,不删)
  // 绝不触碰 plan/holding/closed/account —— 那些是用户正在本机编辑的,交由用户操作+防抖回存,
  // 避免"电脑正在改持仓,却被云端旧值盖回"。合并若有变化,防抖回存一次让两端最终一致。
  mergeCloud(d) {
    if (!d || typeof d !== 'object') return false
    let changed = false
    // 1) AI 操作建议:逐条时间戳合并
    if (d.advice && typeof d.advice === 'object') {
      if (mergeAdvice(d.advice)) changed = true
    }
    // 2) 决策记录:按 id 并集(仅新增)
    if (Array.isArray(d.adviceLog) && d.adviceLog.length) {
      const seen = new Set((state.adviceLog || []).map((x) => x && x.id).filter(Boolean))
      const add = d.adviceLog.filter((x) => x && x.id && !seen.has(x.id))
      if (add.length) {
        _suspend = true
        state = { ...state, adviceLog: [...(state.adviceLog || []), ...add].sort((a, b) => (a.at || 0) - (b.at || 0)) }
        _suspend = false
        changed = true
      }
    }
    // 3) 决策事件按 id 合并；同一建议的 executed 状态以较新的云端事件为准。
    if (Array.isArray(d.decisionLog) && d.decisionLog.length) {
      const merged = new Map((state.decisionLog || []).filter((x) => x && x.id).map((x) => [x.id, x]))
      let touched = false
      for (const event of d.decisionLog) {
        if (!event || !event.id) continue
        const current = merged.get(event.id)
        if (!current || (event.executedAt || event.at || 0) > (current.executedAt || current.at || 0)) {
          merged.set(event.id, event)
          touched = true
        }
      }
      if (touched) {
        state = { ...state, decisionLog: [...merged.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 1000) }
        changed = true
      }
    }
    // 4) 预警「已触发」状态回灌(按 id):cron_alert 在服务端(关页面时)命中并推送后,会把该
    //    规则标记 triggeredAt/enabled:false 存回云端。这里只把「服务端已触发」并回本地——
    //    ① 让前端「命中记录/规则」显示一致;② 避免前端仍当它监控中而重复响铃/重复推送。
    //    只迁移 triggered 状态,绝不新增/删除规则(规则增删仍由用户在本机操作,防跨设备误删复活)。
    if (Array.isArray(d.alerts) && d.alerts.length && Array.isArray(state.alerts) && state.alerts.length) {
      const cloudById = new Map(d.alerts.map((a) => a && a.id ? [a.id, a] : [null, null]))
      let touched = false
      const next = state.alerts.map((a) => {
        const c = cloudById.get(a.id)
        if (!c) return a
        if (c.phase === 'superseded' && a.phase !== 'superseded') {
          touched = true
          return { ...a, enabled: false, phase: 'superseded', supersededBy: c.supersededBy, triggeredMsg: c.triggeredMsg || a.triggeredMsg }
        }
        // ① 服务端已确认命中(强提示已发)→ 迁移 triggered + confirmed 态,避免本地重复响铃
        if (c.triggeredAt) {
          const patch = {
            triggeredAt: c.triggeredAt,
            triggeredMsg: c.triggeredMsg || a.triggeredMsg || '',
            enabled: false,
            phase: c.phase || a.phase,
            decisionPrice: c.decisionPrice ?? a.decisionPrice,
            decisionSide: c.decisionSide || a.decisionSide,
            judgeOutcomes: c.judgeOutcomes || a.judgeOutcomes || {},
            lastJudgeAt: c.lastJudgeAt || a.lastJudgeAt,
            lastJudgeDecision: c.lastJudgeDecision || a.lastJudgeDecision,
            lastJudgeConfidence: c.lastJudgeConfidence ?? a.lastJudgeConfidence,
            lastJudgePolicy: c.lastJudgePolicy || a.lastJudgePolicy,
            judgeCount: Math.max(Number(c.judgeCount) || 0, Number(a.judgeCount) || 0),
          }
          if (JSON.stringify(patch) !== JSON.stringify({
            triggeredAt: a.triggeredAt,
            triggeredMsg: a.triggeredMsg || '',
            enabled: a.enabled,
            phase: a.phase,
            decisionPrice: a.decisionPrice,
            decisionSide: a.decisionSide,
            judgeOutcomes: a.judgeOutcomes || {},
            lastJudgeAt: a.lastJudgeAt,
            lastJudgeDecision: a.lastJudgeDecision,
            lastJudgeConfidence: a.lastJudgeConfidence,
            lastJudgePolicy: a.lastJudgePolicy,
            judgeCount: Number(a.judgeCount) || 0,
          })) touched = true
          return { ...a, ...patch }
        }
        // ② 服务端已进入「观察确认中」(弱提醒已发)→ 迁移 watching 态,本地据此显示"确认中"而非继续当作未到价
        if (c.phase === 'watching' && a.phase !== 'watching' && a.phase !== 'confirmed' && !a.triggeredAt) {
          touched = true
          return {
            ...a,
            phase: 'watching',
            watchingAt: c.watchingAt || Date.now(),
            watchingPrice: c.watchingPrice ?? a.watchingPrice,
            watchingMsg: c.watchingMsg || a.watchingMsg || '',
            lastJudgeAt: c.lastJudgeAt || a.lastJudgeAt,
            lastJudgeDecision: c.lastJudgeDecision || a.lastJudgeDecision,
            lastJudgeConfidence: c.lastJudgeConfidence ?? a.lastJudgeConfidence,
            lastJudgePolicy: c.lastJudgePolicy || a.lastJudgePolicy,
            judgeCount: Math.max(Number(c.judgeCount) || 0, Number(a.judgeCount) || 0),
          }
        }
        return a
      })
      if (touched) {
        _suspend = true
        state = { ...state, alerts: next }
        _suspend = false
        changed = true
      }
    }
    if (changed) { listeners.forEach((l) => { try { l() } catch (e) { console.error('[store] listener error', e) } }); scheduleSave() }
    // 5) 服务端批量生成进度回灌:喂给 adviceBatch,让本机进度条显示【服务端/另一设备】正在跑的批量进程。
    //    (与 advice/adviceLog 合并解耦:进度是纯展示态,不进 changed/不触发回存)
    if (d.batchProgress && typeof d.batchProgress === 'object') {
      // 按需动态 import,避免顶层静态 import 造成模块初始化环(见文件头注释)
      import('./adviceBatch').then((m) => { try { m.applyCloudBatch(d.batchProgress) } catch { /* ignore */ } }).catch(() => { /* ignore */ })
    }
    return changed
  },
  // ===== 跨设备同步的个性化设置 =====
  // 供 UI(如 AI 每日精选选股/自动开关) 读写；变更即触发防抖回存云端。
  getSetting(key, fallback = null) {
    const s = state.settings || {}
    return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : fallback
  },
  setSetting(key, value) {
    if (!key) return
    state.settings = { ...(state.settings || {}), [key]: value }
    emit()
  },
  addPlan(stock, note = '') {
    if (!stock || !stock.code) return
    if (state.plan.some((x) => x.code === stock.code)) return
    if (state.holding.some((x) => x.code === stock.code)) return // 已持有的票不再入计划，请用「加仓」
    state.plan = [...state.plan, { code: stock.code, name: stock.name, note, addedAt: Date.now() }]
    emit()
  },
  removePlan(code) {
    state.plan = state.plan.filter((x) => x.code !== code)
    state.alerts = (state.alerts || []).filter((a) => a.candCode !== code) // 连带清理其买点预警
    emit()
  },
  // 切换「重点关注」标记（自选/候选置顶高亮）
  toggleStar(code) {
    state.plan = state.plan.map((x) => x.code === code ? { ...x, star: !x.star } : x)
    emit()
  },
  // 写入某股的【量化得分】(0~100) —— 自选候选与持仓同 code 都更新，专用字段 qScore/qBias/qAt。
  // 两处触发：①加入自选/首屏时按需评分(quantScore.ensureQuantScore) ②生成AI操作建议时带回最新分(adviceRunner)。
  // 无变化则不 emit，避免评分回写引发无谓重渲染/云端回存。
  setQuantScore(code, patch) {
    if (!code || !patch) return
    const s = Number(patch.qScore)
    if (isNaN(s)) return
    const next = { qScore: +s.toFixed(1), qBias: patch.qBias || '', qAt: patch.qAt || Date.now() }
    let changed = false
    const apply = (arr) => (arr || []).map((x) => {
      if (x.code !== code) return x
      if (x.qScore === next.qScore && x.qBias === next.qBias) return x // 分数未变→跳过
      changed = true
      return { ...x, ...next }
    })
    const plan = apply(state.plan)
    const holding = apply(state.holding)
    if (!changed) return
    state.plan = plan; state.holding = holding
    emit()
  },

  // 计划 → 持仓（每次买入都是独立一笔，同股可多笔并存）
  buy(code, buyPrice, qty = 1) {
    const p = state.plan.find((x) => x.code === code)
    if (!p) return
    snapshot(`建仓 ${p.name || code}`)
    const q = Number(qty) || 1
    const price = Number(buyPrice)
    const buyAmount = price * q * 100
    const fee = calcBuyFee(buyAmount)
    const hid = uid()
    state.plan = state.plan.filter((x) => x.code !== code)
    state.alerts = (state.alerts || []).filter((a) => a.candCode !== code) // 已买入 → 移除买点预警(改由持仓计划联动)
    // 建仓即带上最新 AI 操作建议的止盈/止损(若有):tpManual/slManual=false 表示「跟随AI」,
    // 之后详情页刷新建议会自动跟随;用户手动改过则置 true 停止跟随。
    const ap = advicePlan(p.code)
    state.holding = [...state.holding, {
      id: hid, code: p.code, name: p.name, buyPrice: price, buyAt: Date.now(),
      qty: q, buyFee: fee,
      // 建仓继承候选上已算好的量化得分,持仓卡也能立刻展示分数(之后AI建议刷新会更新)
      ...(p.qScore != null ? { qScore: p.qScore, qBias: p.qBias, qAt: p.qAt } : {}),
      ...(ap ? { tp: ap.tp, sl: ap.sl, tpManual: false, slManual: false } : {}),
    }]
    // 记录一条纯买入交易流水
    const txn = makeBuyTxn(p.code, p.name, price, q, fee, hid)
    txn.cashApplied = updateAccountCash(txn.cashFlow)
    state.closed = [txn, ...state.closed].slice(0, 300)
    this._recordExecution({ code: p.code, name: p.name, side: 'buy', price, qty: q, transactionId: txn.id })
    this._syncPlanAlerts(hid)
    emit()
  },
  // 直接建仓（同股也可多笔，不去重）
  buyDirect(stock, buyPrice, qty = 1) {
    if (!stock || !stock.code) return
    snapshot(`建仓 ${stock.name || stock.code}`)
    const q = Number(qty) || 1
    const price = Number(buyPrice)
    const buyAmount = price * q * 100
    const fee = calcBuyFee(buyAmount)
    const hid = uid()
    const ap = advicePlan(stock.code)
    state.holding = [...state.holding, {
      id: hid, code: stock.code, name: stock.name, buyPrice: price, buyAt: Date.now(),
      qty: q, buyFee: fee,
      ...(ap ? { tp: ap.tp, sl: ap.sl, tpManual: false, slManual: false } : {}),
    }]
    state.plan = state.plan.filter((x) => x.code !== stock.code)
    state.alerts = (state.alerts || []).filter((a) => a.candCode !== stock.code) // 已买入 → 移除买点预警
    const txn = makeBuyTxn(stock.code, stock.name, price, q, fee, hid)
    txn.cashApplied = updateAccountCash(txn.cashFlow)
    state.closed = [txn, ...state.closed].slice(0, 300)
    this._recordExecution({ code: stock.code, name: stock.name, side: 'buy', price, qty: q, transactionId: txn.id })
    this._syncPlanAlerts(hid)
    emit()
  },

  // 持仓 → 平仓（按持仓笔 id 卖出，支持部分卖出）
  sell(id, sellPrice, sellQty, opts = {}) {
    const h = state.holding.find((x) => x.id === id)
    if (!h) return { ok: false, error: '持仓不存在或已被删除' }
    const requested = Math.min(Number(sellQty) || h.qty, h.qty)
    const t1 = t1StatusOf(h.code)
    const allowance = computeSellAllowance(requested, t1.sellableToday)
    if (!allowance.ok) {
      return { ok: false, error: `今日买入 ${t1.boughtToday} 手仍受 T+1 锁定，当前没有可卖仓位` }
    }
    const sq = allowance.allowed
    snapshot(`${sq >= h.qty ? '清仓' : '减仓'} ${h.name || h.code}`)
    const price = Number(sellPrice)
    const shares = sq * 100
    const cost = h.buyPrice * shares
    const proceeds = price * shares
    // 买入手续费按卖出比例分摊
    const buyFeePart = +((h.buyFee || 0) * (sq / h.qty)).toFixed(2)
    const sellFee = calcSellFee(proceeds)
    const grossPnl = proceeds - cost                    // 毛盈亏（未扣费）
    const netPnl = +(grossPnl - buyFeePart - sellFee).toFixed(2) // 净盈亏（扣双边费）
    const pnlPct = cost ? (netPnl / (cost + buyFeePart)) * 100 : 0

    // 更新该笔持仓：部分卖则减仓，全卖则移除
    let archived = []
    const batchId = uid() // 本次清仓/卖出批次：卖出记录 + 归档做T记录共享，删除时级联
    if (sq >= h.qty) {
      // 全部清仓：把该持仓上已配对的做T收益归档，避免随持仓删除而丢失
      archived = archiveTFlows(h, batchId)
      state.holding = state.holding.filter((x) => x.id !== id)
      this._backToPlan(h) // 清仓不直接删除 → 自动回归自选股，方便再次盯盘
    } else {
      const remainQty = h.qty - sq
      state.holding = state.holding.map((x) => x.id === id
        ? { ...x, qty: remainQty, buyFee: +((h.buyFee || 0) * (remainQty / h.qty)).toFixed(2) }
        : x)
      state.plan = state.plan.filter((item) => String(item.code) !== String(h.code))
    }

    const sellTxn = {
      id: uid(), batchId, type: 'SELL', kind: 'SELL', code: h.code, name: h.name,
      side: 'sell', qty: sq, price, amount: +proceeds.toFixed(2),
      fee: sellFee, cashFlow: +(proceeds - sellFee).toFixed(2), // 卖出=现金流入
      costPrice: h.buyPrice, realizedPnl: netPnl,               // 有成本基准→带已实现盈亏
      // 兼容旧展示字段
      buyPrice: h.buyPrice, sellPrice: price, buyFee: buyFeePart, sellFee,
      grossPnl: +grossPnl.toFixed(2), netPnl, pnlPct,
      buyAt: h.buyAt, sellAt: Date.now(), at: Date.now(),
    }
    sellTxn.cashApplied = updateAccountCash(sellTxn.cashFlow)
    state.closed = [sellTxn, ...archived, ...state.closed].slice(0, 300)
    this._recordExecution({ code: h.code, name: h.name, side: 'sell', price, qty: sq, source: opts.source, transactionId: sellTxn.id })
    emit()
    return {
      ok: true,
      qty: sq,
      adjusted: sq < Number(sellQty),
      message: sq < Number(sellQty) ? `受 T+1 限制，本次仅记录卖出 ${sq} 手` : '',
    }
  },

  // 加仓：对已有持仓追加买入，按加权平均更新成本价，并记一条 BUY 流水
  addToHolding(id, addPrice, addQty, opts = {}) {
    const h = state.holding.find((x) => x.id === id)
    if (!h) return
    const q = Number(addQty) || 0
    const price = Number(addPrice)
    if (q <= 0 || !price) return
    snapshot(`加仓 ${h.name || h.code}`)
    const addAmount = price * q * 100
    const addFee = calcBuyFee(addAmount)
    const newQty = h.qty + q
    // 加权平均成本价（原成本×原量 + 加仓价×加量）/ 总量
    const newAvg = +(((h.buyPrice * h.qty) + (price * q)) / newQty).toFixed(3)
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, qty: newQty, buyPrice: newAvg, buyFee: +((x.buyFee || 0) + addFee).toFixed(2) }
      : x)
    // 记一条买入交易流水
    const txn = makeBuyTxn(h.code, h.name, price, q, addFee, id)
    txn.cashApplied = updateAccountCash(txn.cashFlow)
    state.closed = [txn, ...state.closed].slice(0, 300)
    this._recordExecution({ code: h.code, name: h.name, side: 'buy', price, qty: q, source: opts.source, transactionId: txn.id })
    emit()
  },

  // 纯买入/纯卖出：不走持仓，直接记一笔交易流水（手动补录场景）
  recordTxn(type, stock, price, qty, opts = {}) {
    if (!stock || !stock.code || !price || !qty) return
    const q = Number(qty), p = Number(price)
    const amount = +(p * q * 100).toFixed(2)
    const fee = type === 'BUY' ? calcBuyFee(amount) : calcSellFee(amount)
    const rec = type === 'BUY'
      ? makeBuyTxn(stock.code, stock.name, p, q, fee, null)
      : {
          id: uid(), type: 'SELL', kind: 'SELL', code: stock.code, name: stock.name,
          side: 'sell', qty: q, price: p, amount, fee, cashFlow: +(amount - fee).toFixed(2),
          costPrice: opts.costPrice ?? null,
          realizedPnl: opts.costPrice ? +((p - opts.costPrice) * q * 100 - fee).toFixed(2) : null,
          sellPrice: p, buyPrice: opts.costPrice ?? null, sellFee: fee, at: Date.now(), sellAt: Date.now(),
        }
    state.closed = [rec, ...state.closed].slice(0, 300)
    this._recordExecution({ code: stock.code, name: stock.name, side: type === 'BUY' ? 'buy' : 'sell', price: p, qty: q, source: opts.source, transactionId: rec.id })
    emit()
  },

  removeHolding(id) {
    const h = state.holding.find((x) => x.id === id)
    if (!h) return
    snapshot(`删除持仓 ${h.name || h.code}`)
    const archived = archiveTFlows(h, uid()) // 删除持仓前，先归档已实现做T收益
    if (archived.length) state.closed = [...archived, ...state.closed].slice(0, 300)
    state.holding = state.holding.filter((x) => x.id !== id); emit()
  },
  clearClosed() {
    snapshot('清空交易记录')
    state.decisionLog = removeExecutions(state.decisionLog, state.closed.map((x) => x && x.id))
    state.closed = []
    emit()
  },
  updateClosedDate(id, dateText) {
    const target = state.closed.find((item) => item.id === id)
    if (!target) return { ok: false, error: '交易记录不存在' }
    if (!replaceLocalDate(target.at || target.sellAt || target.buyAt, dateText)) {
      return { ok: false, error: '请选择今天或更早的有效日期' }
    }
    snapshot(`修改交易日期 ${target.name || target.code || ''}`.trim())
    const ids = new Set(
      (target.batchId
        ? state.closed.filter((item) => item.batchId === target.batchId)
        : [target]
      ).map((item) => item.id),
    )
    state.closed = state.closed.map((item) => {
      if (!ids.has(item.id)) return item
      return shiftRecordDate(item, dateText) || item
    })
    state.decisionLog = (state.decisionLog || []).map((event) => {
      if (!ids.has(event?.transactionId)) return event
      const shifted = shiftRecordDate(event, dateText)
      return shifted
        ? { ...shifted, executedAt: event.executedAt ? replaceLocalDate(event.executedAt, dateText) : shifted.at }
        : event
    })
    emit()
    return { ok: true, updated: ids.size }
  },
  // 删除单条交易记录：连带删除同一次操作(同 batchId)产生的其他记录；
  // 并联动调整持仓手数/成本，保证「持仓」与「交易记录」始终对得上。
  removeClosed(id) {
    const target = state.closed.find((x) => x.id === id)
    if (!target) return
    snapshot(`删除交易记录 ${target.name || target.code || ''}`.trim())
    // 找出本次要删的所有记录（同批级联）
    const toDelete = target.batchId
      ? state.closed.filter((x) => x.batchId === target.batchId)
      : [target]
    const delIds = new Set(toDelete.map((x) => x.id))
    const appliedCashFlow = toDelete.reduce(
      (sum, record) => sum + (record.cashApplied ? Number(record.cashFlow) || 0 : 0),
      0,
    )

    // 按个股汇总这批记录对持仓手数的净影响：删 BUY→减手数、删 SELL→加回手数（T 不影响底仓）
    const deltaByCode = {}
    for (const r of toDelete) {
      const t = r.type || r.kind
      if (t === 'BUY') deltaByCode[r.code] = (deltaByCode[r.code] || 0) - (r.qty || 0)
      else if (t === 'SELL' || t === 'CLOSE') deltaByCode[r.code] = (deltaByCode[r.code] || 0) + (r.qty || 0)
    }

    // 先移除记录
    state.closed = state.closed.filter((x) => !delIds.has(x.id))
    state.decisionLog = removeExecutions(state.decisionLog, [...delIds])
    if (appliedCashFlow) updateAccountCash(-appliedCashFlow)

    // 再联动持仓
    for (const [code, delta] of Object.entries(deltaByCode)) {
      if (!delta) continue
      const h = state.holding.find((x) => x.code === code)
      if (h) {
        const newQty = h.qty + delta
        if (newQty <= 0) {
          state.holding = state.holding.filter((x) => x.id !== h.id)
        } else {
          // 成本按“剩余的买入记录”重算；无剩余买入记录则沿用原成本价
          const remainBuys = state.closed.filter((x) => x.code === code && (x.type === 'BUY'))
          let buyPrice = h.buyPrice, buyFee = h.buyFee
          if (remainBuys.length) {
            const totQty = remainBuys.reduce((a, b) => a + (b.qty || 0), 0)
            if (totQty > 0) {
              buyPrice = +(remainBuys.reduce((a, b) => a + (b.price || 0) * (b.qty || 0), 0) / totQty).toFixed(3)
              buyFee = +(remainBuys.reduce((a, b) => a + (b.fee || 0), 0)).toFixed(2)
            }
          }
          state.holding = state.holding.map((x) => x.id === h.id ? { ...x, qty: newQty, buyPrice, buyFee } : x)
        }
      } else if (delta > 0) {
        // 删掉卖出记录、但持仓已不存在 → 重建一笔持仓（用该卖出记录的成本价）
        const src = toDelete.find((r) => r.code === code && (r.type === 'SELL' || r.type === 'CLOSE'))
        state.holding = [...state.holding, {
          id: uid(), code, name: (src && src.name) || code,
          buyPrice: (src && (src.costPrice || src.buyPrice)) || (src && src.price) || 0,
          buyAt: Date.now(), qty: delta,
          buyFee: (src && src.buyFee) || 0,
        }]
      }
    }
    emit()
  },
  // 预估删除某条记录对持仓的联动影响（供 UI 二次确认提示）
  removeClosedImpact(id) {
    const target = state.closed.find((x) => x.id === id)
    if (!target) return null
    const toDelete = target.batchId
      ? state.closed.filter((x) => x.batchId === target.batchId)
      : [target]
    const impact = {}
    for (const r of toDelete) {
      const t = r.type || r.kind
      if (t === 'BUY') impact[r.code] = { name: r.name, delta: (impact[r.code]?.delta || 0) - (r.qty || 0) }
      else if (t === 'SELL' || t === 'CLOSE') impact[r.code] = { name: r.name, delta: (impact[r.code]?.delta || 0) + (r.qty || 0) }
    }
    return Object.values(impact).filter((x) => x.delta !== 0)
  },
  // 计算某条记录删除时会级联影响的记录数（供 UI 二次确认提示）
  batchSize(id) {
    const target = state.closed.find((x) => x.id === id)
    if (target && target.batchId) return state.closed.filter((x) => x.batchId === target.batchId).length
    return 1
  },

  // ===== 做T：流水式（每次只记一腿买或卖，FIFO自动配对算收益，底仓手数不变）=====
  // side='buy'(低吸/买回) | 'sell'(高抛/卖出)
  addTFlow(id, side, price, qty) {
    const h = state.holding.find((x) => x.id === id)
    if (!h) return { ok: false, error: '持仓不存在或已被删除' }
    const requested = Number(qty) || 1
    const p = Number(price)
    if (requested <= 0 || !p) return { ok: false, error: '请输入有效的价格和手数' }
    let q = requested
    if (side === 'sell') {
      const t1 = t1StatusOf(h.code)
      const allowance = computeSellAllowance(requested, t1.sellableToday)
      if (!allowance.ok) {
        return { ok: false, error: `今日买入 ${t1.boughtToday} 手仍受 T+1 锁定，当前不能记录卖出腿` }
      }
      q = allowance.allowed
    }
    snapshot(`做T ${side === 'buy' ? '低吸' : '高抛'} ${h.name || h.code}`)
    const amount = p * q * 100
    const fee = side === 'buy' ? calcBuyFee(amount) : calcSellFee(amount)
    const cashFlow = tFlowCashFlow(side, p, q, fee)
    const flow = {
      id: uid(),
      side,
      price: p,
      qty: q,
      fee,
      cashFlow,
      cashApplied: updateAccountCash(cashFlow),
      at: Date.now(),
    }
    const baseQty = h.baseQty || h.qty
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, baseQty, tFlows: [...(x.tFlows || []), flow] }
      : x)
    emit()
    return {
      ok: true,
      qty: q,
      adjusted: q < requested,
      message: q < requested ? `受 T+1 限制，本次卖出腿仅记录 ${q} 手` : '',
    }
  },
  // 删除某笔做T流水（持仓上的收益/成本自动重算）
  removeTFlow(id, flowId) {
    const h = state.holding.find((item) => item.id === id)
    const flow = h && (h.tFlows || []).find((item) => item.id === flowId)
    if (!flow) return
    snapshot('删除做T流水')
    if (flow.cashApplied) updateAccountCash(-Number(flow.cashFlow || 0))
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, tFlows: (x.tFlows || []).filter((f) => f.id !== flowId) }
      : x)
    emit()
  },
  updateTFlowDate(id, flowId, dateText) {
    const h = state.holding.find((item) => item.id === id)
    const flow = h && (h.tFlows || []).find((item) => item.id === flowId)
    if (!h || !flow) return { ok: false, error: '做T流水不存在或已被删除' }
    const nextAt = replaceLocalDate(flow.at, dateText)
    if (!nextAt) return { ok: false, error: '请选择今天或更早的有效日期' }

    snapshot(`修改做T日期 ${h.name || h.code || ''}`.trim())
    state.holding = state.holding.map((item) => item.id === id
      ? {
          ...item,
          tFlows: (item.tFlows || []).map((value) =>
            value.id === flowId
              ? { ...value, at: nextAt, editedAt: Date.now() }
              : value
          ),
        }
      : item)
    emit()

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    if (nextAt < todayStart.getTime()) this.autoSettleTFlows()
    return { ok: true }
  },
  // 编辑某笔做T流水（改方向/价格/手数，手续费按新值重算）
  editTFlow(id, flowId, { side, price, qty }) {
    const p = Number(price), q = Number(qty)
    if (!p || !(q > 0)) return { ok: false, error: '请输入有效的价格和手数' }
    const h = state.holding.find((x) => x.id === id)
    const oldFlow = h && (h.tFlows || []).find((f) => f.id === flowId)
    if (!h || !oldFlow) return { ok: false, error: '做T流水不存在或已被删除' }
    let finalQty = q
    if (side === 'sell') {
      const t1 = t1StatusOf(h.code)
      const released = oldFlow.side === 'sell' ? Number(oldFlow.qty) || 0 : 0
      const allowance = computeSellAllowance(q, t1.sellableToday + released)
      if (!allowance.ok) {
        return { ok: false, error: `今日买入 ${t1.boughtToday} 手仍受 T+1 锁定，当前不能改成卖出腿` }
      }
      finalQty = allowance.allowed
    }
    snapshot('编辑做T流水')
    const amount = p * finalQty * 100
    const fee = side === 'buy' ? calcBuyFee(amount) : calcSellFee(amount)
    const cashFlow = tFlowCashFlow(side, p, finalQty, fee)
    const cashApplied = oldFlow.cashApplied
      ? updateAccountCash(cashFlow - Number(oldFlow.cashFlow || 0))
      : false
    state.holding = state.holding.map((x) => x.id === id
      ? {
          ...x,
          tFlows: (x.tFlows || []).map((f) => f.id === flowId
            ? { ...f, side, price: p, qty: finalQty, fee, cashFlow, cashApplied }
            : f),
        }
      : x)
    emit()
    return {
      ok: true,
      qty: finalQty,
      adjusted: finalQty < q,
      message: finalQty < q ? `受 T+1 限制，本次卖出腿仅保留 ${finalQty} 手` : '',
    }
  },

  // 结算做T：把该笔持仓的做T流水固化进交易记录（配对差价=做T；净买入=加仓；净卖出=减仓/清仓），
  // 并按净额调整底仓手数，清空做T流水。做T是当日行为，跨天自动触发（见 autoSettleTFlows）。
  settleTFlows(id) {
    const h = state.holding.find((x) => x.id === id)
    if (!h || !(h.tFlows && h.tFlows.length)) return
    snapshot(`结算做T ${h.name || h.code}`)
    const r = computeTFlows(h.tFlows)
    const archived = archiveTFlows(h, uid())
    // 净额调整底仓：净买入加仓(+)、净卖出减仓(−)
    const net = (r.openBuy || 0) - (r.openSell || 0)
    const newQty = h.qty + net
    if (archived.length) state.closed = [...archived, ...state.closed].slice(0, 300)
    if (newQty <= 0) {
      // 全部卖光 → 清仓，移除持仓
      state.holding = state.holding.filter((x) => x.id !== id)
      this._backToPlan(h) // 清仓自动回归自选股
    } else {
      // 加仓时按加权平均更新成本价；减仓成本价不变
      let newBuyPrice = h.buyPrice
      if (r.openBuy > 0 && r.openBuyAvg != null) {
        newBuyPrice = +(((h.buyPrice * h.qty) + (r.openBuyAvg * r.openBuy)) / (h.qty + r.openBuy)).toFixed(3)
      }
      state.holding = state.holding.map((x) => x.id === id
        ? { ...x, qty: newQty, buyPrice: newBuyPrice, tFlows: [] }
        : x)
    }
    emit()
  },

  // 自动结算：把「所有做T流水都发生在今天之前」的持仓自动结算（做T为当日行为，跨天自动兑现）
  // 应用启动 & 每次数据变更后调用；只结算历史天，当天流水保持可编辑。
  autoSettleTFlows() {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const todayStart = start.getTime()
    const toSettle = (state.holding || []).filter((h) =>
      h.tFlows && h.tFlows.length && h.tFlows.every((f) => f.at < todayStart)
    )
    if (!toSettle.length) return false
    for (const h of toSettle) {
      // 复用 settleTFlows 逻辑（逐个结算）
      const cur = state.holding.find((x) => x.id === h.id)
      if (!cur || !(cur.tFlows && cur.tFlows.length)) continue
      const r = computeTFlows(cur.tFlows)
      const archived = archiveTFlows(cur, uid())
      const net = (r.openBuy || 0) - (r.openSell || 0)
      const newQty = cur.qty + net
      if (archived.length) state.closed = [...archived, ...state.closed].slice(0, 300)
      if (newQty <= 0) {
        state.holding = state.holding.filter((x) => x.id !== cur.id)
        this._backToPlan(cur) // 次日自动结算净卖光 → 清仓回归自选股
      } else {
        let newBuyPrice = cur.buyPrice
        if (r.openBuy > 0 && r.openBuyAvg != null) {
          newBuyPrice = +(((cur.buyPrice * cur.qty) + (r.openBuyAvg * r.openBuy)) / (cur.qty + r.openBuy)).toFixed(3)
        }
        state.holding = state.holding.map((x) => x.id === cur.id
          ? { ...x, qty: newQty, buyPrice: newBuyPrice, tFlows: [] }
          : x)
      }
    }
    emit()
    return true
  },

  // 仅判断是否在「计划买入」候选中（用于加自选按钮态）
  has(code) {
    return state.plan.some((x) => x.code === code)
  },

  // ===== 账户资产（仓位/资金管理）=====
  // account: { totalAssets(总资产,元), cash(可用资金,元), goal(目标总资产,元), updatedAt }
  setAccount(patch) {
    state.account = { ...(state.account || {}), ...patch, updatedAt: Date.now() }
    emit()
  },

  // ===== 交易计划与纪律：给某持仓设/改止盈、止损、计划仓位、买入理由 =====
  // 用 hasOwnProperty 判断字段是否传入，传了就覆盖（含 null=清空），没传才保留旧值
  // tpManual/slManual: 是否被用户手动改过(true=停止跟随AI, false/缺省=跟随AI建议自动更新)
  setPlanRule(id, rule) {
    const has = (k) => Object.prototype.hasOwnProperty.call(rule, k)
    state.holding = state.holding.map((x) => x.id === id
      ? {
          ...x,
          tp: has('tp') ? rule.tp : x.tp,
          sl: has('sl') ? rule.sl : x.sl,
          tpManual: has('tpManual') ? rule.tpManual : x.tpManual,
          slManual: has('slManual') ? rule.slManual : x.slManual,
          planReason: has('planReason') ? rule.planReason : x.planReason,
          reasonManual: has('reasonManual') ? rule.reasonManual : x.reasonManual,
          planWeight: has('planWeight') ? rule.planWeight : x.planWeight,
        }
      : x)
    // 止盈/止损变了 → 同步刷新其联动的到价预警
    if (has('tp') || has('sl')) this._syncPlanAlerts(id)
    emit()
  },
  // 清除某持仓的交易计划（止盈/止损/理由）+ 其联动的到价预警
  clearPlanRule(id) {
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, tp: null, sl: null, tpManual: false, slManual: false, planReason: null, reasonManual: false, planWeight: null } : x)
    state.alerts = (state.alerts || []).filter((a) => a.planId !== id) // 移除计划联动预警
    emit()
  },
  // 清仓回归自选：持仓清空(手动清仓/做T净卖光/次日自动结算)后不直接抹掉这只票,
  // 而是把它放回自选股区继续盯盘。仅在「已无该股其它持仓笔」且「自选里还没有」时加入,避免重复。
  // 注意:此处不 emit,由调用方(sell/settleTFlows/autoSettleTFlows)统一 emit。
  _backToPlan(h) {
    if (!h || !h.code) return
    if (state.holding.some((x) => String(x.code) === String(h.code))) return // 同股还有别的持仓笔 → 不回归
    if (state.plan.some((x) => String(x.code) === String(h.code))) return    // 自选已存在 → 不重复
    state.plan = [...state.plan, {
      code: h.code, name: h.name, note: '清仓后回归盯盘', addedAt: Date.now(),
      ...(h.qScore != null ? { qScore: h.qScore, qBias: h.qBias, qAt: h.qAt } : {}),
      ...(h.industry ? { industry: h.industry } : {}),
    }]
  },
  // 计划联动预警同步:按持仓当前 tp/sl 重建到价预警(止盈 gte / 止损 lte),planId=持仓id。
  // 建仓自动带计划、手动改计划、AI建议刷新自动跟随 —— 三处都走这一个口子,保证预警永远与计划一致。
  // 三条防刷屏纪律:
  //   ① 全局开关 settings.aiAutoAlert===false → 不生成任何 AI 自动预警;
  //   ② 静音:用户删掉某条 AI 自动预警会在持仓上落 muteTp/muteSl,此处永久跳过(删除即生效,不再被加回);
  //   ③ 价位没变则「原样保留」旧预警(含 enabled/triggeredAt),不重新武装、不重复响铃。
  _syncPlanAlerts(id) {
    const h = state.holding.find((x) => x.id === id)
    if (!h) return
    if (state.settings && state.settings.aiAutoAlert === false) {
      state.alerts = (state.alerts || []).filter((a) => a.planId !== id)
      return
    }
    const old = (state.alerts || []).filter((a) => a.planId === id)
    const rest = (state.alerts || []).filter((a) => a.planId !== id)
    const rebuilt = []
    const t1 = t1StatusOf(h.code)
    const build = (op, value, note, muted) => {
      if (muted) return                                  // 用户删过 → 永久不再生成
      if (value == null) return
      const v = Number(value)
      const prev = old.find((a) => a.op === op)
      if (prev && Number(prev.value) === v) {
        rebuilt.push(applyT1ToAlert(prev, t1))
        return
      }
      rebuilt.push(applyT1ToAlert({
        id: uid(), enabled: true, createdAt: Date.now(), triggeredAt: null, triggeredMsg: '',
        code: h.code, name: h.name, type: 'price', op, value: v, note, planId: id,
        phase: 'armed', // 智能确认:到价先弱提醒(watching)、确认到真时机才强提示(confirmed)
      }, t1))
    }
    build('gte', h.tp, '止盈', h.muteTp)
    build('lte', h.sl, '止损', h.muteSl)
    state.alerts = [...rebuilt, ...rest]
  },
  // 给候选(计划买入)预设交易计划：目标买入价/止盈/止损/理由/计划仓位
  setCandPlan(code, plan) {
    state.plan = state.plan.map((x) => x.code === code ? { ...x, ...plan } : x)
    emit()
  },
  applyAssistantProposal(rawProposal) {
    let proposal = sanitizeTradeProposal(rawProposal, rawProposal?.evidenceIds)
    if (!proposal) return { ok: false, error: '提案字段无效，未写入账本' }
    if (!proposal.evidenceIds.length) return { ok: false, error: '提案缺少数据证据，未写入账本' }
    const alreadyApplied = (state.decisionLog || []).some((event) =>
      event && event.kind === 'plan' && event.proposalId === proposal.id
    )
    if (alreadyApplied) return { ok: true, alreadyApplied: true }
    const holder = state.holding.find((item) => item.code === proposal.code)
    if (['add', 'reduce', 'sell'].includes(proposal.action) && !holder) {
      return { ok: false, error: '当前未持有该股，不能建立加仓或卖出计划' }
    }
    if (holder && ['reduce', 'sell'].includes(proposal.action)) {
      const sellable = t1StatusOf(proposal.code).sellableToday
      if (!(sellable > 0)) return { ok: false, error: '当前没有可卖仓位，提案未写入' }
      if (proposal.qty != null && proposal.qty > sellable) {
        return { ok: false, error: `计划 ${proposal.qty} 手超过今日可卖 ${sellable} 手，提案未写入` }
      }
    }
    const alert = proposalAlertSpec(proposal)
    if (!alert) return { ok: false, error: '提案无法生成有效预警' }
    snapshot(`确认助手提案 ${proposal.name}`)
    if (holder) {
      state.holding = state.holding.map((item) => item.id === holder.id ? {
        ...item,
        ...(proposal.targetPrice != null ? { tp: proposal.targetPrice, tpManual: true } : {}),
        ...(proposal.stopPrice != null ? { sl: proposal.stopPrice, slManual: true } : {}),
        planReason: proposal.reason || item.planReason,
        reasonManual: true,
      } : item)
      this._syncPlanAlerts(holder.id)
    } else {
      if (!state.plan.some((item) => item.code === proposal.code)) {
        state.plan = [...state.plan, { code: proposal.code, name: proposal.name, addedAt: Date.now() }]
      }
      state.plan = state.plan.map((item) => item.code === proposal.code ? {
        ...item,
        targetPrice: proposal.entryPrice,
        targetManual: true,
        ...(proposal.targetPrice != null ? { tp: proposal.targetPrice } : {}),
        ...(proposal.stopPrice != null ? { sl: proposal.stopPrice } : {}),
        planReason: proposal.reason,
        buyQty: proposal.qty || item.buyQty,
        qtyManual: proposal.qty != null ? true : item.qtyManual,
        assistantProposalId: proposal.id,
      } : item)
    }
    if (!(state.alerts || []).some((item) => item.proposalId === proposal.id)) {
      state.alerts = [{
        id: uid(), enabled: true, createdAt: Date.now(), triggeredAt: null, triggeredMsg: '',
        ...alert, timing: proposal.confirmSignal, opQty: proposal.qty ? `${proposal.qty}手` : '',
        evidenceIds: proposal.evidenceIds,
      }, ...(state.alerts || [])]
    }
    state.decisionLog = [{
      id: `plan_${proposal.id}`, kind: 'plan', proposalId: proposal.id,
      code: proposal.code, name: proposal.name, action: proposal.action,
      entryPrice: proposal.entryPrice, qty: proposal.qty || null,
      evidenceIds: proposal.evidenceIds, source: 'assistant', at: Date.now(),
    }, ...(state.decisionLog || [])].slice(0, 1000)
    emit()
    return { ok: true, proposal }
  },
  // 给某笔持仓回写附加元信息(如行业 industry，用于持仓区板块分类)——非结构性字段，不影响成本/手数。
  setHoldingMeta(id, meta) {
    state.holding = state.holding.map((x) => x.id === id ? { ...x, ...meta } : x)
    emit()
  },
  // 自选股「买点预警」自动同步：跟随 AI 操作建议的【建议买入价】,自动建一条【到价 ≤ 买入价】预警,
  // 价格跌到买点即提醒去买入。规则:每只自选股只自动设这一条(买点),不把止盈/止损全设上——
  // 未持仓阶段最有用的就是「到买点提醒买入」,其余等买入后由持仓计划联动生成。
  //   candCode: 该预警所绑定的自选股代码(区别于持仓计划联动的 planId)
  //   alertSyncedPrice(记在候选上): 上次自动同步过的买价 —— 相同价不重复写,用户删掉也不会被反复自动加回;
  //   AI 买价变化时(≠ alertSyncedPrice)才会重新同步/重新武装。
  autoSyncCandAlert(code, name, buyPrice, advice = null) {
    if (buyPrice == null || isNaN(buyPrice)) return
    if (state.settings && state.settings.aiAutoAlert === false) return // 全局关闭 AI 自动预警
    const judgeContext = buildJudgeAdviceContext(advice || {})
    const triggerZone = judgeContext.addZone
    const v = roundPx(triggerZone?.high ?? buyPrice)
    const p = state.plan.find((x) => x.code === code)
    if (!p) return
    if (p.alertMuted) return                                            // 用户删过买点预警 → 永久不再自动加回
    if (p.alertSyncedPrice != null && Number(p.alertSyncedPrice) === Number(v)) return // 该买价已处理过
    const existing = (state.alerts || []).find((a) => a.candCode === code)
    if (existing) {
      // 已有买点预警 → 跟随 AI 新买价刷新到价并重新武装
      state.alerts = (state.alerts || []).map((a) => a.candCode === code
        ? {
            ...a,
            name: name || a.name,
            type: 'price',
            op: 'lte',
            value: Number(v),
            ...(
              triggerZone
                ? { triggerZone, judgeContext }
                : {}
            ),
            ...(
              triggerZone
              && a.judgeContext?.planId === judgeContext.planId
                ? {}
                : {
                    enabled: true,
                    triggeredAt: null,
                    triggeredMsg: '',
                    phase: 'armed',
                  }
            ),
          }
        : a)
    } else {
      // 新建买点到价预警(≤ 建议买入价)
      state.alerts = [{
        id: uid(), enabled: true, createdAt: Date.now(), triggeredAt: null, triggeredMsg: '',
        code, name, type: 'price', op: 'lte', value: Number(v), note: '买点', candCode: code,
        phase: 'armed',
        ...(triggerZone ? { triggerZone, judgeContext } : {}),
      }, ...(state.alerts || [])]
    }
    state.plan = state.plan.map((x) => x.code === code ? { ...x, alertSyncedPrice: v } : x)
    emit()
  },

  // 「行动点」自动预警：跟随 AI 操作建议里的【补仓价 addPrice】/【减仓价 reducePrice】,
  // 自动建 到价预警,价一到就通知用户「现在是补/减仓的时候了」,直接回应「节点把握不准、太抽象」的诉求。
  //   补仓:到价 ≤ addPrice(回踩到位) → op='lte', actKind='add'
  //   减仓:到价 ≥ reducePrice(反弹到位) → op='gte', actKind='reduce'
  // 通知里带上【要做什么(opQty,如 补1手/减1手)】+【到价后怎么确认(exitTiming)】——
  //   遵循「到价=开始盯,不是见价即砍」纪律(A股 T+1),先确认信号再动手。
  //   actCode: 绑定的股票代码(区别于持仓 planId / 候选 candCode);actKind: 'add' | 'reduce'
  // 三条纪律与 _syncPlanAlerts 一致:
  //   ① 全局开关 settings.aiAutoAlert===false → 不生成、并清掉旧的;
  //   ② 用户删过 → 落 muteAdd/muteReduce(记在同 code 的持仓或候选上),永久不再自动加回;
  //   ③ 价位没变则「原样保留」旧预警(含触发态),不重新武装、不重复响铃。
  syncActionAlerts(code) {
    if (!code) return
    const rest = (state.alerts || []).filter((a) => a.actCode !== code)
    if (state.settings && state.settings.aiAutoAlert === false) {
      state.alerts = rest
      emit()
      return
    }
    let adv = null
    try { adv = (getAdvice(code) || {}).advice } catch { adv = null }
    if (!adv) { state.alerts = rest; emit(); return }
    // 该 code 可能在持仓或自选里,静音标记落在哪就读哪(取到即用)
    const holder = state.holding.find((x) => x.code === code)
    const cand = state.plan.find((x) => x.code === code)
    const owner = holder || cand || {}
    const name = adv.name || owner.name || code
    // opQty 是「补1手/减1手」这类操作量标签;actionPlan/exitTiming 给「到价后怎么确认」
    const opQty = adv.opQty || ''
    const timing = adv.exitTiming || adv.actionPlan || ''
    const judgeContext = buildJudgeAdviceContext(adv)
    const t1 = holder ? t1StatusOf(code) : null
    const old = (state.alerts || []).filter((a) => a.actCode === code)
    const rebuilt = []
    const build = (kind, op, price, muted) => {
      if (muted) return
      const triggerZone = kind === 'add'
        ? judgeContext.addZone
        : judgeContext.reduceZone
      const zoneTrigger = kind === 'add'
        ? triggerZone?.high
        : triggerZone?.low
      const triggerPrice = zoneTrigger ?? price
      if (triggerPrice == null || isNaN(triggerPrice)) return
      const v = roundPx(triggerPrice)
      if (v == null || !(Number(v) > 0)) return
      const actionQty = kind === 'add'
        ? (/加仓|补仓|买回|接回/.test(opQty) ? opQty : '')
        : (/减仓|卖出|清仓/.test(opQty) ? opQty : '')
      const note = kind === 'add' ? '补仓点' : '减仓点'
      const prev = old.find((a) => a.actKind === kind)
      const samePlan = !!(
        prev?.judgeContext?.planId
        && judgeContext.planId
        && prev.judgeContext.planId === judgeContext.planId
      )
      if (prev && (Number(prev.value) === Number(v) || samePlan)) {
        rebuilt.push(applyT1ToAlert({
          ...prev,
          value: Number(v),
          opQty: actionQty,
          timing,
          ...(triggerZone ? { triggerZone } : {}),
          judgeContext,
        }, kind === 'reduce' ? t1 : null))
        return
      }
      rebuilt.push(applyT1ToAlert({
        id: uid(), enabled: true, createdAt: Date.now(), triggeredAt: null, triggeredMsg: '',
        code, name, type: 'price', op, value: Number(v), note,
        actCode: code, actKind: kind, opQty: actionQty, timing,
        ...(triggerZone ? { triggerZone } : {}),
        judgeContext,
        phase: 'armed',
      }, kind === 'reduce' ? t1 : null))
    }
    if (adviceSupportsIntent('add', judgeContext)) {
      build('add', 'lte', adv.addPrice, owner.muteAdd)
    }
    build('reduce', 'gte', adv.reducePrice, owner.muteReduce)
    state.alerts = [...rebuilt, ...rest]
    emit()
  },

  // ===== 预警规则 =====
  // alert: { id, code, name, type, op, value, note, enabled, createdAt, triggeredAt, triggeredMsg }
  //   type: price(到价) | pct(涨跌幅) | vol(量比) | turnover(换手) | ma(均线突破/跌破) | limit(涨跌停临近)
  //   op:   gte(>=) | lte(<=)
  addAlert(a) {
    const alert = {
      id: uid(), enabled: true, createdAt: Date.now(),
      triggeredAt: null, triggeredMsg: '',
      ...a,
    }
    state.alerts = [alert, ...(state.alerts || [])]
    emit()
    return alert
  },
  updateAlert(id, patch) {
    state.alerts = (state.alerts || []).map((x) => x.id === id ? { ...x, ...patch } : x)
    emit()
  },
  // 删除预警。若删的是 AI 自动预警(planId 止盈/止损 或 candCode 买点),同时在对应持仓/候选上落"静音",
  // 保证【删除即永久生效】——下次 AI 建议刷新不会把它偷偷加回来(直接回应用户"删了会不会又冒出来")。
  removeAlert(id) {
    const a = (state.alerts || []).find((x) => x.id === id)
    if (a) {
      if (a.planId) {
        const key = a.op === 'gte' ? 'muteTp' : 'muteSl'
        state.holding = state.holding.map((h) => h.id === a.planId ? { ...h, [key]: true } : h)
      } else if (a.candCode) {
        state.plan = state.plan.map((p) => p.code === a.candCode ? { ...p, alertMuted: true } : p)
      } else if (a.actCode) {
        // 行动点预警删除 → 落静音(补/减各自独立),同 code 的持仓或候选上都打标记,永久不再自动加回
        const key = a.actKind === 'add' ? 'muteAdd' : 'muteReduce'
        state.holding = state.holding.map((h) => h.code === a.actCode ? { ...h, [key]: true } : h)
        state.plan = state.plan.map((p) => p.code === a.actCode ? { ...p, [key]: true } : p)
      }
    }
    state.alerts = (state.alerts || []).filter((x) => x.id !== id)
    emit()
  },
  // 批量删除:传入 id 数组,一次删干净(供面板"删除全部已触发/按股清理"用)。同样为每条 AI 自动预警落静音。
  removeAlerts(ids) {
    const set = new Set(ids || [])
    if (!set.size) return
    for (const a of (state.alerts || [])) {
      if (!set.has(a.id)) continue
      if (a.planId) {
        const key = a.op === 'gte' ? 'muteTp' : 'muteSl'
        state.holding = state.holding.map((h) => h.id === a.planId ? { ...h, [key]: true } : h)
      } else if (a.candCode) {
        state.plan = state.plan.map((p) => p.code === a.candCode ? { ...p, alertMuted: true } : p)
      } else if (a.actCode) {
        const key = a.actKind === 'add' ? 'muteAdd' : 'muteReduce'
        state.holding = state.holding.map((h) => h.code === a.actCode ? { ...h, [key]: true } : h)
        state.plan = state.plan.map((p) => p.code === a.actCode ? { ...p, [key]: true } : p)
      }
    }
    state.alerts = (state.alerts || []).filter((x) => !set.has(x.id))
    emit()
  },
  // AI 自动预警总开关:关 → 清掉所有 planId/candCode 联动预警且今后不再生成;开 → 允许下次刷新重建(受各自静音约束)。
  setAiAutoAlert(on) {
    state.settings = { ...(state.settings || {}), aiAutoAlert: !!on }
    if (!on) state.alerts = (state.alerts || []).filter((a) => !a.planId && !a.candCode && !a.actCode)
    emit()
  },
  // 解除某只股票的 AI 预警静音(用户改主意想重新自动跟随):清掉持仓 muteTp/muteSl / 候选 alertMuted + alertSyncedPrice / 行动点 muteAdd/muteReduce。
  unmuteStockAlert(code) {
    state.holding = state.holding.map((h) => h.code === code ? { ...h, muteTp: false, muteSl: false, muteAdd: false, muteReduce: false } : h)
    state.plan = state.plan.map((p) => p.code === code ? { ...p, alertMuted: false, alertSyncedPrice: null, muteAdd: false, muteReduce: false } : p)
    emit()
  },
  toggleAlert(id) {
    state.alerts = (state.alerts || []).map((x) => x.id === id ? { ...x, enabled: !x.enabled } : x)
    emit()
  },
  // 标记预警已触发（供预警引擎回写；只在未触发或重新武装时更新）
  markAlertTriggered(id, msg) {
    state.alerts = (state.alerts || []).map((x) => x.id === id
      ? { ...x, triggeredAt: Date.now(), triggeredMsg: msg, enabled: false } // 触发后自动停用，避免重复提醒
      : x)
    emit()
  },
  // 重新武装预警（用户手动重启）
  rearmAlert(id) {
    state.alerts = (state.alerts || []).map((x) => x.id === id
      ? {
          ...x,
          enabled: true,
          triggeredAt: null,
          triggeredMsg: '',
          rearmedAt: Date.now(),
          phase: x.phase ? 'armed' : x.phase,
          watchingAt: null,
          watchingPrice: null,
          watchingMsg: '',
          lastJudgeAt: null,
          lastJudgeDecision: null,
          lastJudgeConfidence: null,
          lastJudgePolicy: null,
          lastJudgePrice: null,
          judgeOutcomes: {},
        } : x)
    emit()
  },
  // 智能确认闸门:进入「观察确认中」——到价发弱提醒后置 watching(不停用、继续监控真正时机)
  markAlertWatching(id, msg, price = null) {
    state.alerts = (state.alerts || []).map((x) => x.id === id && x.phase !== 'watching' && x.phase !== 'confirmed'
      ? { ...x, phase: 'watching', watchingAt: Date.now(), watchingPrice: Number(price) || null, watchingMsg: msg || x.watchingMsg || '' }
      : x)
    emit()
  },
  markAlertJudged(id, verdict, price = null) {
    state.alerts = (state.alerts || []).map((x) => x.id === id
      ? {
          ...x,
          lastJudgeAt: Date.now(),
          lastJudgeDecision: verdict?.decision || 'wait',
          lastJudgeConfidence: verdict?.confidence ?? null,
          lastJudgePolicy: verdict?.policy || null,
          lastJudgePrice: Number(price) || null,
          judgeCount: (Number(x.judgeCount) || 0) + 1,
        }
      : x)
    emit()
  },
  // 智能确认闸门:确认真正交易时机到 → 置 confirmed 并停用(发强提示后不再重复)
  markAlertConfirmed(id, msg, verdict = null, price = null) {
    const triggeredAt = Date.now()
    state.alerts = (state.alerts || []).map((x) => x.id === id
      ? {
          ...x,
          phase: 'confirmed',
          triggeredAt,
          triggeredMsg: msg,
          enabled: false,
          decisionPrice: Number(price) || x.lastJudgePrice || null,
          decisionSide: verdict?.side || null,
          judgeOutcomes: {},
        }
      : x)
    const confirmed = state.alerts.find((alert) => alert.id === id)
    if (confirmed) {
      const judgeEvent = {
        id: `judge:${id}`,
        kind: 'judge',
        alertId: id,
        at: triggeredAt,
        code: confirmed.code,
        name: confirmed.name || confirmed.code,
        decisionSide: confirmed.decisionSide,
        decisionPrice: confirmed.decisionPrice,
        confidence: verdict?.confidence ?? null,
        policy: verdict?.policy || null,
        reason: verdict?.reason || '',
        judgeOutcomes: {},
      }
      state.decisionLog = [
        judgeEvent,
        ...(state.decisionLog || []).filter((event) => event?.id !== judgeEvent.id),
      ].slice(0, 1000)
    }
    emit()
  },
  // 智能确认闸门:交易逻辑已被破坏(如买点却已放量跌破失效价)→ 置 invalid 并停用,不再纠缠
  markAlertInvalid(id, msg) {
    state.alerts = (state.alerts || []).map((x) => x.id === id
      ? { ...x, phase: 'invalid', triggeredAt: Date.now(), triggeredMsg: msg, enabled: false }
      : x)
    emit()
  },
  // 智能确认总开关:关 → 恢复「见价即触发」的旧行为(不做二段确认)。默认开启。
  setSmartConfirm(on) {
    state.settings = { ...(state.settings || {}), smartConfirm: !!on }
    emit()
  },

  // ===== 复盘结论（每只股只留最新一条，指导下一段/次日操作）=====
  // review: { code, name, at, session:'noon'|'close'|'manual', dayKey, result:{...LLM结论}, snap:{price,pnlPct,...} }
  // 只保留最新：同 code 直接覆盖。
  saveReview(code, review) {
    if (!code) return
    state.reviews = { ...(state.reviews || {}), [code]: { ...review, code, at: Date.now() } }
    emit()
  },
  getReview(code) { return (state.reviews || {})[code] || null },
  removeReview(code) {
    if (!state.reviews || !state.reviews[code]) return
    const next = { ...state.reviews }; delete next[code]
    state.reviews = next; emit()
  },

  // ===== AI建议决策记录 + 事后回测（用真实结果给建议可信度背书）=====
  // entry: { code,name,mode,action,tone,entryPrice,stop,target,trust,resonance,priceAtAdvice }
  logAdvice(entry) {
    if (!entry || !entry.code) return
    const rec = {
      id: uid(), at: Date.now(), verified: false, hit: null, resultPct: null,
      ...entry,
    }
    // 同股同模式10分钟内不重复记录，避免刷屏
    const dup = (state.adviceLog || []).find((x) => x.code === entry.code && x.mode === entry.mode && (Date.now() - x.at) < 600000)
    if (dup) return
    state.adviceLog = [rec, ...(state.adviceLog || [])].slice(0, 500)
    state.decisionLog = [
      createRecommendation({ ...entry, id: rec.id, at: rec.at }),
      ...(state.decisionLog || []),
    ].slice(0, 1000)
    emit()
  },
  _recordExecution(entry) {
    if (!entry || !entry.code) return null
    state.decisionLog = appendExecution(state.decisionLog, entry)
    return state.decisionLog[0] || null
  },
  decisionStats() {
    return decisionLedgerStats(state.decisionLog)
  },
  // 事后核验（短线实战口径）：传入 {code: 日K线数组[{date,open,close,high,low}]}
  // 判定窗口=建议日之后 3 个交易日。看多：窗口内"最高价触及目标价"即命中(可提前结算)，
  // 无目标价时看 3 日内最大涨幅≥2%；看空/观望：3 日内没明显上涨(<2%)即命中。
  // 持有(已在仓的中性决策)：跌破止损即判负，否则回撤在容忍内(≥-3%)即算持有正确——不要求必须上涨。
  // 窗口未走完且未提前命中 → 保持待核验，绝不用单日收盘草率判死。
  verifyAdvice(candleMap) {
    if (!candleMap) return
    const DAY = 24 * 3600 * 1000
    const WINDOW = 3               // 3个交易日窗口
    const BULL_TH = 2              // 看多兜底/看空阈值：3日内最大涨幅百分比
    let changed = false
    const toYmd = (ts) => {
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    state.adviceLog = (state.adviceLog || []).map((r) => {
      if (!adviceNeedsVerification(r)) return r
      if (Date.now() - r.at < DAY) return r          // 至少隔一个自然日再判
      const candles = candleMap[r.code]
      if (!Array.isArray(candles) || !candles.length || !r.priceAtAdvice) return r
      const adviceYmd = toYmd(r.at)
      // 建议日"之后"的交易日K线（严格晚于建议当天）
      const future = candles.filter((c) => c && c.date && c.date > adviceYmd)
      if (!future.length) return r                   // 隔日数据还没出 → 继续等
      const adviceDayAt = Date.parse(`${adviceYmd}T00:00:00+08:00`)
      const firstFutureAt = Date.parse(`${future[0].date}T00:00:00+08:00`)
      if (
        Number.isFinite(adviceDayAt)
        && Number.isFinite(firstFutureAt)
        && firstFutureAt - adviceDayAt > 14 * DAY
      ) return r                                     // K线未覆盖原窗口，禁止拿近期行情误重算
      const win = future.slice(0, WINDOW)            // 窗口内最多取前3个交易日
      const windowComplete = future.length >= WINDOW
      const base = r.priceAtAdvice
      const target = Number(r.target) || null
      const stop = Number(r.stop) || null
      const maxHigh = Math.max(...win.map((c) => c.high || c.close || base))
      const minLow = Math.min(...win.map((c) => c.low || c.close || base))
      const minClose = Math.min(...win.map((c) => c.close || base))
      const lastClose = win[win.length - 1].close || base
      const maxUpPct = +(((maxHigh - base) / base) * 100).toFixed(2)   // 窗口内最大有利波动
      const maxDownPct = +(((minLow - base) / base) * 100).toFixed(2)  // 窗口内最大不利波动(负数)
      const closePct = +(((lastClose - base) / base) * 100).toFixed(2) // 窗口末收盘涨幅

      // 【持有/持股】是中性决策(已在仓，继续拿)：判对口径≠必须涨2%，而是"没明显下跌/没跌破止损"，
      // 否则一个"横盘微涨的正确持有"会被看多的+2%尺子误判成失败，把持仓建议胜率整体压低。
      const actionKind = adviceActionKind(r.action)
      const hold = actionKind === 'hold'
      const bull = actionKind === 'bull'
      const bear = actionKind === 'bear' || actionKind === 'wait'

      const HOLD_DOWN_TH = 3        // 持有可容忍的最大回撤%(超过即认为本应减仓)

      let hit = null, settled = false, note = ''
      if (bull) {
        if (target && maxHigh >= target) {           // 触及目标 → 提前判胜
          hit = true; settled = true
          note = `窗口内最高${maxHigh}触及目标${target}`
        } else if (windowComplete) {                 // 没触及/无目标 → 看最大涨幅
          hit = maxUpPct >= BULL_TH; settled = true
          note = target ? `3日内最高${maxHigh}未及目标${target}(最大+${maxUpPct}%)` : `3日内最大+${maxUpPct}%`
        }
      } else if (hold) {
        if (stop && minClose <= stop) {              // 收盘确认跌破止损 → 判负，盘中插针不误伤
          hit = false; settled = true
          note = `持有期内收盘最低${minClose}有效跌破止损${stop}，本应减仓`
        } else if (windowComplete) {                 // 持有看最终管理结果，不用盘中影线判死
          hit = closePct >= -HOLD_DOWN_TH; settled = true
          note = `持有期末收盘${closePct}%（容忍-${HOLD_DOWN_TH}%），盘中最大回撤${maxDownPct}%`
        }
      } else if (bear) {
        if (windowComplete) {                         // 看空/观望：没明显上涨即对
          hit = maxUpPct < BULL_TH; settled = true
          note = `3日内最大+${maxUpPct}%（看空/观望阈值${BULL_TH}%）`
        }
      } else if (windowComplete) {                     // 无法归类 → 收盘方向兜底
        hit = closePct > 0; settled = true
        note = `3日收盘${closePct}%`
      }
      if (!settled) return r
      changed = true
      return {
        ...r, verified: true, hit,
        outcomePolicyVersion: ADVICE_OUTCOME_POLICY_VERSION,
        resultPct: bull ? maxUpPct : closePct,        // 看多看最大有利波动，持有/看空看收盘
        maxUpPct, maxDownPct, closePct, maxHigh, minLow, windowDays: win.length,
        verifiedAt: Date.now(), verifyNote: note,
      }
    })
    if (changed) emit()
  },
  // 各类建议真实胜率统计（供"军师战绩"展示）
  adviceStats() {
    return summarizeAdviceOutcomes(state.adviceLog)
  },
  // 按【理论】统计真实胜率（军师"融会贯通"哪个理论在你的票上最灵）。
  // 一条建议引用多个理论 → 每个理论都计入(该建议命中则各+1胜)。
  theoryStats() {
    const log = (state.adviceLog || []).filter(isAdviceOutcomeCurrent)
    const by = {}
    for (const r of log) {
      const tags = theoryTagsOf(r.theoryNote)
      for (const tag of tags) {
        if (!by[tag]) by[tag] = { theory: tag, total: 0, hit: 0, sumPct: 0 }
        by[tag].total++; if (r.hit) by[tag].hit++
        by[tag].sumPct += Number(r.resultPct) || 0
      }
    }
    const groups = Object.values(by).map((g) => ({
      ...g,
      winRate: g.total ? Math.round((g.hit / g.total) * 100) : null,
      avgPct: g.total ? +(g.sumPct / g.total).toFixed(2) : null,
    })).sort((a, b) => (b.winRate - a.winRate) || (b.total - a.total))
    // 待归因：已落库但尚未验证的建议里，能识别出理论标签的条数
    const taggedTotal = (state.adviceLog || []).filter((r) => theoryTagsOf(r.theoryNote).length).length
    return { groups, taggedTotal }
  },

  // ===== 撤回：弹出最近一次快照并恢复（交易类操作的后悔药）=====
  canUndo() { return _undoStack.length > 0 },
  lastUndoLabel() { return _undoStack.length ? _undoStack[_undoStack.length - 1].label : null },
  undoCount() { return _undoStack.length },
  undo() {
    const snap = _undoStack.pop()
    if (!snap) return null
    const d = snap.data
    state = {
      plan: d.plan || [], holding: d.holding || [], closed: d.closed || [],
      account: d.account || null, alerts: d.alerts || [], reviews: d.reviews || {},
      adviceLog: d.adviceLog || [], decisionLog: d.decisionLog || [],
      settings: d.settings || state.settings || {},
    }
    emit() // 恢复后正常回存云端，保证撤回结果也持久化
    return snap.label
  },
}

// 某只股的【实时持仓】口径：底仓 ± 未结算做T净腿(买腿=已加仓、卖腿=已减仓)。
// 返回 { qty, cost, hasOpenT, tNetHands } 或 null(无持仓)。供 AI 建议/复盘统一使用。
export function livePositionOf(code) {
  const hs = (state.holding || []).filter((h) => h.code === code)
  if (!hs.length) return null
  let qty = 0, costSum = 0, hasOpenT = false, tNet = 0
  for (const h of hs) {
    const baseQty = h.qty || 0, baseCost = h.buyPrice || 0
    const r = computeTFlows(h.tFlows)
    const openBuy = r.openBuy || 0, openSell = r.openSell || 0
    const net = openBuy - openSell
    if (h.tFlows && h.tFlows.length && (openBuy > 0 || openSell > 0)) hasOpenT = true
    tNet += net
    const liveQty = Math.max(0, baseQty + net)
    let cost = baseCost
    if (openBuy > 0 && r.openBuyAvg != null && (baseQty + openBuy) > 0) {
      cost = ((baseCost * baseQty) + (r.openBuyAvg * openBuy)) / (baseQty + openBuy)
    }
    qty += liveQty
    costSum += cost * liveQty
  }
  if (qty <= 0) return null
  return { qty, cost: +(costSum / qty).toFixed(3), hasOpenT, tNetHands: tNet }
}

// 最近一个"北京时间零点"的时间戳(epoch ms)——不依赖沙箱本地时区，纯 epoch 运算。
// 交易流水里的 at 都是 Date.now()(epoch ms)，据此判定"是否今天(北京时间)买入"。
function bjDayStartTs() {
  const EIGHT_H = 8 * 3600000, DAY = 24 * 3600000
  return Math.floor((Date.now() + EIGHT_H) / DAY) * DAY - EIGHT_H
}

// 某只股的【T+1 锁定口径】：今日(北京时间)买入的手数当日不可卖(A股T+1)。
// 今日买入 = 建仓/加仓(closed 里今日 BUY 流水) + 今日做T买腿(holding.tFlows 里今日 side='buy')。
// 返回 { liveQty, boughtToday, sellableToday, buys }：
//   · liveQty       实时持仓手数(底仓±未结算做T净腿)
//   · boughtToday   今日买入手数(T+1 锁定，当日绝对不可卖)
//   · sellableToday 今日最多可卖手数 = max(0, liveQty − boughtToday)
//   · buys          今日买入明细 [{price,qty,at,kind}] 供AI判断加仓成本/时间
// 无持仓返回 null。供 AI 建议(hold/buy)与复盘统一遵守：卖出/减仓/清仓手数不得超过 sellableToday。
export function t1StatusOf(code) {
  const lp = livePositionOf(code)
  const liveQty = lp ? lp.qty : 0
  const t0 = bjDayStartTs()
  let boughtToday = 0
  const buys = []
  // 1) 建仓/加仓/手动补录买入：closed 里今日的 BUY 流水
  ;(state.closed || []).forEach((c) => {
    if (c.code !== code) return
    if ((c.type || c.kind) !== 'BUY') return
    const at = c.at || c.buyAt || 0
    if (at < t0) return
    boughtToday += (c.qty || 0)
    buys.push({ price: c.price, qty: c.qty, at, kind: '建仓/加仓' })
  })
  // 2) 今日做T买腿(未结算或已配对都算——今天买进的就是今天买的，当日锁定)
  ;(state.holding || []).filter((h) => h.code === code).forEach((h) => {
    ;(h.tFlows || []).forEach((f) => {
      if (f.side === 'buy' && (f.at || 0) >= t0) {
        boughtToday += (f.qty || 0)
        buys.push({ price: f.price, qty: f.qty, at: f.at, kind: '做T买腿' })
      }
    })
  })
  boughtToday = +boughtToday.toFixed(3)
  const sellableToday = Math.max(0, +(liveQty - boughtToday).toFixed(3))
  return { liveQty, boughtToday, sellableToday, buys }
}

// FIFO 配对做T流水，算已实现净收益 + 未配对(挂单)手数 + 每笔配对明细
export function computeTFlows(flows) {
  const list = [...(flows || [])].sort((a, b) => a.at - b.at)
  let realized = 0, pairs = 0
  const pairList = [] // 每笔配对成功的做T明细（供归档/展示）
  // 逐笔按时间配对：一个卖可对多个买、一个买可对多个卖(FIFO)
  const queue = { buy: [], sell: [] }
  for (const f of list) {
    const opp = f.side === 'buy' ? 'sell' : 'buy'
    let remain = f.qty
    let feeLeft = f.fee
    while (remain > 0 && queue[opp].length) {
      const head = queue[opp][0]
      const m = Math.min(remain, head.qty)
      const buyLeg = f.side === 'buy' ? f : head
      const sellLeg = f.side === 'buy' ? head : f
      const buyP = buyLeg.price
      const sellP = sellLeg.price
      const shares = m * 100
      const gross = (sellP - buyP) * shares
      // 按配对比例分摊两腿手续费
      const feeThisCur = feeLeft * (m / remain)
      const feeThisHead = head.fee * (m / head.qty)
      const feeThis = feeThisCur + feeThisHead
      const net = +(gross - feeThis).toFixed(2)
      realized += gross - feeThis
      pairs++
      // 正T=先买后卖(买腿时间在前)；反T=先卖后买(卖腿时间在前)
      const buyAt = buyLeg.at, sellAt = sellLeg.at
      pairList.push({
        qty: m,
        buyPrice: buyP, sellPrice: sellP,
        buyFee: +((f.side === 'buy' ? feeThisCur : feeThisHead)).toFixed(2),
        sellFee: +((f.side === 'buy' ? feeThisHead : feeThisCur)).toFixed(2),
        grossPnl: +gross.toFixed(2), netPnl: net,
        cashApplied: buyLeg.cashApplied === true && sellLeg.cashApplied === true,
        tDir: buyAt <= sellAt ? 'positive' : 'reverse',
        buyAt, sellAt, at: Math.max(buyAt, sellAt),
      })
      remain -= m
      feeLeft -= feeLeft * (m / (remain + m))
      head.qty -= m
      head.fee -= head.fee * (m / (head.qty + m))
      if (head.qty <= 1e-9) queue[opp].shift()
    }
    if (remain > 0) {
      queue[f.side].push({
        price: f.price,
        qty: remain,
        fee: feeLeft,
        at: f.at,
        cashApplied: f.cashApplied === true,
      })
    }
  }
  const openBuy = queue.buy.reduce((a, x) => a + x.qty, 0)
  const openSell = queue.sell.reduce((a, x) => a + x.qty, 0)
  // 开口腿（未配平的净头寸）明细：净买入=加仓，净卖出=减仓/清仓
  const openBuyAmt = queue.buy.reduce((a, x) => a + x.price * x.qty * 100, 0)
  const openBuyFee = +queue.buy.reduce((a, x) => a + x.fee, 0).toFixed(2)
  const openSellAmt = queue.sell.reduce((a, x) => a + x.price * x.qty * 100, 0)
  const openSellFee = +queue.sell.reduce((a, x) => a + x.fee, 0).toFixed(2)
  const openBuyAvg = openBuy ? +(openBuyAmt / (openBuy * 100)).toFixed(3) : null
  const openSellAvg = openSell ? +(openSellAmt / (openSell * 100)).toFixed(3) : null
  const openBuyAt = queue.buy.length ? Math.max(...queue.buy.map((x) => x.at)) : null
  const openSellAt = queue.sell.length ? Math.max(...queue.sell.map((x) => x.at)) : null
  const openBuyCashApplied = queue.buy.length > 0 && queue.buy.every((x) => x.cashApplied)
  const openSellCashApplied = queue.sell.length > 0 && queue.sell.every((x) => x.cashApplied)
  return {
    realized: +realized.toFixed(2), pairs, openBuy, openSell, pairList,
    openBuyAvg, openBuyFee, openBuyAt, openSellAvg, openSellFee, openSellAt,
    openBuyCashApplied, openSellCashApplied,
  }
}

export function usePlanStore() {
  return useSyncExternalStore(planStore.subscribe, planStore.get)
}

// AI 操作建议【结果】新增/清除时 → 触发一次防抖云端回存（随账号数据同步到其他设备）。
// adviceCache 只在本机 localStorage 保存；这个回调把它接进 planStore 的云端同步链路。
registerAdviceSync(() => { try { scheduleSave() } catch { /* ignore */ } })

// ============ 账户全景计算：传入 holding + 实时报价 quote(按code索引) + account =============
// 返回：持仓市值、成本、浮盈、总资产、可用现金、总仓位%、每笔持仓的市值/占比/浮盈
export function computePortfolio(holding, quoteMap, account) {
  // 有限数兜底:任何非有限值(NaN/字符串/Infinity)一律折成 0,防止一条脏数据把总市值/浮盈亏整列算成 NaN。
  const fin = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  const positions = (holding || []).map((h) => {
    const q = quoteMap && quoteMap[h.code]
    // 现价必须 > 0 才有效:休市/接口异常会返回 0。兜底顺序:实时现价 → 昨收 prevClose → 买入成本,
    // 保证市值/浮盈亏永远有个合理数值,既不为 0 也不会被算成 -100%。
    const price = fin(q && Number(q.price) > 0 ? q.price
      : (q && Number(q.prevClose) > 0 ? Number(q.prevClose) : h.buyPrice))
    const baseQty = fin(h.qty)
    const tFlows = computeTFlows(h.tFlows)
    const liveQty = Math.max(0, baseQty + fin(tFlows.openBuy) - fin(tFlows.openSell))
    const shares = liveQty * 100
    const mktValue = +(price * shares).toFixed(2)          // 市值
    let costValue = fin(h.buyPrice) * baseQty * 100 + fin(h.buyFee)
    if (tFlows.openBuy > 0 && tFlows.openBuyAvg != null) {
      costValue += fin(tFlows.openBuyAvg) * fin(tFlows.openBuy) * 100 + fin(tFlows.openBuyFee)
    } else if (tFlows.openSell > 0 && baseQty > 0) {
      costValue *= Math.max(0, baseQty - fin(tFlows.openSell)) / baseQty
    }
    costValue = +costValue.toFixed(2) // 含费动态持仓成本
    const floatPnl = +(mktValue - costValue).toFixed(2)     // 浮动盈亏
    const floatPct = costValue ? +((floatPnl / costValue) * 100).toFixed(2) : 0
    return {
      id: h.id,
      code: h.code,
      name: h.name,
      qty: liveQty,
      baseQty,
      price,
      buyPrice: h.buyPrice,
      mktValue,
      costValue,
      floatPnl,
      floatPct,
    }
  })
  const holdMktValue = +positions.reduce((a, p) => a + p.mktValue, 0).toFixed(2)   // 持仓总市值
  const holdCostValue = +positions.reduce((a, p) => a + p.costValue, 0).toFixed(2) // 持仓总成本
  const floatPnl = +(holdMktValue - holdCostValue).toFixed(2)                       // 总浮盈
  const {
    cash,
    available,
    totalAssets,
    initialCapital,
    totalPnl,
    totalPnlPct,
  } = deriveAccountValuation({ holdMktValue, holdCostValue, account })
  const position = totalAssets ? +((holdMktValue / totalAssets) * 100).toFixed(1) : null // 总仓位%
  // 单票占比（对总资产）
  positions.forEach((p) => { p.weight = totalAssets ? +((p.mktValue / totalAssets) * 100).toFixed(1) : null })
  // ===== 目标资产（以终为始）=====
  // goal = 用户想通过炒股达成的目标总资产(元)。派生:进度%、还需净赚缺口(元)、达标所需收益率%
  const goal = account && account.goal != null && account.goal > 0 ? account.goal : null
  let goalProgress = null, goalGap = null, goalReturnPct = null
  if (goal && totalAssets != null) {
    goalProgress = +((totalAssets / goal) * 100).toFixed(1)   // 进度%(可>100)
    goalGap = +(goal - totalAssets).toFixed(2)                // 距目标还差(元;负=已超额)
    goalReturnPct = totalAssets > 0 ? +(((goal - totalAssets) / totalAssets) * 100).toFixed(1) : null // 从现在到达标还需涨幅%
  }
  return {
    positions,
    holdMktValue,
    holdCostValue,
    floatPnl,
    totalAssets,
    initialCapital,
    totalPnl,
    totalPnlPct,
    cash,
    available,
    position,
    goal,
    goalProgress,
    goalGap,
    goalReturnPct,
  }
}
