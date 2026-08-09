import { useState } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import { usePolling } from '../hooks'
import { planStore, usePlanStore, computeTFlows } from '../planStore'
import { fmtRaw, pctClass } from '../format'

// 金额显示：万以上转万，保留2位
function money(v) {
  const a = Math.abs(v || 0)
  const s = v < 0 ? '-' : ''
  if (a >= 1e8) return s + (a / 1e8).toFixed(2) + '亿'
  if (a >= 1e4) return s + (a / 1e4).toFixed(2) + '万'
  return s + a.toFixed(0)
}
function signMoney(v) { return (v >= 0 ? '+' : '') + money(v) }

// ============ 账户全景：仓位 / 资金 / 浮盈 管理 ============
export default function AccountTab({ interval }) {
  const book = usePlanStore()
  const account = book.account || {}
  const [editing, setEditing] = useState(false)
  const [total, setTotal] = useState(account.totalAssets != null ? String(account.totalAssets) : '')
  const [cash, setCash] = useState(account.cash != null ? String(account.cash) : '')
  const [goal, setGoal] = useState(account.goal != null ? String(account.goal) : '')

  // 拉持仓实时报价
  const codes = [...new Set(book.holding.map((x) => x.code))]
  const { data } = usePolling(codes.length ? `/api/quote?codes=${codes.join(',')}` : null, interval, [codes.join(',')])
  const quote = {}
  ;(data?.list || []).forEach((s) => { quote[s.code] = s })

  // 逐笔持仓市值 / 成本 / 浮盈
  const rows = book.holding.map((h) => {
    const q = quote[h.code]
    const price = q ? q.price : h.buyPrice
    const shares = (h.qty || 0) * 100
    const mktVal = price * shares
    const cost = h.buyPrice * shares + (h.buyFee || 0)
    const tStat = computeTFlows(h.tFlows)
    const floatPnl = mktVal - cost + (tStat.realized || 0)
    return { h, q, price, mktVal, cost, floatPnl, pct: q ? q.pct : null }
  })
  const holdMktVal = rows.reduce((a, r) => a + r.mktVal, 0)   // 持仓总市值
  const holdCost = rows.reduce((a, r) => a + r.cost, 0)       // 持仓总成本
  const floatPnlTotal = rows.reduce((a, r) => a + r.floatPnl, 0)

  const totalAssets = Number(account.totalAssets) || 0
  // 可用资金 = 总资产 − 持仓市值(账户恒等式)。用户手填的可用资金也须以此封顶并夹到 ≥0,
  // 否则把已成持仓的钱重复算作可用(与 planStore.computePortfolio 同口径)。
  const cashVal = totalAssets > 0
    ? (account.cash != null ? Math.min(Number(account.cash), Math.max(totalAssets - holdMktVal, 0)) : Math.max(totalAssets - holdMktVal, 0))
    : (account.cash != null ? Number(account.cash) : 0)
  // 若用户填了总资产，用它；否则用 持仓市值+现金 估算
  const equity = totalAssets > 0 ? totalAssets : holdMktVal + cashVal
  const positionPct = equity > 0 ? (holdMktVal / equity) * 100 : 0

  const saveAccount = () => {
    planStore.setAccount({ totalAssets: total ? Number(total) : null, cash: cash ? Number(cash) : null, goal: goal ? Number(goal) : null })
    setEditing(false)
  }

  const posLevel = positionPct >= 90 ? 'full' : positionPct >= 70 ? 'high' : positionPct >= 40 ? 'mid' : 'low'
  const posLabel = { full: '满仓', high: '重仓', mid: '半仓', low: '轻仓' }[posLevel]

  // 目标资产（以终为始）：进度 / 还需净赚 / 所需涨幅
  const goalVal = account.goal != null ? Number(account.goal) : 0
  const goalProgress = goalVal > 0 && equity > 0 ? (equity / goalVal) * 100 : null
  const goalGap = goalVal > 0 ? goalVal - equity : null          // >0=还差；<0=已超额
  const goalReturnPct = goalVal > 0 && equity > 0 ? ((goalVal - equity) / equity) * 100 : null
  const goalReached = goalGap != null && goalGap <= 0

  return (
    <div className="account">
      {/* 账户全景卡 */}
      <div className="panel">
        <div className="panel-head">
          <div className="panel-title"><Icon name="gauge" size={16} /> 账户全景</div>
          <button className="btn" onClick={() => { setTotal(account.totalAssets != null ? String(account.totalAssets) : ''); setCash(account.cash != null ? String(account.cash) : ''); setGoal(account.goal != null ? String(account.goal) : ''); setEditing(true) }}>
            <Icon name="edit" size={13} /> 设置资金
          </button>
        </div>

        {editing && (
          <div className="acc-edit">
            <div className="acc-edit-row">
              <label>总资产(元)</label>
              <input className="wl-input" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="如 100000" inputMode="decimal" />
            </div>
            <div className="acc-edit-row">
              <label>可用资金(元)</label>
              <input className="wl-input" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="留空则自动=总资产−持仓市值" inputMode="decimal" />
            </div>
            <div className="acc-edit-row">
              <label>目标资产(元)</label>
              <input className="wl-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="以终为始，如 500000（50万）" inputMode="decimal" />
            </div>
            <div className="acc-edit-actions">
              <button className="chip-btn ghost" onClick={() => setEditing(false)}>取消</button>
              <button className="chip-btn done" onClick={saveAccount}><Icon name="check" size={12} />保存</button>
            </div>
          </div>
        )}

        <div className="acc-grid">
          <div className="acc-hero">
            <div className="acc-hero-label">总资产</div>
            <div className="acc-hero-val">{equity > 0 ? money(equity) : '--'}</div>
            <div className="acc-hero-sub">{totalAssets > 0 ? '手动录入' : '持仓市值 + 可用资金估算'}</div>
          </div>
          <div className="acc-cell">
            <div className="acc-cell-k">持仓市值</div>
            <div className="acc-cell-v">{money(holdMktVal)}</div>
            <div className="acc-cell-s">{rows.length} 只</div>
          </div>
          <div className="acc-cell">
            <div className="acc-cell-k">可用资金</div>
            <div className="acc-cell-v">{money(cashVal)}</div>
            <div className="acc-cell-s">{equity > 0 ? ((cashVal / equity) * 100).toFixed(0) + '% 空仓' : '--'}</div>
          </div>
          <div className="acc-cell">
            <div className="acc-cell-k">浮动盈亏</div>
            <div className={'acc-cell-v ' + (floatPnlTotal >= 0 ? 'red' : 'green')}>{signMoney(floatPnlTotal)}</div>
            <div className="acc-cell-s">{holdCost > 0 ? ((floatPnlTotal / holdCost) * 100).toFixed(2) + '%' : '--'}</div>
          </div>
        </div>

        {/* 仓位条 */}
        <div className="acc-posbar-wrap">
          <div className="acc-posbar-head">
            <span>当前仓位 <b className={'pos-' + posLevel}>{positionPct.toFixed(1)}%</b> <span className={'pos-tag pos-' + posLevel}>{posLabel}</span></span>
            {positionPct >= 90 && <span className="acc-warn"><Icon name="info" size={12} /> 仓位过重，注意控制风险</span>}
          </div>
          <div className="acc-posbar"><div className={'acc-posbar-fill pos-' + posLevel} style={{ width: Math.min(positionPct, 100) + '%' }} /></div>
        </div>

        {/* 目标资产进度条（以终为始） */}
        {goalVal > 0 ? (
          <div className="acc-goalbar-wrap">
            <div className="acc-goalbar-head">
              <span className="acc-goal-title"><Icon name="target" size={13} /> 目标资产 <b>{money(goalVal)}</b></span>
              <span className={'acc-goal-prog ' + (goalReached ? 'done' : '')}>{goalProgress != null ? goalProgress.toFixed(1) + '%' : '--'}</span>
            </div>
            <div className="acc-goalbar"><div className={'acc-goalbar-fill' + (goalReached ? ' done' : '')} style={{ width: Math.min(goalProgress || 0, 100) + '%' }} /></div>
            <div className="acc-goal-meta">
              {goalReached
                ? <span className="acc-goal-reached"><Icon name="check" size={12} /> 已达标，超额 {money(Math.abs(goalGap))}</span>
                : <>
                    <span>还需净赚 <b className="red">{money(goalGap)}</b></span>
                    <span>需再涨 <b>{goalReturnPct != null ? goalReturnPct.toFixed(1) + '%' : '--'}</b></span>
                  </>}
            </div>
          </div>
        ) : (
          <div className="acc-goal-hint">
            <Icon name="target" size={12} /> 设置「目标资产」后，AI 操作建议 / 复盘 / 加减仓都会围绕你的目标给节奏与仓位。点右上「设置资金」填写。
          </div>
        )}
      </div>

      {/* 持仓明细（占比 + 浮盈） */}
      <div className="panel">
        <div className="panel-head"><div className="panel-title"><Icon name="wallet" size={16} /> 持仓分布 <span className="sub-name">{rows.length} 只 · 按市值占比</span></div></div>
        {rows.length === 0 ? (
          <div className="empty">暂无持仓。在「持仓·做T」里建仓后，这里展示每只票的市值占比与浮盈。</div>
        ) : (
          <div className="acc-holdlist">
            {rows.sort((a, b) => b.mktVal - a.mktVal).map((r) => {
              const weight = equity > 0 ? (r.mktVal / equity) * 100 : 0
              const over = weight > 20 // 单票超20%告警
              return (
                <div className="acc-hold" key={r.h.id}>
                  <div className="acc-hold-top">
                    <StockName code={r.h.code} name={r.h.name}><span className="acc-hold-name">{r.h.name}</span></StockName>
                    <span className="acc-hold-code">{r.h.code}</span>
                    {over && <span className="acc-hold-warn" title="单票占比过高">超配</span>}
                    <span className={'acc-hold-pnl ' + (r.floatPnl >= 0 ? 'red' : 'green')} style={{ marginLeft: 'auto' }}>{signMoney(r.floatPnl)}</span>
                  </div>
                  <div className="acc-hold-bar"><div className={'acc-hold-bar-fill' + (over ? ' over' : '')} style={{ width: Math.min(weight, 100) + '%' }} /></div>
                  <div className="acc-hold-meta">
                    <span>占比 <b>{weight.toFixed(1)}%</b></span>
                    <span>市值 {money(r.mktVal)}</span>
                    <span>{r.h.qty}手 · 成本 {fmtRaw(r.h.buyPrice)}</span>
                    {r.q && <span>现价 <b className={pctClass(r.q.pct)}>{fmtRaw(r.price)}</b></span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
