import { useSyncExternalStore } from 'react'

// 唯一 id（分笔持仓/记录用）
let _seq = 0
function uid() { return Date.now().toString(36) + '_' + (_seq++).toString(36) }

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

let state = { plan: [], holding: [], closed: [] }
const listeners = new Set()

// 云端回存：authStore 登录后注册 saver；每次数据变更防抖保存
let _saver = null
let _saveTimer = null
let _suspend = false // setData 注入时不触发回存
function scheduleSave() {
  if (_suspend || !_saver) return
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    _saver({ plan: state.plan, holding: state.holding, closed: state.closed })
  }, 800)
}
function emit() { state = { ...state }; listeners.forEach((l) => l()); scheduleSave() }

// 把某笔持仓上已配对的做T收益，归档为独立的 closed 记录(kind:'T')，避免随持仓删除而丢失
function archiveTFlows(h) {
  const { pairList } = computeTFlows(h.tFlows)
  if (!pairList || !pairList.length) return []
  return pairList.map((p) => ({
    id: uid(), type: 'T', kind: 'T', code: h.code, name: h.name,
    qty: p.qty, buyPrice: p.buyPrice, sellPrice: p.sellPrice,
    buyFee: p.buyFee, sellFee: p.sellFee,
    grossPnl: p.grossPnl, netPnl: p.netPnl, realizedPnl: p.netPnl,
    pnlPct: p.buyPrice ? +(p.netPnl / (p.buyPrice * p.qty * 100 + p.buyFee) * 100).toFixed(2) : 0,
    tDir: p.tDir, holdingId: h.id,
    buyAt: p.buyAt, sellAt: p.sellAt, at: p.at,
  }))
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

export const planStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return state },
  // 由 authStore 登录/登出时注入数据（不触发回存云端，避免刚拉就写回）
  setData(d) {
    _suspend = true
    state = {
      plan: (d && d.plan) || [],
      holding: (d && d.holding) || [],
      closed: normalizeClosed((d && d.closed) || []),
    }
    listeners.forEach((l) => l())
    _suspend = false
  },
  // authStore 注册云端保存回调
  registerSaver(fn) { _saver = fn },
  addPlan(stock, note = '') {
    if (!stock || !stock.code) return
    if (state.plan.some((x) => x.code === stock.code)) return
    if (state.holding.some((x) => x.code === stock.code)) return // 已持有的票不再入计划，请用「加仓」
    state.plan = [...state.plan, { code: stock.code, name: stock.name, note, addedAt: Date.now() }]
    emit()
  },
  removePlan(code) { state.plan = state.plan.filter((x) => x.code !== code); emit() },

  // 计划 → 持仓（每次买入都是独立一笔，同股可多笔并存）
  buy(code, buyPrice, qty = 1) {
    const p = state.plan.find((x) => x.code === code)
    if (!p) return
    const q = Number(qty) || 1
    const price = Number(buyPrice)
    const buyAmount = price * q * 100
    const fee = calcBuyFee(buyAmount)
    const hid = uid()
    state.plan = state.plan.filter((x) => x.code !== code)
    state.holding = [...state.holding, {
      id: hid, code: p.code, name: p.name, buyPrice: price, buyAt: Date.now(),
      qty: q, buyFee: fee,
    }]
    // 记录一条纯买入交易流水
    state.closed = [makeBuyTxn(p.code, p.name, price, q, fee, hid), ...state.closed].slice(0, 300)
    emit()
  },
  // 直接建仓（同股也可多笔，不去重）
  buyDirect(stock, buyPrice, qty = 1) {
    if (!stock || !stock.code) return
    const q = Number(qty) || 1
    const price = Number(buyPrice)
    const buyAmount = price * q * 100
    const fee = calcBuyFee(buyAmount)
    const hid = uid()
    state.holding = [...state.holding, {
      id: hid, code: stock.code, name: stock.name, buyPrice: price, buyAt: Date.now(),
      qty: q, buyFee: fee,
    }]
    state.plan = state.plan.filter((x) => x.code !== stock.code)
    state.closed = [makeBuyTxn(stock.code, stock.name, price, q, fee, hid), ...state.closed].slice(0, 300)
    emit()
  },

  // 持仓 → 平仓（按持仓笔 id 卖出，支持部分卖出）
  sell(id, sellPrice, sellQty) {
    const h = state.holding.find((x) => x.id === id)
    if (!h) return
    const sq = Math.min(Number(sellQty) || h.qty, h.qty) // 卖出手数，不超过该笔持仓
    if (sq <= 0) return
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
    if (sq >= h.qty) {
      // 全部清仓：把该持仓上已配对的做T收益归档，避免随持仓删除而丢失
      archived = archiveTFlows(h)
      state.holding = state.holding.filter((x) => x.id !== id)
    } else {
      const remainQty = h.qty - sq
      state.holding = state.holding.map((x) => x.id === id
        ? { ...x, qty: remainQty, buyFee: +((h.buyFee || 0) * (remainQty / h.qty)).toFixed(2) }
        : x)
    }

    state.closed = [{
      id: uid(), type: 'SELL', kind: 'SELL', code: h.code, name: h.name,
      side: 'sell', qty: sq, price, amount: +proceeds.toFixed(2),
      fee: sellFee, cashFlow: +(proceeds - sellFee).toFixed(2), // 卖出=现金流入
      costPrice: h.buyPrice, realizedPnl: netPnl,               // 有成本基准→带已实现盈亏
      // 兼容旧展示字段
      buyPrice: h.buyPrice, sellPrice: price, buyFee: buyFeePart, sellFee,
      grossPnl: +grossPnl.toFixed(2), netPnl, pnlPct,
      buyAt: h.buyAt, sellAt: Date.now(), at: Date.now(),
    }, ...archived, ...state.closed].slice(0, 300)
    emit()
  },

  // 加仓：对已有持仓追加买入，按加权平均更新成本价，并记一条 BUY 流水
  addToHolding(id, addPrice, addQty) {
    const h = state.holding.find((x) => x.id === id)
    if (!h) return
    const q = Number(addQty) || 0
    const price = Number(addPrice)
    if (q <= 0 || !price) return
    const addAmount = price * q * 100
    const addFee = calcBuyFee(addAmount)
    const newQty = h.qty + q
    // 加权平均成本价（原成本×原量 + 加仓价×加量）/ 总量
    const newAvg = +(((h.buyPrice * h.qty) + (price * q)) / newQty).toFixed(3)
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, qty: newQty, buyPrice: newAvg, buyFee: +((x.buyFee || 0) + addFee).toFixed(2) }
      : x)
    // 记一条买入交易流水
    state.closed = [makeBuyTxn(h.code, h.name, price, q, addFee, id), ...state.closed].slice(0, 300)
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
    emit()
  },

  removeHolding(id) {
    const h = state.holding.find((x) => x.id === id)
    if (h) {
      const archived = archiveTFlows(h) // 删除持仓前，先归档已实现做T收益
      if (archived.length) state.closed = [...archived, ...state.closed].slice(0, 300)
    }
    state.holding = state.holding.filter((x) => x.id !== id); emit()
  },
  clearClosed() { state.closed = []; emit() },
  removeClosed(id) { state.closed = state.closed.filter((x) => x.id !== id); emit() },

  // ===== 做T：流水式（每次只记一腿买或卖，FIFO自动配对算收益，底仓手数不变）=====
  // side='buy'(低吸/买回) | 'sell'(高抛/卖出)
  addTFlow(id, side, price, qty) {
    const h = state.holding.find((x) => x.id === id)
    if (!h) return
    const q = Number(qty) || 1
    const p = Number(price)
    if (q <= 0 || !p) return
    const amount = p * q * 100
    const fee = side === 'buy' ? calcBuyFee(amount) : calcSellFee(amount)
    const flow = { id: uid(), side, price: p, qty: q, fee, at: Date.now() }
    const baseQty = h.baseQty || h.qty
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, baseQty, tFlows: [...(x.tFlows || []), flow] }
      : x)
    emit()
  },
  // 删除某笔做T流水（持仓上的收益/成本自动重算）
  removeTFlow(id, flowId) {
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, tFlows: (x.tFlows || []).filter((f) => f.id !== flowId) }
      : x)
    emit()
  },

  // 仅判断是否在「计划买入」候选中（用于加自选按钮态）
  has(code) {
    return state.plan.some((x) => x.code === code)
  },
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
        tDir: buyAt <= sellAt ? 'positive' : 'reverse',
        buyAt, sellAt, at: Math.max(buyAt, sellAt),
      })
      remain -= m
      feeLeft -= feeLeft * (m / (remain + m))
      head.qty -= m
      head.fee -= head.fee * (m / (head.qty + m))
      if (head.qty <= 1e-9) queue[opp].shift()
    }
    if (remain > 0) queue[f.side].push({ price: f.price, qty: remain, fee: feeLeft, at: f.at })
  }
  const openBuy = queue.buy.reduce((a, x) => a + x.qty, 0)
  const openSell = queue.sell.reduce((a, x) => a + x.qty, 0)
  return { realized: +realized.toFixed(2), pairs, openBuy, openSell, pairList }
}

export function usePlanStore() {
  return useSyncExternalStore(planStore.subscribe, planStore.get)
}
