import { useState, useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import Icon from './Icon'
import StockName from './StockName'
import { planStore, usePlanStore, computeTFlows } from '../planStore'
import { fmtPct, pctClass , fmtRaw } from '../format'

// 汇总所有交易记录：已存 closed（BUY/SELL/CLOSE/T）+ 持仓中实时做T（未归档）
function useRealizedRecords(book) {
  const closed = (book.closed || []).map((c) => ({
    ...c,
    type: c.type || (c.kind === 'T' ? 'T' : 'CLOSE'), // 兼容旧数据
    realizedPnl: c.realizedPnl != null ? c.realizedPnl : (c.netPnl ?? null),
  }))
  // 持仓中每笔已配对的做T（尚未归档，标记为 live 便于区分）
  const liveT = []
  for (const h of book.holding || []) {
    const r = computeTFlows(h.tFlows)
    for (const p of (r.pairList || [])) {
      liveT.push({
        id: h.id + '_' + p.at, type: 'T', kind: 'T', live: true, code: h.code, name: h.name,
        qty: p.qty, buyPrice: p.buyPrice, sellPrice: p.sellPrice,
        buyFee: p.buyFee, sellFee: p.sellFee, grossPnl: p.grossPnl, netPnl: p.netPnl, realizedPnl: p.netPnl,
        pnlPct: p.buyPrice ? +(p.netPnl / (p.buyPrice * p.qty * 100 + p.buyFee) * 100).toFixed(2) : 0,
        tDir: p.tDir, holdingId: h.id, buyAt: p.buyAt, sellAt: p.sellAt, at: p.at,
      })
    }
    // 未配平开口腿：净买入→加仓(BUY)、净卖出→减仓(SELL)，实时体现在交易记录（标 live+待结算）
    if (r.openBuy > 0 && r.openBuyAvg != null) {
      const amount = +(r.openBuyAvg * r.openBuy * 100).toFixed(2)
      liveT.push({
        id: h.id + '_openbuy', type: 'BUY', live: true, pending: true, code: h.code, name: h.name, side: 'buy',
        qty: r.openBuy, price: r.openBuyAvg, buyPrice: r.openBuyAvg, fee: r.openBuyFee, amount,
        realizedPnl: null, holdingId: h.id, at: r.openBuyAt || Date.now(),
      })
    }
    if (r.openSell > 0 && r.openSellAvg != null) {
      const shares = r.openSell * 100
      const amount = +(r.openSellAvg * shares).toFixed(2)
      const cost = (h.buyPrice || 0) * shares
      const buyFeePart = h.qty ? +(((h.buyFee || 0) * (r.openSell / h.qty))).toFixed(2) : 0
      const netPnl = +((amount - cost) - r.openSellFee - buyFeePart).toFixed(2)
      liveT.push({
        id: h.id + '_opensell', type: 'SELL', kind: 'SELL', live: true, pending: true, code: h.code, name: h.name, side: 'sell',
        qty: r.openSell, price: r.openSellAvg, sellPrice: r.openSellAvg, buyPrice: h.buyPrice, costPrice: h.buyPrice,
        fee: r.openSellFee, buyFee: buyFeePart, sellFee: r.openSellFee, amount,
        grossPnl: +(amount - cost).toFixed(2), netPnl, realizedPnl: netPnl,
        pnlPct: cost ? +(netPnl / (cost + buyFeePart) * 100).toFixed(2) : 0,
        holdingId: h.id, at: r.openSellAt || Date.now(), sellAt: r.openSellAt || Date.now(),
      })
    }
  }
  return [...liveT, ...closed]
}

// ============ 复盘 Tab：兑现 + 迭代（情绪复盘已整合进 AI 助手）============
export default function ReviewTab({ interval, snapshot }) {
  const book = usePlanStore()
  const records = useRealizedRecords(book)

  return (
    <div className="review">
      <TradeStat records={records} />
      <ReviewCharts records={records} />
      <DailyLog records={records} />
    </div>
  )
}

// ---------- 每日流水 ----------
function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function hm(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
// 把当天记录按股票聚合，算含费买入/卖出均价、净收益、手续费
// 按交易类型分腿累加：BUY 只计买腿；SELL 只计卖腿；CLOSE/T 计买卖双腿
function groupByStock(items) {
  const map = new Map()
  for (const c of items) {
    if (!map.has(c.code)) map.set(c.code, { code: c.code, name: c.name, items: [], bq: 0, ba: 0, bf: 0, sq: 0, sa: 0, sf: 0, net: 0, fee: 0 })
    const g = map.get(c.code)
    g.items.push(c)
    const q = c.qty || 0, sh = q * 100
    const isBuy = c.type === 'BUY'
    const isSell = c.type === 'SELL'
    if (isBuy) {
      g.bq += q; g.ba += (c.price || c.buyPrice || 0) * sh; g.bf += c.fee ?? c.buyFee ?? 0
      g.fee += c.fee ?? c.buyFee ?? 0
    } else if (isSell) {
      g.sq += q; g.sa += (c.price || c.sellPrice || 0) * sh; g.sf += c.fee ?? c.sellFee ?? 0
      g.fee += c.fee ?? c.sellFee ?? 0
    } else { // CLOSE / T：买卖双腿
      g.bq += q; g.ba += (c.buyPrice || 0) * sh; g.bf += c.buyFee || 0
      g.sq += q; g.sa += (c.sellPrice || 0) * sh; g.sf += c.sellFee || 0
      g.fee += (c.buyFee ?? 0) + (c.sellFee ?? 0)
    }
    g.net += c.realizedPnl ?? 0 // BUY 的 realizedPnl 为 null，不计入
  }
  return [...map.values()].map((g) => ({
    ...g,
    items: g.items.sort((a, b) => (b.at || b.sellAt || 0) - (a.at || a.sellAt || 0)),
    buyAvg: g.bq ? (g.ba + g.bf) / (g.bq * 100) : null,   // 含费买入均价
    sellAvg: g.sq ? (g.sa - g.sf) / (g.sq * 100) : null,  // 含费卖出均价
  })).sort((a, b) => (b.items[0]?.at || 0) - (a.items[0]?.at || 0))
}
// 交易类型归一化 key
function typeKey(c) { return c.type || (c.kind === 'T' ? 'T' : 'CLOSE') }
// 单条记录的手续费（单腿用 fee，回合用买+卖）
function feeOf(c) {
  if (c.fee != null && (c.type === 'BUY' || c.type === 'SELL')) return c.fee
  return (c.buyFee ?? 0) + (c.sellFee ?? 0)
}
// 单条流水行渲染（区分 纯买入/纯卖出/平仓/做T）
function TxnRow({ c, onDelete, showDate }) {
  const t = typeKey(c)
  const tag = t === 'T'
    ? { cls: c.tDir === 'reverse' ? 'rev' : 'pos', label: c.tDir === 'reverse' ? '反T' : '正T' }
    : t === 'BUY' ? { cls: 'buy', label: '买入' }
    : t === 'SELL' ? { cls: 'sell', label: '卖出' }
    : { cls: 'close', label: '平仓' }
  const single = t === 'BUY' || t === 'SELL'
  const priceText = single
    ? `${fmtRaw(c.price ?? (t === 'BUY' ? c.buyPrice : c.sellPrice))} × ${c.qty}手`
    : `${fmtRaw(c.buyPrice)}→${fmtRaw(c.sellPrice)}`
  const ts = c.at || c.sellAt || c.buyAt
  return (
    <div className="day-item">
      <span className="di-time">{showDate ? dayKey(ts).slice(5) + ' ' : ''}{hm(ts)}</span>
      <span className="di-op">
        <span className={'di-tag ' + tag.cls}>{tag.label}</span>
        <span className="sub-name">{c.qty}手</span>
        {c.live && <span className="di-live">{c.pending ? '待结算' : '持仓中'}</span>}
      </span>
      <span className="di-price">{priceText}</span>
      <span className="di-amt" title={single ? (t === 'BUY' ? '本笔花费(成交额)' : '本笔回收(成交额)') : '本回合卖出成交额'}>
        {t === 'BUY' ? '花 ' : t === 'SELL' ? '收 ' : ''}{fmtAmt(amountOf(c))}
      </span>
      {c.realizedPnl != null
        ? <span className={'di-net ' + (c.realizedPnl >= 0 ? 'red' : 'green')}>{fmtMoney(c.realizedPnl)}</span>
        : <span className="di-net di-cash">{t === 'BUY' ? '建/加仓' : '—'}</span>}
      {c.live
        ? <span className="di-del-ph" title="做T在持仓中，请在「我的计划」里增删">·</span>
        : <span className="del di-del" title="删除此记录" onClick={() => onDelete(c)}>×</span>}
    </div>
  )
}
function DailyLog({ records }) {
  const [filter, setFilter] = useState('all') // all | BUY | SELL | CLOSE | T
  const [confirmClear, setConfirmClear] = useState(false)
  const [delTarget, setDelTarget] = useState(null) // 待删除的单条记录（可能级联同批）
  const [collapsed, setCollapsed] = useState({}) // key(day 或 day|code) → 是否折叠
  const [groupMode, setGroupMode] = useState('day') // day 按时间 | stock 按个股
  const toggle = (key) => setCollapsed((s) => ({ ...s, [key]: !s[key] }))
  const filtered = records.filter((c) => filter === 'all' || typeKey(c) === filter)
  const delBatch = delTarget ? planStore.batchSize(delTarget.id) : 1
  const delImpact = delTarget ? (planStore.removeClosedImpact(delTarget.id) || []) : []

  // 按天分组
  const groups = {}
  for (const c of filtered) {
    const k = dayKey(c.at || c.sellAt || c.buyAt || Date.now())
    if (!groups[k]) groups[k] = []
    groups[k].push(c)
  }
  const days = Object.keys(groups).sort((a, b) => (a < b ? 1 : -1)) // 新到旧
  const today = dayKey(Date.now())

  // 按个股维度：跨所有日期聚合同一只票的全部操作（groupByStock 已按最近一笔时间倒序）
  const stockGroups = groupByStock(filtered)

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="clipboard" size={16} /> 每日操作流水</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="tabs">
            {[['all', '全部'], ['BUY', '买入'], ['SELL', '卖出'], ['CLOSE', '平仓'], ['T', '做T']].map(([k, t]) => (
              <div key={k} className={'tab' + (filter === k ? ' active' : '')} onClick={() => setFilter(k)}>{t}</div>
            ))}
          </div>
          <div className="tabs">
            <div className={'tab' + (groupMode === 'day' ? ' active' : '')} onClick={() => setGroupMode('day')}>按时间</div>
            <div className={'tab' + (groupMode === 'stock' ? ' active' : '')} onClick={() => setGroupMode('stock')}>按个股</div>
          </div>
          {(records || []).some((c) => !c.live) && (
            <>
              <button className="btn" title="导出交易记录为 CSV(Excel可打开)" onClick={() => exportCsv(records)}>
                <Icon name="download" size={13} />导出
              </button>
              <button className="btn" title="清空所有已存交易记录（持仓中的做T不受影响）"
                onClick={() => setConfirmClear(true)}>
                <Icon name="trash" size={13} />清空
              </button>
            </>
          )}
        </div>
      </div>

      {/* 清空二次确认弹窗 */}
      {confirmClear && (
        <div className="modal-mask" onClick={() => setConfirmClear(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title"><Icon name="trash" size={18} /> 清空全部交易记录？</div>
            <div className="confirm-body">
              此操作<b className="red">不可恢复</b>，会删除全部已存的买入/卖出/平仓/做T记录，
              <b>「交易复盘」里的净收益、胜率、手续费等统计也会随之清零</b>。
              <br />（当前持仓中的做T不受影响。）
            </div>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirmClear(false)}>取消</button>
              <button className="btn btn-danger" onClick={() => { planStore.clearClosed(); setConfirmClear(false) }}>
                <Icon name="trash" size={13} /> 确认清空
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 单条删除二次确认（若属于同一次清仓/结算批次，会级联删除关联记录）*/}
      {delTarget && (
        <div className="modal-mask" onClick={() => setDelTarget(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title"><Icon name="trash" size={18} /> 删除这条交易记录？</div>
            <div className="confirm-body">
              {delBatch > 1 ? (
                <>这条记录与另外 <b className="red">{delBatch - 1}</b> 条是<b>同一次操作</b>产生的（如清仓时的卖出 + 做T差价 + 加/减仓），
                为保持「全部/买入/卖出/平仓/做T」各分类一致，将<b>一并删除这 {delBatch} 条</b>。</>
              ) : (
                <>确定删除 <b>{delTarget.name}</b> 的这条记录？</>
              )}
              {delImpact.length > 0 && (
                <div className="del-impact">
                  <Icon name="info" size={12} /> 持仓将同步调整：
                  {delImpact.map((im, i) => (
                    <span key={i} className="del-impact-item">
                      {im.name} <b className={im.delta > 0 ? 'red' : 'green'}>{im.delta > 0 ? '+' : ''}{im.delta}手</b>
                    </span>
                  ))}
                </div>
              )}
              <br />删除后，持仓与复盘统计会同步更新。若删错了，可点顶部<b>撤回</b>按钮一键还原。
            </div>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setDelTarget(null)}>取消</button>
              <button className="btn btn-danger" onClick={() => { planStore.removeClosed(delTarget.id); setDelTarget(null) }}>
                <Icon name="trash" size={13} /> {delBatch > 1 ? `删除这 ${delBatch} 条` : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
      {days.length === 0 ? (
        <div className="empty">买入、卖出或做T后，这里按{groupMode === 'stock' ? '个股' : '天'}汇总你的操作，方便回看进出与盈亏。</div>
      ) : groupMode === 'stock' ? (
        /* ===== 按个股视图：一只票聚合其跨所有日期的全部操作 ===== */
        <div className="scroll" style={{ maxHeight: 520 }}>
          {stockGroups.map((g) => {
            const skey = 'stk|' + g.code
            const folded = collapsed[skey] ?? false
            const dayset = new Set(g.items.map((c) => dayKey(c.at || c.sellAt || c.buyAt)))
            return (
              <div className="day-block" key={g.code}>
                <div className="day-head day-head-btn" onClick={() => toggle(skey)}>
                  <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={13} />
                  <StockName code={g.code} name={g.name} stopPropagation><span className="day-date">{g.name}</span></StockName>
                  <span className="day-sub">{g.items.length}笔 · {dayset.size}天</span>
                  {g.ba > 0 && <span className="day-flow">花 <b>{fmtAmt(g.ba + g.bf)}</b></span>}
                  {g.sa > 0 && <span className="day-flow">收 <b>{fmtAmt(g.sa - g.sf)}</b></span>}
                  <span className="day-net">已实现 <b className={g.net >= 0 ? 'red' : 'green'}>{fmtMoney(g.net)}</b></span>
                  <span className="day-fee">手续费 {fmtMoney(g.fee).replace('+', '')}</span>
                </div>
                {!folded && (
                  <div className="day-items">
                    {(g.buyAvg != null || g.sellAvg != null) && (
                      <div className="ds-stock-head" style={{ cursor: 'default' }}>
                        <span style={{ width: 12 }} />
                        <span className="ds-avg">
                          {g.buyAvg != null && <span className="ds-avg-i"><span className="ds-avg-k buy">买均</span><b>{fmtRaw(g.buyAvg)}</b></span>}
                          {g.sellAvg != null && <span className="ds-avg-i"><span className="ds-avg-k sell">卖均</span><b>{fmtRaw(g.sellAvg)}</b></span>}
                        </span>
                      </div>
                    )}
                    {g.items.map((c, i) => <TxnRow c={c} key={c.id || i} onDelete={setDelTarget} showDate />)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        /* ===== 按时间视图：天 → 股票 ===== */
        <div className="scroll" style={{ maxHeight: 520 }}>
          {days.map((day) => {
            const items = groups[day].slice().sort((a, b) => (b.at || b.sellAt || 0) - (a.at || a.sellAt || 0))
            // 已实现盈亏只统计有 realizedPnl 的（BUY 不计）
            const net = items.reduce((a, c) => a + (c.realizedPnl ?? 0), 0)
            const fee = items.reduce((a, c) => a + feeOf(c), 0)
            // 当天现金进出：买入花费(成交额+买费)、卖出回收(成交额−卖费)
            const daySpend = items.filter((c) => typeKey(c) === 'BUY').reduce((a, c) => a + amountOf(c) + (c.fee ?? c.buyFee ?? 0), 0)
            const dayRecover = items.filter((c) => typeKey(c) === 'SELL').reduce((a, c) => a + amountOf(c) - (c.fee ?? c.sellFee ?? 0), 0)
            const nBuy = items.filter((c) => typeKey(c) === 'BUY').length
            const nSell = items.filter((c) => typeKey(c) === 'SELL').length
            const nClose = items.filter((c) => typeKey(c) === 'CLOSE').length
            const nT = items.filter((c) => typeKey(c) === 'T').length
            const parts = []
            if (nBuy) parts.push(`买入${nBuy}`)
            if (nSell) parts.push(`卖出${nSell}`)
            if (nClose) parts.push(`平仓${nClose}`)
            if (nT) parts.push(`做T${nT}`)
            const dayFolded = collapsed[day] ?? (day !== today) // 非今天默认折叠
            return (
              <div className="day-block" key={day}>
                <div className="day-head day-head-btn" onClick={() => toggle(day)}>
                  <Icon name={dayFolded ? 'chevronRight' : 'chevronDown'} size={13} />
                  <span className="day-date">{day}</span>
                  <span className="day-sub">{parts.join(' · ')}</span>
                  {daySpend > 0 && <span className="day-flow">花 <b>{fmtAmt(daySpend)}</b></span>}
                  {dayRecover > 0 && <span className="day-flow">收 <b>{fmtAmt(dayRecover)}</b></span>}
                  <span className="day-net">已实现 <b className={net >= 0 ? 'red' : 'green'}>{fmtMoney(net)}</b></span>
                  <span className="day-fee">手续费 {fmtMoney(fee).replace('+', '')}</span>
                </div>
                {!dayFolded && (
                  <div className="day-items">
                    {groupByStock(items).map((g) => {
                      const skey = day + '|' + g.code
                      const stockFolded = collapsed[skey] ?? false // 股票默认展开
                      return (
                        <div className="ds-stock" key={g.code}>
                          <div className="ds-stock-head ds-stock-head-btn" onClick={() => toggle(skey)}>
                            <Icon name={stockFolded ? 'chevronRight' : 'chevronDown'} size={12} />
                            <StockName code={g.code} name={g.name} stopPropagation><span className="ds-stock-name">{g.name}</span></StockName>
                            <span className="ds-stock-cnt">{g.items.length}笔</span>
                            <span className="ds-avg">
                              {g.buyAvg != null && <span className="ds-avg-i"><span className="ds-avg-k buy">买均</span><b>{fmtRaw(g.buyAvg)}</b></span>}
                              {g.sellAvg != null && <span className="ds-avg-i"><span className="ds-avg-k sell">卖均</span><b>{fmtRaw(g.sellAvg)}</b></span>}
                              {g.ba > 0 && <span className="ds-avg-i"><span className="ds-avg-k buy">花费</span><b>{fmtAmt(g.ba + g.bf)}</b></span>}
                              {g.sa > 0 && <span className="ds-avg-i"><span className="ds-avg-k sell">回收</span><b>{fmtAmt(g.sa - g.sf)}</b></span>}
                              <span className="ds-avg-fee">费{g.fee.toFixed(0)}</span>
                            </span>
                            <span className={'ds-stock-net ' + (g.net >= 0 ? 'red' : 'green')}>{fmtMoney(g.net)}</span>
                          </div>
                          {!stockFolded && g.items.map((c, i) => <TxnRow c={c} key={c.id || i} onDelete={setDelTarget} />)}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 交易统计
function fmtMoney(v) {
  const sign = v >= 0 ? '+' : '-'; const a = Math.abs(v)
  if (a >= 10000) return sign + (a / 10000).toFixed(2) + '万'
  return sign + a.toFixed(0)
}
// 无符号金额（成交额/花费/回收），万以上转万
function fmtAmt(v) {
  const a = Math.abs(v || 0)
  if (a >= 10000) return (a / 10000).toFixed(2) + '万'
  return a.toFixed(0)
}
// 一条记录的成交额（不含费）：单腿用 amount，回合/做T用买腿或卖腿市值
function amountOf(c) {
  if (c.amount != null) return c.amount
  const t = c.type || (c.kind === 'T' ? 'T' : 'CLOSE')
  const sh = (c.qty || 0) * 100
  if (t === 'BUY') return (c.price ?? c.buyPrice ?? 0) * sh
  if (t === 'SELL') return (c.price ?? c.sellPrice ?? 0) * sh
  return (c.sellPrice ?? 0) * sh // 平仓/做T 取卖出腿市值
}
function statOf(arr) {
  const n = arr.length
  const wins = arr.filter((c) => (c.realizedPnl ?? 0) > 0)
  const losses = arr.filter((c) => (c.realizedPnl ?? 0) < 0)
  const win = wins.length
  const net = arr.reduce((a, c) => a + (c.realizedPnl ?? 0), 0)
  const avgWin = wins.length ? wins.reduce((a, c) => a + c.realizedPnl, 0) / wins.length : 0
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, c) => a + c.realizedPnl, 0) / losses.length) : 0
  const rate = n ? win / n : null
  // 盈亏比 = 平均盈利 / 平均亏损；期望值 = 胜率×平均盈利 − 败率×平均亏损
  const plRatio = avgLoss > 0 ? avgWin / avgLoss : null
  const expect = rate != null ? (rate * avgWin - (1 - rate) * avgLoss) : null
  return { n, rate: rate != null ? Math.round(rate * 100) : null, net, avgWin, avgLoss, plRatio, expect }
}

// 导出交易记录为 CSV（Excel 可直接打开）
function exportCsv(records) {
  const head = ['日期时间', '类型', '代码', '名称', '手数', '买入价', '卖出价', '成交额', '手续费', '已实现盈亏']
  const typeLabel = (c) => { const t = c.type || (c.kind === 'T' ? 'T' : 'CLOSE'); return { BUY: '买入', SELL: '卖出', CLOSE: '平仓', T: '做T' }[t] || t }
  const rows = records.filter((c) => !c.live).map((c) => {
    const ts = c.at || c.sellAt || c.buyAt
    return [
      new Date(ts).toLocaleString('zh-CN'),
      typeLabel(c), c.code, c.name, c.qty ?? '',
      c.buyPrice ?? c.price ?? '', c.sellPrice ?? (c.type === 'SELL' ? c.price : '') ?? '',
      amountOf(c).toFixed(2),
      ((c.fee ?? 0) || ((c.buyFee ?? 0) + (c.sellFee ?? 0))).toFixed(2),
      c.realizedPnl != null ? c.realizedPnl.toFixed(2) : '',
    ]
  })
  const csv = [head, ...rows].map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `交易记录_${dayKey(Date.now())}.csv`
  a.click(); URL.revokeObjectURL(url)
}
function TradeStat({ records }) {
  const buys = records.filter((c) => typeKey(c) === 'BUY')
  const sells = records.filter((c) => typeKey(c) === 'SELL' || typeKey(c) === 'CLOSE') // 卖出兑现(含旧平仓)
  const ts = records.filter((c) => typeKey(c) === 'T')
  const sStat = statOf(sells)
  const tStat = statOf(ts)
  const totalNet = sStat.net + tStat.net // 已实现净收益(买入不计盈亏)
  const totalFee = records.reduce((a, c) => a + feeOf(c), 0)
  // 累计花费(买入成交额+买费) / 累计回收(卖出成交额−卖费)
  const buyAmt = buys.reduce((a, c) => a + amountOf(c) + (c.fee ?? c.buyFee ?? 0), 0)
  const sellAmt = sells.reduce((a, c) => a + amountOf(c) - (c.fee ?? c.sellFee ?? 0), 0)
  const empty = records.length === 0
  const netCls = totalNet > 0 ? 'red' : totalNet < 0 ? 'green' : ''

  return (
    <div className="panel">
      <div className="panel-head"><div className="panel-title"><Icon name="gauge" size={16} /> 交易复盘</div>
        <span className="panel-sub">买入/卖出/做T 分类统计</span>
      </div>
      {empty ? (
        <div className="empty">买入、卖出或做T后，这里会分别统计你的买入投入、卖出兑现、做T收益、胜率与手续费，用于迭代策略。</div>
      ) : (
        <div className="rv-kpi">
          {/* 主视觉：已实现净收益 */}
          <div className="rv-kpi-hero">
            <div className="rv-kpi-label">已实现净收益</div>
            <div className={'rv-kpi-hero-val ' + netCls}>{fmtMoney(totalNet)}</div>
            <div className="rv-kpi-sub">{records.length} 笔 · 手续费 {fmtMoney(totalFee).replace('+', '')}</div>
          </div>
          {/* 买入 */}
          <div className="rv-kpi-cell">
            <div className="rv-kpi-cell-head"><span className="di-tag buy">买入</span>累计花费</div>
            <div className="rv-kpi-cell-val">{buys.length ? fmtAmt(buyAmt) : '--'}</div>
            <div className="rv-kpi-cell-sub">{buys.length} 笔 · 含手续费</div>
          </div>
          {/* 卖出回收 */}
          <div className="rv-kpi-cell">
            <div className="rv-kpi-cell-head"><span className="di-tag sell">卖出</span>累计回收</div>
            <div className="rv-kpi-cell-val">{sStat.n ? fmtAmt(sellAmt) : '--'}</div>
            <div className="rv-kpi-cell-sub">{sStat.n} 笔 · 兑现 <b className={sStat.net > 0 ? 'red' : sStat.net < 0 ? 'green' : ''}>{sStat.n ? fmtMoney(sStat.net) : '--'}</b></div>
          </div>
          {/* 做T */}
          <div className="rv-kpi-cell">
            <div className="rv-kpi-cell-head"><span className="di-tag pos">做T</span>做T交易</div>
            <div className={'rv-kpi-cell-val ' + (tStat.net > 0 ? 'red' : tStat.net < 0 ? 'green' : '')}>{tStat.n ? fmtMoney(tStat.net) : '--'}</div>
            <div className="rv-kpi-cell-sub">{tStat.n} 笔 · 胜率 {tStat.rate != null ? tStat.rate + '%' : '--'}</div>
          </div>
        </div>
      )}
      {/* 绩效归因：胜率/盈亏比/期望值（合并卖出+做T的已实现记录）*/}
      {!empty && (() => {
        const all = statOf([...sells, ...ts])
        return (
          <div className="rv-attr">
            <div className="rv-attr-cell">
              <div className="rv-attr-k">总胜率</div>
              <div className="rv-attr-v">{all.rate != null ? all.rate + '%' : '--'}</div>
              <div className="rv-attr-s">{all.n} 笔已实现</div>
            </div>
            <div className="rv-attr-cell">
              <div className="rv-attr-k">盈亏比</div>
              <div className="rv-attr-v">{all.plRatio != null ? all.plRatio.toFixed(2) : '--'}</div>
              <div className="rv-attr-s">均盈 {fmtMoney(all.avgWin)} / 均亏 {fmtMoney(-all.avgLoss)}</div>
            </div>
            <div className="rv-attr-cell">
              <div className="rv-attr-k">每笔期望</div>
              <div className={'rv-attr-v ' + (all.expect >= 0 ? 'red' : 'green')}>{all.expect != null ? fmtMoney(all.expect) : '--'}</div>
              <div className="rv-attr-s">每笔平均可赚</div>
            </div>
            <div className="rv-attr-cell rv-attr-hint">
              <div className="rv-attr-k">解读</div>
              <div className="rv-attr-note">
                {all.plRatio != null && all.rate != null
                  ? (all.expect >= 0
                      ? `期望为正，策略当前是赚钱的。${all.rate < 50 && all.plRatio > 1.5 ? '胜率虽不高，但靠盈亏比取胜，注意拿住盈利单。' : all.plRatio < 1 ? '盈亏比偏低，注意止损、别让亏损单扩大。' : '维持纪律即可。'}`
                      : '期望为负，需检视：要么提高胜率(选股/择时)，要么放大盈亏比(拿住盈利、快砍亏损)。')
                  : '样本较少，多积累几笔后指标更可信。'}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}


// ============ 复盘图表：资金曲线 + 每日盈亏 + 个股盈亏排行 ============
const RED = '#f4614e', GREEN = '#3fb950'
const CHART_BG = '#16181f', CHART_BORDER = '#23252d', AXIS = '#767881', SPLIT = 'rgba(255,255,255,.05)'

function ReviewCharts({ records }) {
  // 只取有已实现盈亏的记录（BUY 无盈亏不计），按时间升序
  const closed = useMemo(
    () => records
      .filter((c) => c.realizedPnl != null)
      .map((c) => ({ ...c, ts: c.at || c.sellAt || c.buyAt || 0 }))
      .sort((a, b) => a.ts - b.ts),
    [records]
  )

  // ① 累计收益曲线
  const equityOption = useMemo(() => {
    if (!closed.length) return null
    let cum = 0
    const pts = closed.map((c) => { cum += c.realizedPnl; return [c.ts, +cum.toFixed(2)] })
    const dates = pts.map((p) => new Date(p[0]).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }))
    const vals = pts.map((p) => p[1])
    const up = cum >= 0
    return {
      animation: false,
      grid: { left: 56, right: 16, top: 16, bottom: 28 },
      tooltip: { trigger: 'axis', backgroundColor: CHART_BG, borderColor: CHART_BORDER, textStyle: { color: '#e6e7ea', fontSize: 12 },
        formatter: (ps) => `第${ps[0].dataIndex + 1}笔 · ${dates[ps[0].dataIndex]}<br/>累计净收益：${ps[0].value >= 0 ? '+' : ''}${ps[0].value}` },
      xAxis: { type: 'category', data: dates, axisLabel: { color: AXIS, fontSize: 10 }, axisLine: { lineStyle: { color: CHART_BORDER } }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: AXIS, fontSize: 10 }, splitLine: { lineStyle: { color: SPLIT } } },
      series: [{
        type: 'line', data: vals, smooth: true, symbol: 'none',
        lineStyle: { color: up ? RED : GREEN, width: 2 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
          { offset: 0, color: up ? 'rgba(244,97,78,.25)' : 'rgba(63,185,80,.25)' },
          { offset: 1, color: 'rgba(0,0,0,0)' } ] } },
        markLine: { symbol: 'none', silent: true, data: [{ yAxis: 0, lineStyle: { color: AXIS, type: 'dashed', width: 1 } }] },
      }],
    }
  }, [closed])

  // ② 每日盈亏柱状
  const dailyOption = useMemo(() => {
    if (!closed.length) return null
    const map = new Map()
    for (const c of closed) {
      const k = dayKey(c.ts)
      map.set(k, (map.get(k) || 0) + c.realizedPnl)
    }
    const days = [...map.keys()].sort()
    const vals = days.map((d) => +map.get(d).toFixed(2))
    return {
      animation: false,
      grid: { left: 56, right: 16, top: 16, bottom: 28 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: CHART_BG, borderColor: CHART_BORDER, textStyle: { color: '#e6e7ea', fontSize: 12 },
        formatter: (ps) => `${ps[0].axisValue}<br/>当日盈亏：${ps[0].value >= 0 ? '+' : ''}${ps[0].value}` },
      xAxis: { type: 'category', data: days.map((d) => d.slice(5)), axisLabel: { color: AXIS, fontSize: 10 }, axisLine: { lineStyle: { color: CHART_BORDER } } },
      yAxis: { type: 'value', axisLabel: { color: AXIS, fontSize: 10 }, splitLine: { lineStyle: { color: SPLIT } } },
      series: [{
        type: 'bar', data: vals.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? RED : GREEN, borderRadius: v >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })),
        barMaxWidth: 26,
      }],
    }
  }, [closed])

  // ③ 个股盈亏排行（横向条形）
  const stockOption = useMemo(() => {
    if (!closed.length) return null
    const map = new Map()
    for (const c of closed) {
      if (!map.has(c.code)) map.set(c.code, { name: c.name || c.code, pnl: 0 })
      map.get(c.code).pnl += c.realizedPnl
    }
    const arr = [...map.values()].map((x) => ({ ...x, pnl: +x.pnl.toFixed(2) }))
      .sort((a, b) => a.pnl - b.pnl) // 升序，最赚的在顶部（ECharts y 轴从下往上）
    const names = arr.map((x) => x.name)
    const vals = arr.map((x) => x.pnl)
    return {
      animation: false,
      grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: CHART_BG, borderColor: CHART_BORDER, textStyle: { color: '#e6e7ea', fontSize: 12 },
        formatter: (ps) => `${ps[0].axisValue}<br/>累计盈亏：${ps[0].value >= 0 ? '+' : ''}${ps[0].value}` },
      xAxis: { type: 'value', axisLabel: { color: AXIS, fontSize: 10 }, splitLine: { lineStyle: { color: SPLIT } } },
      yAxis: { type: 'category', data: names, axisLabel: { color: '#b3b3bf', fontSize: 11 }, axisLine: { lineStyle: { color: CHART_BORDER } }, axisTick: { show: false } },
      series: [{
        type: 'bar', data: vals.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? RED : GREEN, borderRadius: v >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] } })),
        barMaxWidth: 20,
        label: { show: true, position: 'right', color: '#b3b3bf', fontSize: 10, formatter: (p) => (p.value >= 0 ? '+' : '') + p.value },
      }],
    }
  }, [closed])

  if (!closed.length) {
    return (
      <div className="panel">
        <div className="panel-head"><div className="panel-title"><Icon name="chart" size={16} /> 复盘图表</div></div>
        <div className="empty">有已兑现的卖出/做T记录后，这里会用图表展示资金曲线、每日盈亏与个股盈亏排行。</div>
      </div>
    )
  }
  const stockCount = new Set(closed.map((c) => c.code)).size
  return (
    <div className="panel">
      <div className="panel-head"><div className="panel-title"><Icon name="chart" size={16} /> 复盘图表</div>
        <span className="panel-sub">资金曲线 · 每日盈亏 · 个股盈亏排行</span>
      </div>
      <div className="rv-charts">
        <div className="rv-chart">
          <div className="rv-chart-title">累计收益曲线 <span className="sub-name">每笔平仓/做T后的累计净收益走势</span></div>
          <ReactECharts option={equityOption} style={{ height: 240 }} notMerge lazyUpdate />
        </div>
        <div className="rv-chart-2col">
          <div className="rv-chart">
            <div className="rv-chart-title">每日盈亏 <span className="sub-name">红盈绿亏</span></div>
            <ReactECharts option={dailyOption} style={{ height: 240 }} notMerge lazyUpdate />
          </div>
          <div className="rv-chart">
            <div className="rv-chart-title">个股盈亏排行 <span className="sub-name">{stockCount} 只</span></div>
            <ReactECharts option={stockOption} style={{ height: Math.max(240, stockCount * 30 + 30) }} notMerge lazyUpdate />
          </div>
        </div>
      </div>
      <div className="legend" style={{ padding: '4px 18px 12px' }}>
        资金曲线看整体稳定性与回撤 · 每日盈亏看盈亏天分布(防扛单) · 个股排行看钱赚在哪、亏在哪。均为已实现净收益(含费)。
      </div>
    </div>
  )
}
