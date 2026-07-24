import { useState } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import { planStore, usePlanStore, computeTFlows } from '../planStore'
import { fmtPct, pctClass } from '../format'

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
    const { pairList } = computeTFlows(h.tFlows)
    for (const p of (pairList || [])) {
      liveT.push({
        id: h.id + '_' + p.at, type: 'T', kind: 'T', live: true, code: h.code, name: h.name,
        qty: p.qty, buyPrice: p.buyPrice, sellPrice: p.sellPrice,
        buyFee: p.buyFee, sellFee: p.sellFee, grossPnl: p.grossPnl, netPnl: p.netPnl, realizedPnl: p.netPnl,
        pnlPct: p.buyPrice ? +(p.netPnl / (p.buyPrice * p.qty * 100 + p.buyFee) * 100).toFixed(2) : 0,
        tDir: p.tDir, holdingId: h.id, buyAt: p.buyAt, sellAt: p.sellAt, at: p.at,
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
function TxnRow({ c }) {
  const t = typeKey(c)
  const tag = t === 'T'
    ? { cls: c.tDir === 'reverse' ? 'rev' : 'pos', label: c.tDir === 'reverse' ? '反T' : '正T' }
    : t === 'BUY' ? { cls: 'buy', label: '买入' }
    : t === 'SELL' ? { cls: 'sell', label: '卖出' }
    : { cls: 'close', label: '平仓' }
  const single = t === 'BUY' || t === 'SELL'
  const priceText = single
    ? `${(c.price ?? (t === 'BUY' ? c.buyPrice : c.sellPrice))?.toFixed(2)} × ${c.qty}手`
    : `${c.buyPrice?.toFixed(2)}→${c.sellPrice?.toFixed(2)}`
  return (
    <div className="day-item">
      <span className="di-time">{hm(c.at || c.sellAt || c.buyAt)}</span>
      <span className="di-op">
        <span className={'di-tag ' + tag.cls}>{tag.label}</span>
        <span className="sub-name">{c.qty}手</span>
        {c.live && <span className="di-live">持仓中</span>}
      </span>
      <span className="di-price">{priceText}</span>
      {c.realizedPnl != null
        ? <span className={'di-net ' + (c.realizedPnl >= 0 ? 'red' : 'green')}>{fmtMoney(c.realizedPnl)}</span>
        : <span className="di-net di-cash">{t === 'BUY' ? '建/加仓' : '—'}</span>}
      {c.live
        ? <span className="di-del-ph" title="做T在持仓中，请在「我的计划」里增删">·</span>
        : <span className="del di-del" title="删除此记录" onClick={() => planStore.removeClosed(c.id)}>×</span>}
    </div>
  )
}
function DailyLog({ records }) {
  const [filter, setFilter] = useState('all') // all | BUY | SELL | CLOSE | T
  const [confirmClear, setConfirmClear] = useState(false)
  const [collapsed, setCollapsed] = useState({}) // key(day 或 day|code) → 是否折叠
  const toggle = (key) => setCollapsed((s) => ({ ...s, [key]: !s[key] }))
  const filtered = records.filter((c) => filter === 'all' || typeKey(c) === filter)

  // 按天分组
  const groups = {}
  for (const c of filtered) {
    const k = dayKey(c.at || c.sellAt || c.buyAt || Date.now())
    if (!groups[k]) groups[k] = []
    groups[k].push(c)
  }
  const days = Object.keys(groups).sort((a, b) => (a < b ? 1 : -1)) // 新到旧
  const today = dayKey(Date.now())

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="clipboard" size={16} /> 每日操作流水</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="tabs">
            {[['all', '全部'], ['BUY', '买入'], ['SELL', '卖出'], ['CLOSE', '平仓'], ['T', '做T']].map(([k, t]) => (
              <div key={k} className={'tab' + (filter === k ? ' active' : '')} onClick={() => setFilter(k)}>{t}</div>
            ))}
          </div>
          {(records || []).some((c) => !c.live) && (
            <button className="btn" title="清空所有已存交易记录（持仓中的做T不受影响）"
              onClick={() => setConfirmClear(true)}>
              <Icon name="trash" size={13} />清空
            </button>
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
      {days.length === 0 ? (
        <div className="empty">买入、卖出或做T后，这里按天汇总你当天的所有操作，方便回看每天的进出与盈亏。</div>
      ) : (
        <div className="scroll" style={{ maxHeight: 520 }}>
          {days.map((day) => {
            const items = groups[day].slice().sort((a, b) => (b.at || b.sellAt || 0) - (a.at || a.sellAt || 0))
            // 已实现盈亏只统计有 realizedPnl 的（BUY 不计）
            const net = items.reduce((a, c) => a + (c.realizedPnl ?? 0), 0)
            const fee = items.reduce((a, c) => a + feeOf(c), 0)
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
                              {g.buyAvg != null && <span className="ds-avg-i"><span className="ds-avg-k buy">买均</span><b>{g.buyAvg.toFixed(2)}</b></span>}
                              {g.sellAvg != null && <span className="ds-avg-i"><span className="ds-avg-k sell">卖均</span><b>{g.sellAvg.toFixed(2)}</b></span>}
                              <span className="ds-avg-fee">费{g.fee.toFixed(0)}</span>
                            </span>
                            <span className={'ds-stock-net ' + (g.net >= 0 ? 'red' : 'green')}>{fmtMoney(g.net)}</span>
                          </div>
                          {!stockFolded && g.items.map((c, i) => <TxnRow c={c} key={c.id || i} />)}
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
function statOf(arr) {
  const n = arr.length
  const win = arr.filter((c) => (c.realizedPnl ?? 0) > 0).length
  const net = arr.reduce((a, c) => a + (c.realizedPnl ?? 0), 0)
  return { n, rate: n ? Math.round((win / n) * 100) : null, net }
}
function TradeStat({ records }) {
  const buys = records.filter((c) => typeKey(c) === 'BUY')
  const sells = records.filter((c) => typeKey(c) === 'SELL' || typeKey(c) === 'CLOSE') // 卖出兑现(含旧平仓)
  const ts = records.filter((c) => typeKey(c) === 'T')
  const sStat = statOf(sells)
  const tStat = statOf(ts)
  const totalNet = sStat.net + tStat.net // 已实现净收益(买入不计盈亏)
  const totalFee = records.reduce((a, c) => a + feeOf(c), 0)
  const buyAmt = buys.reduce((a, c) => a + (c.amount ?? 0), 0)
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
            <div className="rv-kpi-cell-head"><span className="di-tag buy">买入</span>买入投入</div>
            <div className="rv-kpi-cell-val">{buys.length ? fmtMoney(buyAmt).replace('+', '') : '--'}</div>
            <div className="rv-kpi-cell-sub">{buys.length} 笔</div>
          </div>
          {/* 卖出兑现 */}
          <div className="rv-kpi-cell">
            <div className="rv-kpi-cell-head"><span className="di-tag sell">卖出</span>卖出兑现</div>
            <div className={'rv-kpi-cell-val ' + (sStat.net > 0 ? 'red' : sStat.net < 0 ? 'green' : '')}>{sStat.n ? fmtMoney(sStat.net) : '--'}</div>
            <div className="rv-kpi-cell-sub">{sStat.n} 笔 · 胜率 {sStat.rate != null ? sStat.rate + '%' : '--'}</div>
          </div>
          {/* 做T */}
          <div className="rv-kpi-cell">
            <div className="rv-kpi-cell-head"><span className="di-tag pos">做T</span>做T交易</div>
            <div className={'rv-kpi-cell-val ' + (tStat.net > 0 ? 'red' : tStat.net < 0 ? 'green' : '')}>{tStat.n ? fmtMoney(tStat.net) : '--'}</div>
            <div className="rv-kpi-cell-sub">{tStat.n} 笔 · 胜率 {tStat.rate != null ? tStat.rate + '%' : '--'}</div>
          </div>
        </div>
      )}
    </div>
  )
}

