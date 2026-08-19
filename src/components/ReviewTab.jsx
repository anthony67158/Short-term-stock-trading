import { useState, useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import Icon from './Icon'
import StockName from './StockName'
import StockTags from './StockTags'
import { planStore, usePlanStore, computeTFlows } from '../planStore'
import { finiteNum, fmtPct, pctClass, fmtRaw } from '../format'
import {
  tradeAnalyticsRecords,
} from '../../shared/portfolioAccounting.js'
import {
  editableTradeIntent,
  tradeIntentLabel,
  tradeIntentOf,
  tradeIntentOptions,
} from '../../shared/tradeIntent.js'
import {
  manualTradePairCandidates,
} from '../../shared/tradePairing.js'
import {
  listTradePeriods,
  summarizeTradePeriod,
} from '../../shared/tradePeriodPerformance.js'

// 汇总所有交易记录：已存 closed（BUY/SELL/CLOSE/T）+ 持仓中实时做T（未归档）
function useRealizedRecords(book) {
  const closed = (book.closed || []).map((c) => ({
    ...c,
    type: c.type || (c.kind === 'T' ? 'T' : 'CLOSE'), // 兼容旧数据
    realizedPnl: c.realizedPnl != null
      ? finiteNum(c.realizedPnl, null)
      : finiteNum(c.netPnl, null),
  }))
  // 持仓中每笔已配对的做T（尚未归档，标记为 live 便于区分）
  const liveT = []
  for (const h of book.holding || []) {
    const r = computeTFlows(h.tFlows)
    for (const p of (r.pairList || [])) {
      const qty = finiteNum(p.qty)
      const buyPrice = finiteNum(p.buyPrice)
      const sellPrice = finiteNum(p.sellPrice)
      const buyFee = finiteNum(p.buyFee)
      const sellFee = finiteNum(p.sellFee)
      const netPnl = finiteNum(p.netPnl)
      const costBasis = buyPrice * qty * 100 + buyFee
      liveT.push({
        id: h.id + '_' + p.at, type: 'T', kind: 'T', live: true, code: h.code, name: h.name,
        tradeIntent: 't',
        qty, buyPrice, sellPrice, buyFee, sellFee,
        grossPnl: finiteNum(p.grossPnl), netPnl, realizedPnl: netPnl,
        pnlPct: costBasis > 0 ? +(netPnl / costBasis * 100).toFixed(2) : 0,
        tDir: p.tDir, holdingId: h.id, buyAt: p.buyAt, sellAt: p.sellAt, at: p.at,
      })
    }
    // 未配平开口腿：净买入→加仓(BUY)、净卖出→减仓(SELL)，实时体现在交易记录（标 live+待结算）
    const openBuy = finiteNum(r.openBuy)
    const openBuyAvg = finiteNum(r.openBuyAvg, null)
    const openSell = finiteNum(r.openSell)
    const openSellAvg = finiteNum(r.openSellAvg, null)
    if (openBuy > 0 && openBuyAvg != null) {
      const amount = +(openBuyAvg * openBuy * 100).toFixed(2)
      liveT.push({
        id: h.id + '_openbuy', type: 'BUY', live: true, pending: true, code: h.code, name: h.name, side: 'buy',
        tradeIntent: 't',
        qty: openBuy, price: openBuyAvg, buyPrice: openBuyAvg,
        fee: finiteNum(r.openBuyFee), amount,
        realizedPnl: null, holdingId: h.id, at: r.openBuyAt || Date.now(),
      })
    }
    if (openSell > 0 && openSellAvg != null) {
      const shares = openSell * 100
      const amount = +(openSellAvg * shares).toFixed(2)
      const costPrice = finiteNum(h.buyPrice)
      const cost = costPrice * shares
      const holdingQty = finiteNum(h.qty)
      const buyFeePart = holdingQty
        ? +((finiteNum(h.buyFee) * (openSell / holdingQty))).toFixed(2)
        : 0
      const sellFee = finiteNum(r.openSellFee)
      const netPnl = +((amount - cost) - sellFee - buyFeePart).toFixed(2)
      liveT.push({
        id: h.id + '_opensell', type: 'SELL', kind: 'SELL', live: true, pending: true, code: h.code, name: h.name, side: 'sell',
        tradeIntent: 't',
        qty: openSell, price: openSellAvg, sellPrice: openSellAvg, buyPrice: costPrice, costPrice,
        fee: sellFee, buyFee: buyFeePart, sellFee, amount,
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
  const analyticsRecords = useMemo(
    () => tradeAnalyticsRecords(records),
    [records],
  )

  return (
    <div className="review">
      <DecisionClosure book={book} />
      <TradeStat records={records} analyticsRecords={analyticsRecords} />
      <ReviewCharts records={analyticsRecords} />
      <DailyLog records={records} />
    </div>
  )
}

function DecisionClosure({ book }) {
  const stats = useMemo(() => planStore.decisionStats(), [book.decisionLog])
  return (
    <div className="panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="target" size={16} /> 决策闭环</div>
        <span className="panel-sub">AI 建议不等于真实操作，只统计实际落账</span>
      </div>
      {stats.recommendations === 0 && stats.executions === 0 ? (
        <div className="empty">生成 AI 操作建议并记录真实买卖后，这里会显示建议采纳与执行关联。</div>
      ) : (
        <div className="rv-attr">
          <div className="rv-attr-cell">
            <div className="rv-attr-k">AI 建议</div>
            <div className="rv-attr-v">{stats.recommendations}</div>
            <div className="rv-attr-s">{stats.actionableRecommendations} 条可执行 · {stats.pending} 条待执行</div>
          </div>
          <div className="rv-attr-cell">
            <div className="rv-attr-k">建议后执行</div>
            <div className="rv-attr-v">{stats.executedRecommendations}</div>
            <div className="rv-attr-s">同股同方向、24 小时内</div>
          </div>
          <div className="rv-attr-cell">
            <div className="rv-attr-k">真实执行</div>
            <div className="rv-attr-v">{stats.executions}</div>
            <div className="rv-attr-s">{stats.linkedExecutions} 笔关联到建议</div>
          </div>
          <div className="rv-attr-cell">
            <div className="rv-attr-k">采纳率</div>
            <div className="rv-attr-v">{stats.adoptionRate == null ? '--' : stats.adoptionRate + '%'}</div>
            <div className="rv-attr-s">已执行建议 / 全部建议</div>
          </div>
        </div>
      )}
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
    const q = finiteNum(c.qty), sh = q * 100
    const isBuy = c.type === 'BUY'
    const isSell = c.type === 'SELL'
    if (isBuy) {
      const fee = finiteNum(c.fee ?? c.buyFee)
      g.bq += q; g.ba += finiteNum(c.price || c.buyPrice) * sh; g.bf += fee
      g.fee += fee
    } else if (isSell) {
      const fee = finiteNum(c.fee ?? c.sellFee)
      g.sq += q; g.sa += finiteNum(c.price || c.sellPrice) * sh; g.sf += fee
      g.fee += fee
    } else { // CLOSE / T：买卖双腿
      const buyFee = finiteNum(c.buyFee)
      const sellFee = finiteNum(c.sellFee)
      g.bq += q; g.ba += finiteNum(c.buyPrice) * sh; g.bf += buyFee
      g.sq += q; g.sa += finiteNum(c.sellPrice) * sh; g.sf += sellFee
      g.fee += buyFee + sellFee
    }
  }
  return [...map.values()].map((g) => ({
    ...g,
    items: g.items.sort((a, b) => (b.at || b.sellAt || 0) - (a.at || a.sellAt || 0)),
    net: tradeAnalyticsRecords(g.items).reduce(
      (sum, item) => sum + finiteNum(item.realizedPnl),
      0,
    ),
    buyAvg: g.bq ? (g.ba + g.bf) / (g.bq * 100) : null,   // 含费买入均价
    sellAvg: g.sq ? (g.sa - g.sf) / (g.sq * 100) : null,  // 含费卖出均价
  })).sort((a, b) => (b.items[0]?.at || 0) - (a.items[0]?.at || 0))
}
// 交易类型归一化 key
function typeKey(c) { return c.type || (c.kind === 'T' ? 'T' : 'CLOSE') }
function filterKey(c) {
  return tradeIntentOf(c) === 't' ? 'T' : typeKey(c)
}
// 单条记录的手续费（单腿用 fee，回合用买+卖）
function feeOf(c) {
  if (c.fee != null && (c.type === 'BUY' || c.type === 'SELL')) return finiteNum(c.fee)
  return finiteNum(c.buyFee) + finiteNum(c.sellFee)
}
// 单条流水行渲染（区分 纯买入/纯卖出/平仓/做T）
function TxnRow({ c, onDelete, onEdit, showDate }) {
  const t = typeKey(c)
  const intent = tradeIntentOf(c)
  const tag = t === 'T'
    ? { cls: c.tDir === 'reverse' ? 'rev' : 'pos', label: tradeIntentLabel(c) }
    : intent === 't'
      ? { cls: t === 'BUY' ? 't-buy' : 't-sell', label: t === 'BUY' ? 'T买' : 'T卖' }
    : t === 'BUY' ? { cls: 'buy', label: '建/加' }
    : t === 'SELL' ? { cls: 'sell', label: '减/清' }
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
      {intent === 't' && t !== 'T'
        ? <span className={'di-net ' + (c.tPairTradeId ? 'di-paired' : 'di-cash')}>
            {c.tPairTradeId ? '已配对' : '待配对'}
          </span>
        : c.realizedPnl != null
        ? <span className={'di-net ' + (c.realizedPnl >= 0 ? 'red' : 'green')}>{fmtMoney(c.realizedPnl)}</span>
        : <span className="di-net di-cash">
            {t === 'BUY' ? '建/加仓' : '—'}
          </span>}
      {c.live
        ? <span className="di-del-ph" title="做T在持仓中，请在「我的计划」里增删">·</span>
        : <span className="di-row-actions">
            <button className="di-date-edit" title="修改操作类型、日期、价格和手数" onClick={() => onEdit(c)}>
              <Icon name="edit" size={11} />
            </button>
            <button className="del di-del" title="删除此记录" onClick={() => onDelete(c)}>×</button>
          </span>}
    </div>
  )
}

function PeriodPerformance({ records }) {
  const [periodMode, setPeriodMode] = useState('month')
  const [periodKey, setPeriodKey] = useState('')
  const periods = useMemo(
    () => listTradePeriods(records, periodMode),
    [records, periodMode],
  )
  const selected = periods.find((period) => period.key === periodKey)
    || periods[0]
  const summary = useMemo(
    () => summarizeTradePeriod(records, selected),
    [records, selected],
  )
  if (!selected) return null

  const setMode = (mode) => {
    setPeriodMode(mode)
    setPeriodKey('')
  }
  const rateTitle = summary.realizedCount > summary.ratedCount
    ? `收益率仅按 ${summary.ratedCount}/${summary.realizedCount} 笔有真实成本依据的已实现交易计算`
    : '收益率按本周期已实现交易盈亏除以对应含费成本计算'

  return (
    <div className="trade-period-performance" aria-label="周期收益统计">
      <div className="trade-period-controls">
        <span className="trade-period-label">周期收益</span>
        <div className="tabs trade-period-tabs" aria-label="收益统计周期">
          <button
            type="button"
            className={'tab' + (periodMode === 'month' ? ' active' : '')}
            aria-pressed={periodMode === 'month'}
            onClick={() => setMode('month')}
          >
            月
          </button>
          <button
            type="button"
            className={'tab' + (periodMode === 'week' ? ' active' : '')}
            aria-pressed={periodMode === 'week'}
            onClick={() => setMode('week')}
          >
            周
          </button>
        </div>
        <select
          className="trade-period-select"
          aria-label={periodMode === 'month' ? '选择收益月份' : '选择收益周'}
          value={selected.key}
          onChange={(event) => setPeriodKey(event.target.value)}
        >
          {periods.map((period) => (
            <option value={period.key} key={period.key}>
              {period.label}
            </option>
          ))}
        </select>
      </div>
      <div className="trade-period-metrics">
        <div className="trade-period-metric trade-period-return" title={rateTitle}>
          <span>收益率</span>
          <b className={pctClass(summary.returnPct)}>
            {summary.returnPct == null ? '--' : fmtPct(summary.returnPct)}
          </b>
          <small>{summary.ratedCount}/{summary.realizedCount} 笔可计算</small>
        </div>
        <div className="trade-period-metric">
          <span>已实现</span>
          <b className={pctClass(summary.realizedPnl)}>
            {fmtMoney(summary.realizedPnl)}
          </b>
          <small>{summary.realizedCount} 笔</small>
        </div>
        <div className="trade-period-metric">
          <span>成本基数</span>
          <b>{summary.costBasis > 0 ? fmtAmt(summary.costBasis) : '--'}</b>
          <small>含分摊买入费</small>
        </div>
        <div className="trade-period-metric">
          <span>手续费</span>
          <b>{fmtAmt(summary.fee)}</b>
          <small>{summary.transactionCount} 笔流水</small>
        </div>
      </div>
    </div>
  )
}

function DailyLog({ records }) {
  const [filter, setFilter] = useState('all') // all | BUY | SELL | CLOSE | T
  const [confirmClear, setConfirmClear] = useState(false)
  const [delTarget, setDelTarget] = useState(null) // 待删除的单条记录（可能级联同批）
  const [editTarget, setEditTarget] = useState(null)
  const [tradeDate, setTradeDate] = useState('')
  const [tradePrice, setTradePrice] = useState('')
  const [tradeBuyPrice, setTradeBuyPrice] = useState('')
  const [tradeSellPrice, setTradeSellPrice] = useState('')
  const [tradeQty, setTradeQty] = useState('')
  const [tradeIntent, setTradeIntent] = useState('position')
  const [pairTradeId, setPairTradeId] = useState('')
  const [editError, setEditError] = useState('')
  const [collapsed, setCollapsed] = useState({}) // key(day 或 day|code) → 是否折叠
  const [groupMode, setGroupMode] = useState('day') // day 按时间 | stock 按个股
  const toggle = (key) => setCollapsed((s) => ({ ...s, [key]: !s[key] }))
  const filtered = records.filter((c) =>
    filter === 'all' || filterKey(c) === filter
  )
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
  const openTradeEditor = (record) => {
    const timestamp = record.at || record.sellAt || record.buyAt || Date.now()
    const type = typeKey(record)
    setEditTarget(record)
    setTradeIntent(tradeIntentOf(record))
    setPairTradeId(String(record.tPairTradeId || ''))
    setTradeDate(dayKey(timestamp))
    setTradeQty(String(record.qty ?? ''))
    setTradePrice(
      type === 'BUY' || type === 'SELL'
        ? String(record.price ?? (type === 'BUY' ? record.buyPrice : record.sellPrice) ?? '')
        : '',
    )
    setTradeBuyPrice(type === 'T' || type === 'CLOSE' ? String(record.buyPrice ?? '') : '')
    setTradeSellPrice(type === 'T' || type === 'CLOSE' ? String(record.sellPrice ?? '') : '')
    setEditError('')
  }
  const pairTarget = editTarget ? (() => {
    const timestamp = editTarget.at
      || editTarget.sellAt
      || editTarget.buyAt
      || Date.now()
    const source = new Date(timestamp)
    const match = tradeDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (match) {
      source.setFullYear(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
      )
    }
    return {
      ...editTarget,
      qty: Number(tradeQty),
      at: source.getTime(),
    }
  })() : null
  const pairCandidates = tradeIntent === 't'
    && editableTradeIntent(editTarget)
    ? manualTradePairCandidates(records, pairTarget)
    : []
  const saveTradeEdit = () => {
    const type = typeKey(editTarget)
    const result = planStore.updateClosedTrade(editTarget?.id, {
      date: tradeDate,
      qty: Number(tradeQty),
      tradeIntent: tradeIntent,
      tPairTradeId: tradeIntent === 't' ? pairTradeId : null,
      ...(type === 'BUY' || type === 'SELL'
        ? { price: Number(tradePrice) }
        : {
            buyPrice: Number(tradeBuyPrice),
            sellPrice: Number(tradeSellPrice),
          }),
    })
    if (!result?.ok) {
      setEditError(result?.error || '交易流水修改失败')
      return
    }
    setEditTarget(null)
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="clipboard" size={16} /> 每日操作流水</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="tabs">
            {[['all', '全部'], ['BUY', '买入'], ['SELL', '卖出'], ['CLOSE', '平仓'], ['T', '做T']].map(([k, t]) => (
              <button type="button" key={k} className={'tab' + (filter === k ? ' active' : '')} aria-pressed={filter === k} onClick={() => setFilter(k)}>{t}</button>
            ))}
          </div>
          <div className="tabs">
            <button type="button" className={'tab' + (groupMode === 'day' ? ' active' : '')} aria-pressed={groupMode === 'day'} onClick={() => setGroupMode('day')}>按时间</button>
            <button type="button" className={'tab' + (groupMode === 'stock' ? ' active' : '')} aria-pressed={groupMode === 'stock'} onClick={() => setGroupMode('stock')}>按个股</button>
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

      <PeriodPerformance records={records} />

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
                <>确定删除 <b>{delTarget.name}</b><StockTags code={delTarget.code} variant="inline" /> 的这条记录？</>
              )}
              {delImpact.length > 0 && (
                <div className="del-impact">
                  <Icon name="info" size={12} /> 持仓将同步调整：
                  {delImpact.map((im, i) => (
                    <span key={i} className="del-impact-item">
                      {im.name} <StockTags code={im.code} variant="inline" />
                      <b className={im.delta > 0 ? 'red' : 'green'}>{im.delta > 0 ? '+' : ''}{im.delta}手</b>
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
      {editTarget && (
        <div className="modal-mask" onClick={() => setEditTarget(null)}>
          <div className="confirm-dialog trade-edit-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="confirm-title"><Icon name="edit" size={18} /> 修改交易流水</div>
            <div className="confirm-body">
              <b>{editTarget.name || editTarget.code}</b>
              {' · '}
              {tradeIntentLabel({
                ...editTarget,
                tradeIntent,
              })}
              <div className="trade-edit-grid">
                {editableTradeIntent(editTarget) && (
                  <label className="trade-edit-field trade-edit-wide trade-edit-intent">
                    <span>操作类型</span>
                    <select
                      className="wl-input"
                      value={tradeIntent}
                      onChange={(event) => {
                        const nextIntent = event.target.value
                        setTradeIntent(nextIntent)
                        if (nextIntent !== 't') setPairTradeId('')
                        setEditError('')
                      }}
                    >
                      {tradeIntentOptions(editTarget).map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {tradeIntent === 't' && editableTradeIntent(editTarget) && (
                  <label className="trade-edit-field trade-edit-wide trade-edit-pair">
                    <span>配对另一腿</span>
                    <select
                      className="wl-input"
                      value={pairTradeId}
                      onChange={(event) => {
                        setPairTradeId(event.target.value)
                        setEditError('')
                      }}
                    >
                      <option value="">暂不指定，继续按时间 FIFO</option>
                      {pairCandidates.map((record) => {
                        const type = typeKey(record)
                        const price = record.price
                          ?? (type === 'BUY'
                            ? record.buyPrice
                            : record.sellPrice)
                        const at = record.at
                          || record.sellAt
                          || record.buyAt
                        return (
                          <option value={record.id} key={record.id}>
                            {hm(at)} {type === 'BUY' ? '买入' : '卖出'} {fmtRaw(price)} × {record.qty}手
                          </option>
                        )
                      })}
                    </select>
                    <small>
                      仅列出同股、同日、买卖方向相反且手数一致的记录。
                      {pairTradeId ? ' 保存后两条记录会建立固定配对。' : ' 不指定时仍按原 FIFO 自动匹配。'}
                    </small>
                  </label>
                )}
                <label className="trade-edit-field">
                  <span>实际操作日期</span>
                  <input
                    className="wl-input"
                    type="date"
                    value={tradeDate}
                    max={dayKey(Date.now())}
                    onChange={(event) => { setTradeDate(event.target.value); setEditError('') }}
                  />
                </label>
                <label className="trade-edit-field">
                  <span>成交手数</span>
                  <input
                    className="wl-input"
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={tradeQty}
                    onChange={(event) => { setTradeQty(event.target.value); setEditError('') }}
                  />
                </label>
                {typeKey(editTarget) === 'BUY' || typeKey(editTarget) === 'SELL' ? (
                  <label className="trade-edit-field trade-edit-wide">
                    <span>成交价格</span>
                    <input
                      className="wl-input"
                      type="number"
                      min="0.001"
                      step="0.001"
                      inputMode="decimal"
                      value={tradePrice}
                      onChange={(event) => { setTradePrice(event.target.value); setEditError('') }}
                    />
                  </label>
                ) : (
                  <>
                    <label className="trade-edit-field">
                      <span>买入价格</span>
                      <input
                        className="wl-input"
                        type="number"
                        min="0.001"
                        step="0.001"
                        inputMode="decimal"
                        value={tradeBuyPrice}
                        onChange={(event) => { setTradeBuyPrice(event.target.value); setEditError('') }}
                      />
                    </label>
                    <label className="trade-edit-field">
                      <span>卖出价格</span>
                      <input
                        className="wl-input"
                        type="number"
                        min="0.001"
                        step="0.001"
                        inputMode="decimal"
                        value={tradeSellPrice}
                        onChange={(event) => { setTradeSellPrice(event.target.value); setEditError('') }}
                      />
                    </label>
                  </>
                )}
              </div>
              <small>
                {tradeIntent === 't' && editableTradeIntent(editTarget)
                  ? '手动选择的另一腿优先固定配对；未指定时按同股、同交易日和时间顺序自动配对。未配对腿仍按真实买卖影响现金、持仓与T+1。'
                  : '保存后会重算成交额、手续费、现金、持仓与已实现盈亏。'}
                {' '}修改会自动同步到阿里云 OSS。
              </small>
              {editError && <div className="err">{editError}</div>}
            </div>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setEditTarget(null)}>取消</button>
              <button className="btn btn-primary" onClick={saveTradeEdit}>
                <Icon name="check" size={13} /> 保存修改
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
                <div className="day-head day-head-split">
                  <button type="button" className="day-fold-toggle" aria-label={folded ? '展开个股交易记录' : '收起个股交易记录'} aria-expanded={!folded} onClick={() => toggle(skey)}>
                    <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={13} />
                  </button>
                  <StockName code={g.code} name={g.name} stopPropagation><span className="day-date">{g.name}</span></StockName>
                  <button type="button" className="day-summary-toggle" aria-expanded={!folded} onClick={() => toggle(skey)}>
                    <span className="day-sub">{g.items.length}笔 · {dayset.size}天</span>
                    {g.ba > 0 && <span className="day-flow">花 <b>{fmtAmt(g.ba + g.bf)}</b></span>}
                    {g.sa > 0 && <span className="day-flow">收 <b>{fmtAmt(g.sa - g.sf)}</b></span>}
                    <span className="day-net">已实现 <b className={g.net >= 0 ? 'red' : 'green'}>{fmtMoney(g.net)}</b></span>
                    <span className="day-fee">手续费 {fmtMoney(g.fee).replace('+', '')}</span>
                  </button>
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
                    {g.items.map((c, i) => <TxnRow c={c} key={c.id || i} onDelete={setDelTarget} onEdit={openTradeEditor} showDate />)}
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
            const analytics = tradeAnalyticsRecords(items)
            const net = analytics.reduce(
              (sum, item) => sum + finiteNum(item.realizedPnl),
              0,
            )
            const fee = items.reduce((a, c) => a + feeOf(c), 0)
            // 当天现金进出：买入花费(成交额+买费)、卖出回收(成交额−卖费)
            const daySpend = items.filter((c) => typeKey(c) === 'BUY').reduce((a, c) => a + amountOf(c) + finiteNum(c.fee ?? c.buyFee), 0)
            const dayRecover = items.filter((c) => typeKey(c) === 'SELL').reduce((a, c) => a + amountOf(c) - finiteNum(c.fee ?? c.sellFee), 0)
            const nBuy = items.filter((c) => filterKey(c) === 'BUY').length
            const nSell = items.filter((c) => filterKey(c) === 'SELL').length
            const nClose = items.filter((c) => typeKey(c) === 'CLOSE').length
            const nTPairs = items.filter((c) => typeKey(c) === 'T').length
            const nTLegs = items.filter((c) =>
              typeKey(c) !== 'T' && tradeIntentOf(c) === 't'
            ).length
            const parts = []
            if (nBuy) parts.push(`买入${nBuy}`)
            if (nSell) parts.push(`卖出${nSell}`)
            if (nClose) parts.push(`平仓${nClose}`)
            if (nTPairs) parts.push(`做T${nTPairs}`)
            if (nTLegs) parts.push(`T腿${nTLegs}`)
            const dayFolded = collapsed[day] ?? (day !== today) // 非今天默认折叠
            return (
              <div className="day-block" key={day}>
                <button type="button" className="day-head day-head-btn" aria-expanded={!dayFolded} onClick={() => toggle(day)}>
                  <Icon name={dayFolded ? 'chevronRight' : 'chevronDown'} size={13} />
                  <span className="day-date">{day}</span>
                  <span className="day-sub">{parts.join(' · ')}</span>
                  {daySpend > 0 && <span className="day-flow">花 <b>{fmtAmt(daySpend)}</b></span>}
                  {dayRecover > 0 && <span className="day-flow">收 <b>{fmtAmt(dayRecover)}</b></span>}
                  <span className="day-net">已实现 <b className={net >= 0 ? 'red' : 'green'}>{fmtMoney(net)}</b></span>
                  <span className="day-fee">手续费 {fmtMoney(fee).replace('+', '')}</span>
                </button>
                {!dayFolded && (
                  <div className="day-items">
                    {groupByStock(items).map((g) => {
                      const skey = day + '|' + g.code
                      const stockFolded = collapsed[skey] ?? false // 股票默认展开
                      return (
                        <div className="ds-stock" key={g.code}>
                          <div className="ds-stock-head ds-stock-head-split">
                            <button type="button" className="day-fold-toggle" aria-label={stockFolded ? '展开个股流水' : '收起个股流水'} aria-expanded={!stockFolded} onClick={() => toggle(skey)}>
                              <Icon name={stockFolded ? 'chevronRight' : 'chevronDown'} size={12} />
                            </button>
                            <StockName code={g.code} name={g.name} stopPropagation><span className="ds-stock-name">{g.name}</span></StockName>
                            <button type="button" className="ds-stock-summary" aria-expanded={!stockFolded} onClick={() => toggle(skey)}>
                              <span className="ds-stock-cnt">{g.items.length}笔</span>
                              <span className="ds-avg">
                                {g.buyAvg != null && <span className="ds-avg-i"><span className="ds-avg-k buy">买均</span><b>{fmtRaw(g.buyAvg)}</b></span>}
                                {g.sellAvg != null && <span className="ds-avg-i"><span className="ds-avg-k sell">卖均</span><b>{fmtRaw(g.sellAvg)}</b></span>}
                                {g.ba > 0 && <span className="ds-avg-i"><span className="ds-avg-k buy">花费</span><b>{fmtAmt(g.ba + g.bf)}</b></span>}
                                {g.sa > 0 && <span className="ds-avg-i"><span className="ds-avg-k sell">回收</span><b>{fmtAmt(g.sa - g.sf)}</b></span>}
                                <span className="ds-avg-fee">费{g.fee.toFixed(0)}</span>
                              </span>
                              <span className={'ds-stock-net ' + (g.net >= 0 ? 'red' : 'green')}>{fmtMoney(g.net)}</span>
                            </button>
                          </div>
                          {!stockFolded && g.items.map((c, i) => <TxnRow c={c} key={c.id || i} onDelete={setDelTarget} onEdit={openTradeEditor} />)}
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
  const value = finiteNum(v)
  const sign = value >= 0 ? '+' : '-'; const a = Math.abs(value)
  if (a >= 10000) return sign + (a / 10000).toFixed(2) + '万'
  return sign + a.toFixed(0)
}
// 无符号金额（成交额/花费/回收），万以上转万
function fmtAmt(v) {
  const a = Math.abs(finiteNum(v))
  if (a >= 10000) return (a / 10000).toFixed(2) + '万'
  return a.toFixed(0)
}
// 一条记录的成交额（不含费）：单腿用 amount，回合/做T用买腿或卖腿市值
function amountOf(c) {
  if (c.amount != null) return finiteNum(c.amount)
  const t = c.type || (c.kind === 'T' ? 'T' : 'CLOSE')
  const sh = finiteNum(c.qty) * 100
  if (t === 'BUY') return finiteNum(c.price ?? c.buyPrice) * sh
  if (t === 'SELL') return finiteNum(c.price ?? c.sellPrice) * sh
  return finiteNum(c.sellPrice) * sh // 平仓/做T 取卖出腿市值
}
function statOf(arr) {
  const n = arr.length
  const wins = arr.filter((c) => finiteNum(c.realizedPnl) > 0)
  const losses = arr.filter((c) => finiteNum(c.realizedPnl) < 0)
  const win = wins.length
  const net = arr.reduce((a, c) => a + finiteNum(c.realizedPnl), 0)
  const avgWin = wins.length ? wins.reduce((a, c) => a + finiteNum(c.realizedPnl), 0) / wins.length : 0
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, c) => a + finiteNum(c.realizedPnl), 0) / losses.length) : 0
  const rate = n ? win / n : null
  // 盈亏比 = 平均盈利 / 平均亏损；期望值 = 胜率×平均盈利 − 败率×平均亏损
  const plRatio = avgLoss > 0 ? avgWin / avgLoss : null
  const expect = rate != null ? (rate * avgWin - (1 - rate) * avgLoss) : null
  return { n, rate: rate != null ? Math.round(rate * 100) : null, net, avgWin, avgLoss, plRatio, expect }
}

// 导出交易记录为 CSV（Excel 可直接打开）
function exportCsv(records) {
  const head = ['日期时间', '类型', '代码', '名称', '手数', '买入价', '卖出价', '成交额', '手续费', '已实现盈亏']
  const typeLabel = (c) => tradeIntentLabel(c)
  const rows = records.filter((c) => !c.live).map((c) => {
    const ts = c.at || c.sellAt || c.buyAt
    return [
      new Date(ts).toLocaleString('zh-CN'),
      typeLabel(c), c.code, c.name, c.qty ?? '',
      c.buyPrice ?? c.price ?? '', c.sellPrice ?? (c.type === 'SELL' ? c.price : '') ?? '',
      amountOf(c).toFixed(2),
      feeOf(c).toFixed(2),
      c.realizedPnl != null ? finiteNum(c.realizedPnl).toFixed(2) : '',
    ]
  })
  const csv = [head, ...rows].map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `交易记录_${dayKey(Date.now())}.csv`
  a.click(); URL.revokeObjectURL(url)
}
function TradeStat({ records, analyticsRecords }) {
  const buys = analyticsRecords.filter((c) => typeKey(c) === 'BUY')
  const sells = analyticsRecords.filter((c) =>
    typeKey(c) === 'SELL' || typeKey(c) === 'CLOSE'
  )
  const ts = analyticsRecords.filter((c) => typeKey(c) === 'T')
  const sStat = statOf(sells)
  const tStat = statOf(ts)
  const totalNet = sStat.net + tStat.net // 已实现净收益(买入不计盈亏)
  const totalFee = records.reduce((a, c) => a + feeOf(c), 0)
  // 累计花费(买入成交额+买费) / 累计回收(卖出成交额−卖费)
  const buyAmt = buys.reduce((a, c) => a + amountOf(c) + finiteNum(c.fee ?? c.buyFee), 0)
  const sellAmt = sells.reduce((a, c) => a + amountOf(c) - finiteNum(c.fee ?? c.sellFee), 0)
  const empty = records.length === 0
  const netCls = totalNet > 0 ? 'red' : totalNet < 0 ? 'green' : ''

  return (
    <div className="panel">
      <div className="panel-head"><div role="heading" aria-level="2" className="panel-title"><Icon name="gauge" size={16} /> 交易复盘</div>
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
      .map((c) => ({
        ...c,
        realizedPnl: finiteNum(c.realizedPnl),
        ts: c.at || c.sellAt || c.buyAt || 0,
      }))
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
      map.set(k, (map.get(k) || 0) + finiteNum(c.realizedPnl))
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
      map.get(c.code).pnl += finiteNum(c.realizedPnl)
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
        <div className="panel-head"><div role="heading" aria-level="2" className="panel-title"><Icon name="chart" size={16} /> 复盘图表</div></div>
        <div className="empty">有已兑现的卖出/做T记录后，这里会用图表展示资金曲线、每日盈亏与个股盈亏排行。</div>
      </div>
    )
  }
  const stockCount = new Set(closed.map((c) => c.code)).size
  return (
    <div className="panel">
      <div className="panel-head"><div role="heading" aria-level="2" className="panel-title"><Icon name="chart" size={16} /> 复盘图表</div>
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
