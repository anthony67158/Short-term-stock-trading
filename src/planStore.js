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

let state = { plan: [], holding: [], closed: [], account: null, alerts: [], reviews: {} }
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
        account: state.account, alerts: state.alerts, reviews: state.reviews,
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
    _saver({ plan: state.plan, holding: state.holding, closed: state.closed, account: state.account, alerts: state.alerts, reviews: state.reviews })
  }, 800)
}
function emit() { state = { ...state }; listeners.forEach((l) => l()); scheduleSave() }

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
      account: (d && d.account) || null,   // { totalAssets, cash, updatedAt }
      alerts: (d && d.alerts) || [],        // 预警规则集
      reviews: (d && d.reviews) || {},      // 复盘结论：key=code → { code,name,at,session(noon/close/manual),text,... }
    }
    listeners.forEach((l) => l())
    _suspend = false
    // 登录/切换账号载入后，自动结算跨天未结算的做T（会触发一次云端回存）
    this.autoSettleTFlows()
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
  // 切换「重点关注」标记（自选/候选置顶高亮）
  toggleStar(code) {
    state.plan = state.plan.map((x) => x.code === code ? { ...x, star: !x.star } : x)
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
    snapshot(`建仓 ${stock.name || stock.code}`)
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
    } else {
      const remainQty = h.qty - sq
      state.holding = state.holding.map((x) => x.id === id
        ? { ...x, qty: remainQty, buyFee: +((h.buyFee || 0) * (remainQty / h.qty)).toFixed(2) }
        : x)
    }

    state.closed = [{
      id: uid(), batchId, type: 'SELL', kind: 'SELL', code: h.code, name: h.name,
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
    if (!h) return
    snapshot(`删除持仓 ${h.name || h.code}`)
    const archived = archiveTFlows(h, uid()) // 删除持仓前，先归档已实现做T收益
    if (archived.length) state.closed = [...archived, ...state.closed].slice(0, 300)
    state.holding = state.holding.filter((x) => x.id !== id); emit()
  },
  clearClosed() { snapshot('清空交易记录'); state.closed = []; emit() },
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

    // 按个股汇总这批记录对持仓手数的净影响：删 BUY→减手数、删 SELL→加回手数（T 不影响底仓）
    const deltaByCode = {}
    for (const r of toDelete) {
      const t = r.type || r.kind
      if (t === 'BUY') deltaByCode[r.code] = (deltaByCode[r.code] || 0) - (r.qty || 0)
      else if (t === 'SELL' || t === 'CLOSE') deltaByCode[r.code] = (deltaByCode[r.code] || 0) + (r.qty || 0)
    }

    // 先移除记录
    state.closed = state.closed.filter((x) => !delIds.has(x.id))

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
    if (!h) return
    const q = Number(qty) || 1
    const p = Number(price)
    if (q <= 0 || !p) return
    snapshot(`做T ${side === 'buy' ? '低吸' : '高抛'} ${h.name || h.code}`)
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
    snapshot('删除做T流水')
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, tFlows: (x.tFlows || []).filter((f) => f.id !== flowId) }
      : x)
    emit()
  },
  // 编辑某笔做T流水（改方向/价格/手数，手续费按新值重算）
  editTFlow(id, flowId, { side, price, qty }) {
    const p = Number(price), q = Number(qty)
    if (!p || !(q > 0)) return
    snapshot('编辑做T流水')
    const amount = p * q * 100
    const fee = side === 'buy' ? calcBuyFee(amount) : calcSellFee(amount)
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, tFlows: (x.tFlows || []).map((f) => f.id === flowId ? { ...f, side, price: p, qty: q, fee } : f) }
      : x)
    emit()
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
  // account: { totalAssets(总资产,元), cash(可用资金,元), updatedAt }
  setAccount(patch) {
    state.account = { ...(state.account || {}), ...patch, updatedAt: Date.now() }
    emit()
  },

  // ===== 交易计划与纪律：给某持仓设/改止盈、止损、计划仓位、买入理由 =====
  // 用 hasOwnProperty 判断字段是否传入，传了就覆盖（含 null=清空），没传才保留旧值
  setPlanRule(id, rule) {
    const has = (k) => Object.prototype.hasOwnProperty.call(rule, k)
    state.holding = state.holding.map((x) => x.id === id
      ? {
          ...x,
          tp: has('tp') ? rule.tp : x.tp,
          sl: has('sl') ? rule.sl : x.sl,
          planReason: has('planReason') ? rule.planReason : x.planReason,
          planWeight: has('planWeight') ? rule.planWeight : x.planWeight,
        }
      : x)
    emit()
  },
  // 清除某持仓的交易计划（止盈/止损/理由）+ 其联动的到价预警
  clearPlanRule(id) {
    state.holding = state.holding.map((x) => x.id === id
      ? { ...x, tp: null, sl: null, planReason: null, planWeight: null } : x)
    state.alerts = (state.alerts || []).filter((a) => a.planId !== id) // 移除计划联动预警
    emit()
  },
  // 给候选(计划买入)预设交易计划：目标买入价/止盈/止损/理由/计划仓位
  setCandPlan(code, plan) {
    state.plan = state.plan.map((x) => x.code === code ? { ...x, ...plan } : x)
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
  removeAlert(id) {
    state.alerts = (state.alerts || []).filter((x) => x.id !== id)
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
      ? { ...x, enabled: true, triggeredAt: null, triggeredMsg: '' } : x)
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
    }
    emit() // 恢复后正常回存云端，保证撤回结果也持久化
    return snap.label
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
  // 开口腿（未配平的净头寸）明细：净买入=加仓，净卖出=减仓/清仓
  const openBuyAmt = queue.buy.reduce((a, x) => a + x.price * x.qty * 100, 0)
  const openBuyFee = +queue.buy.reduce((a, x) => a + x.fee, 0).toFixed(2)
  const openSellAmt = queue.sell.reduce((a, x) => a + x.price * x.qty * 100, 0)
  const openSellFee = +queue.sell.reduce((a, x) => a + x.fee, 0).toFixed(2)
  const openBuyAvg = openBuy ? +(openBuyAmt / (openBuy * 100)).toFixed(3) : null
  const openSellAvg = openSell ? +(openSellAmt / (openSell * 100)).toFixed(3) : null
  const openBuyAt = queue.buy.length ? Math.max(...queue.buy.map((x) => x.at)) : null
  const openSellAt = queue.sell.length ? Math.max(...queue.sell.map((x) => x.at)) : null
  return {
    realized: +realized.toFixed(2), pairs, openBuy, openSell, pairList,
    openBuyAvg, openBuyFee, openBuyAt, openSellAvg, openSellFee, openSellAt,
  }
}

export function usePlanStore() {
  return useSyncExternalStore(planStore.subscribe, planStore.get)
}

// ============ 账户全景计算：传入 holding + 实时报价 quote(按code索引) + account =============
// 返回：持仓市值、成本、浮盈、总资产、可用现金、总仓位%、每笔持仓的市值/占比/浮盈
export function computePortfolio(holding, quoteMap, account) {
  const positions = (holding || []).map((h) => {
    const q = quoteMap && quoteMap[h.code]
    const price = q ? q.price : h.buyPrice
    const shares = (h.qty || 0) * 100
    const mktValue = +(price * shares).toFixed(2)          // 市值
    const costValue = +((h.buyPrice || 0) * shares + (h.buyFee || 0)).toFixed(2) // 含费成本
    const floatPnl = +(mktValue - costValue).toFixed(2)     // 浮动盈亏
    const floatPct = costValue ? +((floatPnl / costValue) * 100).toFixed(2) : 0
    return { id: h.id, code: h.code, name: h.name, qty: h.qty, price, buyPrice: h.buyPrice, mktValue, costValue, floatPnl, floatPct }
  })
  const holdMktValue = +positions.reduce((a, p) => a + p.mktValue, 0).toFixed(2)   // 持仓总市值
  const holdCostValue = +positions.reduce((a, p) => a + p.costValue, 0).toFixed(2) // 持仓总成本
  const floatPnl = +(holdMktValue - holdCostValue).toFixed(2)                       // 总浮盈
  // 总资产：用户填了就用填的；否则用 持仓市值 + 现金(若填) 估算
  const cash = account && account.cash != null ? account.cash : null
  let totalAssets = account && account.totalAssets != null ? account.totalAssets : null
  if (totalAssets == null) totalAssets = cash != null ? +(holdMktValue + cash).toFixed(2) : holdMktValue
  const position = totalAssets ? +((holdMktValue / totalAssets) * 100).toFixed(1) : null // 总仓位%
  const available = cash != null ? cash : (totalAssets != null ? +(totalAssets - holdMktValue).toFixed(2) : null)
  // 单票占比（对总资产）
  positions.forEach((p) => { p.weight = totalAssets ? +((p.mktValue / totalAssets) * 100).toFixed(1) : null })
  return { positions, holdMktValue, holdCostValue, floatPnl, totalAssets, cash, available, position }
}

