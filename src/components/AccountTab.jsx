import { useState } from 'react'
import Icon from './Icon'
import PortfolioHeatmap from './PortfolioHeatmap'
import PortfolioAnalysis from './PortfolioAnalysis'
import { usePolling } from '../hooks'
import { computePortfolio, planStore, usePlanStore } from '../planStore'
import { useStockTags } from '../stockTagStore'
import { buildPortfolioDistribution } from '../../shared/portfolioDistribution.js'

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
  const [total, setTotal] = useState(
    account.initialCapital != null
      ? String(account.initialCapital)
      : account.totalAssets != null
        ? String(account.totalAssets)
        : '',
  )
  const [cash, setCash] = useState(account.cash != null ? String(account.cash) : '')
  const [goal, setGoal] = useState(account.goal != null ? String(account.goal) : '')

  // 拉持仓实时报价
  const codes = [...new Set(book.holding.map((x) => x.code))]
  const { data } = usePolling(codes.length ? `/api/quote?codes=${codes.join(',')}` : null, interval, [codes.join(',')])
  const quote = {}
  ;(data?.list || []).forEach((s) => { quote[s.code] = s })
  const stockTags = useStockTags(codes)
  const portfolio = computePortfolio(book.holding, quote, account)
  const distribution = buildPortfolioDistribution(
    portfolio,
    stockTags,
    {},
    quote,
  )
  const holdMktVal = portfolio.holdMktValue
  const cashVal = portfolio.cash ?? 0
  const equity = portfolio.totalAssets
  const positionPct = portfolio.position ?? 0
  const initialCapital = portfolio.initialCapital
  const totalPnl = portfolio.totalPnl
  const totalPnlPct = portfolio.totalPnlPct

  const saveAccount = () => {
    const nextInitialCapital = total ? Number(total) : null
    const nextCash = cash
      ? Number(cash)
      : account.cash != null
        ? Number(account.cash)
        : nextInitialCapital != null
          ? Math.max(0, +(nextInitialCapital - holdMktVal).toFixed(2))
          : null
    planStore.setAccount({
      initialCapital: nextInitialCapital,
      totalAssets: nextInitialCapital,
      cash: nextCash,
      goal: goal ? Number(goal) : null,
    })
    setEditing(false)
  }

  const posLevel = positionPct >= 90 ? 'full' : positionPct >= 70 ? 'high' : positionPct >= 40 ? 'mid' : 'low'
  const posLabel = { full: '满仓', high: '重仓', mid: '半仓', low: '轻仓' }[posLevel]

  // 目标资产（以终为始）：进度 / 还需净赚 / 所需涨幅
  const goalVal = portfolio.goal || 0
  const goalProgress = portfolio.goalProgress
  const goalGap = portfolio.goalGap
  const goalReturnPct = portfolio.goalReturnPct
  const goalReached = goalGap != null && goalGap <= 0

  return (
    <div className="account">
      {/* 账户全景卡 */}
      <div className="panel">
        <div className="panel-head">
          <div role="heading" aria-level="2" className="panel-title"><Icon name="gauge" size={16} /> 账户全景</div>
          <button className="btn" onClick={() => {
            setTotal(account.initialCapital != null
              ? String(account.initialCapital)
              : account.totalAssets != null
                ? String(account.totalAssets)
                : '')
            setCash(portfolio.cash != null ? String(portfolio.cash) : '')
            setGoal(account.goal != null ? String(account.goal) : '')
            setEditing(true)
          }}>
            <Icon name="edit" size={13} /> 校准账户
          </button>
        </div>

        {editing && (
          <div className="acc-edit">
            <div className="acc-edit-row">
              <label>投入本金 / 盈亏基准(元)</label>
              <input className="wl-input" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="如 100000，仅用于计算累计盈亏" inputMode="decimal" />
            </div>
            <div className="acc-edit-row">
              <label>当前可用资金(元)</label>
              <input className="wl-input" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="按券商余额填写，后续买卖自动更新" inputMode="decimal" />
            </div>
            <div className="acc-edit-row">
              <label>目标资产(元)</label>
              <input className="wl-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="以终为始，如 500000（50万）" inputMode="decimal" />
            </div>
            <div className="acc-edit-note">
              当前总资产无需手填，系统会按“可用资金 + 实时持仓市值”自动计算。
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
            <div className="acc-hero-sub">可用资金 + 实时持仓市值</div>
          </div>
          <div className="acc-cell">
            <div className="acc-cell-k">持仓市值</div>
            <div className="acc-cell-v">{money(holdMktVal)}</div>
            <div className="acc-cell-s">{distribution.stocks.length} 只</div>
          </div>
          <div className="acc-cell">
            <div className="acc-cell-k">可用资金</div>
            <div className="acc-cell-v">{money(cashVal)}</div>
            <div className="acc-cell-s">{equity > 0 ? ((cashVal / equity) * 100).toFixed(0) + '% 空仓' : '--'}</div>
          </div>
          <div className="acc-cell">
            <div className="acc-cell-k">累计盈亏</div>
            <div className={'acc-cell-v ' + ((totalPnl ?? 0) >= 0 ? 'red' : 'green')}>
              {totalPnl != null ? signMoney(totalPnl) : '--'}
            </div>
            <div className="acc-cell-s">
              {totalPnlPct != null
                ? `${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%`
                : initialCapital != null
                  ? `基准 ${money(initialCapital)}`
                  : '设置盈亏基准'}
            </div>
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
            <Icon name="target" size={12} /> 设置「目标资产」后，军师建议、复盘与加减仓都会围绕你的目标给节奏与仓位。点右上「校准账户」填写。
          </div>
        )}
      </div>

      {/* 核心概念 → 个股两层持仓热力图 */}
      <div className="panel">
        <div className="panel-head"><div role="heading" aria-level="2" className="panel-title"><Icon name="wallet" size={16} /> 持仓分布 <span className="sub-name">{distribution.stocks.length} 只 · 面积看仓位 · 红涨绿跌</span></div></div>
        {distribution.stocks.length === 0 ? (
          <div className="empty">暂无持仓。在「持仓·做T」里建仓后，这里按核心概念展示持仓结构。</div>
        ) : (
          <>
            <PortfolioHeatmap distribution={distribution} />
            <PortfolioAnalysis distribution={distribution} />
          </>
        )}
      </div>
    </div>
  )
}
