import { useState, useRef } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import ConfirmDialog from './ConfirmDialog'
import { usePolling } from '../hooks'
import { callAI } from '../ai'
import { planStore, usePlanStore, calcBuyFee, calcSellFee, computeTFlows } from '../planStore'
import { aiStore } from '../aiStore'
import { fmtPct, pctClass, fmtNum, fmtInflow } from '../format'

// 金额格式化（元 → 带符号，万以上转万）
function fmtMoney(v) {
  const sign = v >= 0 ? '+' : '-'
  const a = Math.abs(v)
  if (a >= 10000) return sign + (a / 10000).toFixed(2) + '万'
  return sign + a.toFixed(0)
}

// 时间戳 → 天key(YYYY-MM-DD) / 展示标签(今天/昨天/MM-DD)
function dayKeyOf(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dayLabelOf(key) {
  const today = dayKeyOf(Date.now())
  const ykey = dayKeyOf(Date.now() - 86400000)
  if (key === today) return '今天'
  if (key === ykey) return '昨天'
  return key.slice(5) // MM-DD
}
// 把做T流水按天分组，按天净收益(FIFO配对)与笔数汇总，新到旧
function groupTFlowsByDay(flows) {
  const groups = {}
  for (const f of (flows || [])) {
    const k = dayKeyOf(f.at)
    if (!groups[k]) groups[k] = []
    groups[k].push(f)
  }
  return Object.keys(groups)
    .sort((a, b) => (a < b ? 1 : -1))
    .map((key) => {
      const dayFlows = groups[key].slice().sort((a, b) => b.at - a.at)
      const { realized } = computeTFlows(dayFlows)
      // 分批买卖的含费均价：买入均价=(买入额+买费)/买入股数；卖出均价=(卖出额-卖费)/卖出股数
      let buyQty = 0, buyAmt = 0, buyFee = 0, sellQty = 0, sellAmt = 0, sellFee = 0
      for (const f of dayFlows) {
        const amt = f.price * f.qty * 100
        if (f.side === 'buy') { buyQty += f.qty; buyAmt += amt; buyFee += f.fee || 0 }
        else { sellQty += f.qty; sellAmt += amt; sellFee += f.fee || 0 }
      }
      const buyAvg = buyQty ? (buyAmt + buyFee) / (buyQty * 100) : null   // 实际买入成本均价
      const sellAvg = sellQty ? (sellAmt - sellFee) / (sellQty * 100) : null // 实际卖出所得均价
      return {
        key, label: dayLabelOf(key), flows: dayFlows, realized, count: dayFlows.length,
        buyQty, sellQty, buyAvg, sellAvg, totalFee: +(buyFee + sellFee).toFixed(2),
      }
    })
}

// ============ 我的计划 Tab：交易闭环（候选→买入→持仓→卖出） ============
export default function PlanTab({ interval }) {
  const book = usePlanStore()
  const codes = [...new Set([...book.plan.map((x) => x.code), ...book.holding.map((x) => x.code)])]
  const { data } = usePolling(
    codes.length ? `/api/quote?codes=${codes.join(',')}` : null,
    interval,
    [codes.join(',')]
  )
  const quote = {}
  ;(data?.list || []).forEach((s) => { quote[s.code] = s })

  return (
    <div className="plan">
      <HoldingList book={book} quote={quote} />
      <PlanList book={book} quote={quote} />
    </div>
  )
}

// ---------- 股票搜索框（自己搜、加入计划） ----------
function StockSearch() {
  const [kw, setKw] = useState('')
  const [list, setList] = useState([])
  const [open, setOpen] = useState(false)
  const timer = useRef(null)

  const onChange = (v) => {
    setKw(v); setOpen(true)
    if (timer.current) clearTimeout(timer.current)
    if (!v.trim()) { setList([]); return }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch('/api/search?kw=' + encodeURIComponent(v.trim())).then((x) => x.json())
        setList(r.list || [])
      } catch { setList([]) }
    }, 250)
  }
  const pick = (s) => {
    planStore.addPlan({ code: s.code, name: s.name })
    setKw(''); setList([]); setOpen(false)
  }

  return (
    <div className="stock-search">
      <div className="ss-input">
        <Icon name="search" size={15} />
        <input
          value={kw} onChange={(e) => onChange(e.target.value)}
          onFocus={() => kw && setOpen(true)}
          placeholder="搜索股票名称 / 代码，加入计划…"
        />
      </div>
      {open && list.length > 0 && (
        <div className="ss-dropdown">
          {list.map((s) => {
            const added = planStore.has(s.code)
            const held = (planStore.get().holding || []).some((x) => x.code === s.code)
            return (
              <div className="ss-item" key={s.code} onClick={() => !added && !held && pick(s)}>
                <span className="ss-name">{s.name}<span className="sub-name">{s.code}</span></span>
                <span className="ss-type">{s.type}</span>
                <span className={'ss-add' + ((added || held) ? ' done' : '')}><Icon name={(added || held) ? 'check' : 'plus'} size={13} />{held ? '已持有' : added ? '已加' : '加入'}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------- 自选 / 候选（合并自选监控 + 计划买入）----------
function PlanList({ book, quote }) {
  const [buying, setBuying] = useState(null) // code
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('1')
  const [delTarget, setDelTarget] = useState(null) // 待删除的候选 {code,name}

  const startBuy = (s) => { setBuying(s.code); setPrice(quote[s.code] ? String(quote[s.code].price) : ''); setQty('1') }
  const confirmBuy = (code) => { if (price && Number(qty) > 0) { planStore.buy(code, price, Number(qty)); setBuying(null); setPrice(''); setQty('1') } }

  return (
    <div className="panel">
      <div className="panel-head plan-head">
        <div className="panel-title"><Icon name="eye" size={16} /> 自选 / 候选 <span className="sub-name">{book.plan.length} 只 · 盯盘资金 + 记录买入即转持仓</span></div>
        <div className="plan-search"><StockSearch /></div>
      </div>
      {book.plan.length === 0 ? (
        <div className="empty small">搜索股票加入自选，或在「今日选股」点「加自选」。这里实时盯盘资金/量比，想买入时记录买入价+手数即转为持仓。</div>
      ) : (
        <div className="plan-cand-grid">
          {book.plan.map((p) => {
            const q = quote[p.code]
            return (
              <div className="plan-cand" key={p.code}>
                <div className="pc-top">
                  <div className="pc-name">
                    <StockName code={p.code} name={(q && q.name) || p.name}><span>{(q && q.name) || p.name}<span className="sub-name">{p.code}</span></span></StockName>
                    {q && q.isLimitUp && <span className="tag tag-lu">涨停</span>}
                  </div>
                  {q && <span className={'pc-price ' + pctClass(q.pct)}>{fmtNum(q.price)} {fmtPct(q.pct)}</span>}
                </div>
                {/* 盯盘监控指标（原自选股监控能力）*/}
                {q && (
                  <div className="pc-metrics">
                    <span>换手 <b className={q.turnover > 10 ? 'gold' : ''}>{fmtNum(q.turnover, 1)}%</b></span>
                    <span>量比 <b className={q.volRatio > 2 ? 'gold' : ''}>{fmtNum(q.volRatio, 1)}</b></span>
                    <span>主力 <b className={pctClass(q.mainInflow)}>{fmtInflow(q.mainInflow)}</b></span>
                  </div>
                )}
                {buying === p.code ? (
                  <div className="buy-inline">
                    <input className="wl-input" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="买入价" />
                    <input className="wl-input" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="手" />
                    {price && Number(qty) > 0 && <span className="fee-hint">费≈{calcBuyFee(Number(price) * Number(qty) * 100).toFixed(0)}</span>}
                    <button className="chip-btn done" onClick={() => confirmBuy(p.code)}><Icon name="check" size={12} />确认</button>
                    <button className="chip-btn ghost" onClick={() => setBuying(null)}>取消</button>
                  </div>
                ) : (
                  <div className="pc-actions">
                    <button className="chip-btn buy" onClick={() => startBuy(p)}><Icon name="cart" size={12} />建仓</button>
                    <button className="icon-btn" onClick={() => setDelTarget(p)}><Icon name="trash" size={13} /></button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {delTarget && (
        <ConfirmDialog
          title="从自选中删除？"
          body={<>确定把 <b>{delTarget.name}</b>（{delTarget.code}）从自选 / 候选中移除？此操作不影响你已有的持仓和交易记录。</>}
          confirmText="删除"
          onConfirm={() => { planStore.removePlan(delTarget.code); setDelTarget(null) }}
          onCancel={() => setDelTarget(null)}
        />
      )}
    </div>
  )
}
// ---------- 当前持仓 ----------
function HoldingList({ book, quote }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="wallet" size={16} /> 当前持仓 <span className="sub-name">{book.holding.length} 只 · 支持做T</span></div>
      </div>
      {book.holding.length === 0 ? (
        <div className="empty">在下方「自选 / 候选」里点「建仓」后，持仓出现在这里。做T：在每笔持仓上高抛低吸、摊薄成本。</div>
      ) : (
        <div className="hold-grid">
          {book.holding.map((h, idx) => (
            <HoldingItem key={h.id} h={h} idx={idx} quote={quote[h.code]} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- 单笔持仓 ----------
function HoldingItem({ h, idx, quote: q }) {
  const [mode, setMode] = useState(null) // null | 'sell' | 'T' | 'add'
  const [sellPrice, setSellPrice] = useState('')
  const [sellQty, setSellQty] = useState('1')
  const [addPrice, setAddPrice] = useState('')
  const [addQty, setAddQty] = useState('1')
  const [confirmDel, setConfirmDel] = useState(false) // 删除持仓二次确认

  // 做T输入（流水式：直接记一腿买或卖）
  const [tSide, setTSide] = useState('buy') // buy 低吸/买回 | sell 高抛/卖出
  const [tPrice, setTPrice] = useState('')
  const [tQty, setTQty] = useState('1')
  const [tAdvice, setTAdvice] = useState(null) // {loading,result,error} AI做T参考
  const [tStyle, setTStyle] = useState('balanced') // conservative | balanced | aggressive
  const [openDays, setOpenDays] = useState({}) // 做T流水按天折叠，key→是否展开

  const baseQty = h.baseQty || h.qty
  const tStat = computeTFlows(h.tFlows)
  const effCost = tStat.realized ? +(h.buyPrice - tStat.realized / (baseQty * 100)).toFixed(3) : h.buyPrice
  const pnl = q && h.buyPrice ? ((q.price - h.buyPrice) / h.buyPrice) * 100 : null

  const startSell = () => { setMode('sell'); setSellPrice(q ? String(q.price) : ''); setSellQty(String(h.qty || 1)) }
  const confirmSell = () => { if (sellPrice && Number(sellQty) > 0) { planStore.sell(h.id, sellPrice, Number(sellQty)); setMode(null) } }

  const startAdd = () => { setMode('add'); setAddPrice(q ? String(q.price) : ''); setAddQty('1') }
  const confirmAdd = () => { if (addPrice && Number(addQty) > 0) { planStore.addToHolding(h.id, addPrice, Number(addQty)); setMode(null) } }

  const startT = () => { setMode('T'); setTPrice(q ? String(q.price) : ''); setTQty('1'); setTAdvice(null) }
  const addTFlow = () => { if (tPrice && Number(tQty) > 0) { planStore.addTFlow(h.id, tSide, tPrice, Number(tQty)); setTPrice(q ? String(q.price) : ''); setTQty('1') } }

  // AI 做T参考（可指定风格，切风格即用新风格重新生成）
  const askTAdvice = async (styleOverride) => {
    const useStyle = styleOverride || tStyle
    if (styleOverride && styleOverride !== tStyle) setTStyle(styleOverride)
    setTAdvice({ loading: true })
    try {
      const r = await callAI('t_advice', {
        name: h.name, code: h.code,
        nowPrice: q?.price, pct: q?.pct,
        dayHigh: q?.high, dayLow: q?.low, open: q?.open, prevClose: q?.prevClose,
        turnover: q?.turnover, volRatio: q?.volRatio,
        mainInflowYi: q ? +(q.mainInflow / 1e8).toFixed(2) : null,
        holdCost: h.buyPrice, holdQty: h.qty, baseQty,
        style: useStyle,
      })
      if (r.ok) {
        setTAdvice({ result: r.result })
        // 建议方向自动切到对应买/卖
        if (r.result.dir === 'positive') setTSide('buy')
        else if (r.result.dir === 'reverse') setTSide('sell')
      } else setTAdvice({ error: r.error || 'AI 调用失败' })
    } catch (e) { setTAdvice({ error: String(e.message || e) }) }
  }
  // 采纳建议：填入第一腿方向/价位/手数
  const adoptAdvice = () => {
    const r = tAdvice && tAdvice.result
    if (!r) return
    if (r.dir === 'positive') setTSide('buy')
    else if (r.dir === 'reverse') setTSide('sell')
    if (r.leg1Price) setTPrice(String(r.leg1Price))
    if (r.suggestQty) setTQty(String(r.suggestQty))
  }

  const flowDays = groupTFlowsByDay(h.tFlows)
  return (
    <div className="hold-item">
      <div className="pi-main">
        <div className="pi-name">
          <StockName code={h.code} name={h.name}><span>{h.name}<span className="sub-name">{h.code}</span></span></StockName>
          <span className="sub-name" style={{ marginLeft: 6 }}>#{idx + 1}</span>
        </div>
        {pnl != null && <div className={'pi-pnl ' + (pnl >= 0 ? 'red' : 'green')}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%</div>}
      </div>

      <div className="hold-meta">
        <span>{h.qty}手</span>
        <span>成本 {fmtNum(h.buyPrice)}</span>
        {q && <span>现价 <b className={pctClass(q.pct)}>{fmtNum(q.price)}</b></span>}
        {q && h.buyPrice && <span>浮盈 <b className={pnl >= 0 ? 'red' : 'green'}>{fmtMoney((q.price - h.buyPrice) * h.qty * 100)}</b></span>}
      </div>

      {/* 做T战绩（流水式）*/}
      {(h.tFlows && h.tFlows.length > 0) && (
        <div className="t-stat">
          <span className="t-badge"><Icon name="refresh" size={12} />做T {h.tFlows.length}笔</span>
          <span>已实现 <b className={tStat.realized >= 0 ? 'red' : 'green'}>{fmtMoney(tStat.realized)}</b></span>
          {tStat.realized !== 0 && <span>实际成本 <b className="red">{fmtNum(effCost)}</b> <span className="t-down">↓{fmtNum(h.buyPrice - effCost)}</span></span>}
          {(tStat.openBuy > 0 || tStat.openSell > 0) && (
            <span className="t-open">未平：{tStat.openBuy > 0 ? `多 ${tStat.openBuy}手` : ''}{tStat.openSell > 0 ? `空 ${tStat.openSell}手` : ''}</span>
          )}
        </div>
      )}

      {/* 操作区 */}
      {mode === 'add' ? (
        <div className="buy-inline">
          <input className="wl-input" value={addPrice} onChange={(e) => setAddPrice(e.target.value)} placeholder="加仓价" />
          <input className="wl-input" value={addQty} onChange={(e) => setAddQty(e.target.value)} placeholder="手" />
          {addPrice && Number(addQty) > 0 && <span className="fee-hint">费≈{calcBuyFee(Number(addPrice) * Number(addQty) * 100).toFixed(2)}</span>}
          <button className="chip-btn buy" onClick={confirmAdd}><Icon name="check" size={13} />确认加仓</button>
          <button className="chip-btn ghost" onClick={() => setMode(null)}>取消</button>
        </div>
      ) : mode === 'sell' ? (
        <div className="buy-inline">
          <input className="wl-input" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} placeholder="卖出价" />
          <input className="wl-input" value={sellQty} onChange={(e) => setSellQty(e.target.value)} placeholder="手" />
          <span className="qty-hint">/{h.qty}手</span>
          {sellPrice && Number(sellQty) > 0 && <span className="fee-hint">费≈{calcSellFee(Number(sellPrice) * Number(sellQty) * 100).toFixed(2)}</span>}
          <button className="chip-btn done" onClick={confirmSell}><Icon name="check" size={13} />{Number(sellQty) >= h.qty ? '确认清仓' : '确认减仓'}</button>
          <button className="chip-btn ghost" onClick={() => setMode(null)}>取消</button>
        </div>
      ) : (
        <div className="pi-actions">
          <button className="chip-btn buy" onClick={startAdd}><Icon name="cart" size={13} />加仓</button>
          <button className="chip-btn buy" onClick={startT}><Icon name="refresh" size={13} />做T</button>
          <button className="chip-btn sell" onClick={startSell}><Icon name="sell" size={13} />减仓/清仓</button>
          <button className="icon-btn" onClick={() => setConfirmDel(true)}><Icon name="trash" size={14} /></button>
        </div>
      )}

      {confirmDel && (
        <ConfirmDialog
          title="删除此持仓？"
          body={<>确定删除持仓 <b>{h.name}</b>（{h.code}，{h.qty}手）？该持仓上已配对的做T收益会归档进交易记录，不会丢失；但这笔持仓本身将从列表移除。</>}
          confirmText="删除持仓"
          onConfirm={() => { planStore.removeHolding(h.id); setConfirmDel(false) }}
          onCancel={() => setConfirmDel(false)}
        />
      )}

      {/* 做T：独立抽屉弹窗（信息量大，不在行内展开，避免撑大表格/内容溢出）*/}
      {mode === 'T' && (
        <div className="modal-mask mask-drawer" onClick={() => setMode(null)}>
          <div className="t-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="t-drawer-head">
              <div className="modal-title"><Icon name="refresh" size={16} /> 做T · {h.name}<span className="detail-code">{h.code}</span></div>
              <div className="modal-close" onClick={() => setMode(null)}><Icon name="close" size={16} /></div>
            </div>
            <div className="t-drawer-body">
              {/* 持仓概览 */}
              <div className="t-drawer-meta">
                <span>{h.qty}手</span><span>成本 {fmtNum(h.buyPrice)}</span>
                {q && <span>现价 <b className={pctClass(q.pct)}>{fmtNum(q.price)}</b></span>}
                {tStat.realized !== 0 && <span>做T已实现 <b className={tStat.realized >= 0 ? 'red' : 'green'}>{fmtMoney(tStat.realized)}</b></span>}
              </div>
        <div className="t-panel">
          {/* AI 做T参考 */}
          <div className="t-ai">
            {/* 风格选择 */}
            <div className="t-style">
              <span className="t-style-label">风格</span>
              {[['conservative', '稳健'], ['balanced', '均衡'], ['aggressive', '激进']].map(([k, label]) => (
                <button key={k} className={'t-style-btn' + (tStyle === k ? ' active ' + k : '')} onClick={() => askTAdvice(k)}>{label}</button>
              ))}
            </div>
            {!tAdvice && (
              <button className="t-ai-btn" onClick={() => askTAdvice()}><Icon name="spark" size={14} />获取 AI 做T参考（{tStyle === 'conservative' ? '稳健' : tStyle === 'aggressive' ? '激进' : '均衡'}）</button>
            )}
            {tAdvice && tAdvice.loading && <div className="t-ai-loading"><Icon name="refresh" size={13} className="spin" />AI 正在分析分时/大盘/资金/走势…</div>}
            {tAdvice && tAdvice.error && <div className="err">{tAdvice.error} <span className="expand-btn" onClick={askTAdvice}>重试</span></div>}
            {tAdvice && tAdvice.result && (
              <div className={'t-ai-card ' + (tAdvice.result.light || 'yellow')}>
                <div className="t-ai-head">
                  <span className="t-ai-badge">{tAdvice.result.dirLabel || tAdvice.result.advisable}</span>
                  {tAdvice.result.confidence && <span className="t-conf">信心 {tAdvice.result.confidence}</span>}
                  <div className="t-ai-actions" style={{ marginLeft: 'auto' }}>
                    <span className="expand-btn" onClick={() => askTAdvice()}>重新生成</span>
                    <span className="expand-btn" onClick={() => setTAdvice(null)}>收起</span>
                  </div>
                </div>
                {tAdvice.result.plain && <div className="t-ai-plain">{tAdvice.result.plain}</div>}
                <div className="t-ai-basis">
                  {tAdvice.result.marketNote && <div className="t-basis-row"><span className="t-basis-k">大盘</span>{tAdvice.result.marketNote}</div>}
                  {tAdvice.result.stockNote && <div className="t-basis-row"><span className="t-basis-k">盘面</span>{tAdvice.result.stockNote}</div>}
                  {(tAdvice.result.support || tAdvice.result.resistance) && (
                    <div className="t-basis-row"><span className="t-basis-k">支撑压力</span>支撑 <b className="green">{tAdvice.result.support ?? '--'}</b> · 压力 <b className="red">{tAdvice.result.resistance ?? '--'}</b></div>
                  )}
                  {tAdvice.result.theory && <div className="t-basis-row"><span className="t-basis-k theory">理论</span>{tAdvice.result.theory}</div>}
                </div>
                {tAdvice.result.dir !== 'none' && (
                  <div className="t-ai-grid">
                    <div><span className="k">建议手数</span><b>{tAdvice.result.suggestQty} 手</b></div>
                    <div><span className="k">{tAdvice.result.dir === 'positive' ? '低吸参考' : '高抛参考'}</span><b>{tAdvice.result.leg1Price ?? '--'}</b></div>
                    <div><span className="k">{tAdvice.result.dir === 'positive' ? '高抛目标' : '接回目标'}</span><b>{tAdvice.result.leg2Price ?? '--'}</b></div>
                    <div><span className="k">预估收益</span><b className="red">{tAdvice.result.estProfit}</b></div>
                    <div><span className="k">成本可降</span><b className="green">{tAdvice.result.estCostDown}</b></div>
                  </div>
                )}
                {tAdvice.result.addOn && <div className="t-ai-addon"><Icon name="bolt" size={12} />加码：{tAdvice.result.addOn}</div>}
                {tAdvice.result.risk && <div className="t-ai-risk"><Icon name="shield" size={12} />{tAdvice.result.risk}</div>}
                {tAdvice.result.dir !== 'none' && (
                  <button className="chip-btn done" style={{ marginTop: 8 }} onClick={adoptAdvice}><Icon name="check" size={13} />采纳建议价位</button>
                )}
              </div>
            )}
          </div>

          {/* 记一腿：买 or 卖，随便记几笔 */}
          <div className="t-tabs">
            <button className={'t-tab' + (tSide === 'buy' ? ' active' : '')} onClick={() => setTSide('buy')}>买入（低吸/买回）</button>
            <button className={'t-tab' + (tSide === 'sell' ? ' active' : '')} onClick={() => setTSide('sell')}>卖出（高抛/减T）</button>
          </div>
          <div className="t-hint">做T不改底仓：每次高抛或低吸都记一笔，系统按时间自动配对算差价收益。一买多卖、多买一卖都行。</div>
          <div className="buy-inline">
            <input className="wl-input" style={{ width: 80 }} value={tPrice} onChange={(e) => setTPrice(e.target.value)} placeholder={tSide === 'buy' ? '买入价' : '卖出价'} />
            <input className="wl-input" style={{ width: 60 }} value={tQty} onChange={(e) => setTQty(e.target.value)} placeholder="手" />
            <span className="qty-hint">手</span>
            {tPrice && Number(tQty) > 0 && (
              <span className="fee-hint">费≈{(tSide === 'buy' ? calcBuyFee : calcSellFee)(Number(tPrice) * Number(tQty) * 100).toFixed(2)}</span>
            )}
            <button className={'chip-btn ' + (tSide === 'buy' ? 'buy' : 'sell')} onClick={addTFlow}><Icon name="check" size={13} />记一笔{tSide === 'buy' ? '买' : '卖'}</button>
            <button className="chip-btn ghost" onClick={() => setMode(null)}>收起</button>
          </div>

          {/* 做T流水明细（按天分组，当天默认展开，历史天折叠可展开）*/}
          {flowDays.length > 0 && (
            <div className="t-flow-days">
              {flowDays.map((d, di) => {
                const expanded = openDays[d.key] ?? (di === 0) // 最新一天默认展开
                return (
                  <div className="t-day" key={d.key}>
                    <div className="t-day-head" onClick={() => setOpenDays((s) => ({ ...s, [d.key]: !expanded }))}>
                      <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
                      <span className="t-day-label">{d.label}</span>
                      <span className="t-day-count">{d.count}笔</span>
                      <span className={'t-day-net ' + (d.realized >= 0 ? 'red' : 'green')}>{fmtMoney(d.realized)}</span>
                    </div>
                    {expanded && (
                      <>
                        {(d.buyAvg != null || d.sellAvg != null) && (
                          <div className="t-day-avg">
                            {d.buyAvg != null && (
                              <span className="t-avg-item"><span className="t-avg-k buy">买入均价</span><b>{fmtNum(d.buyAvg)}</b><span className="t-avg-q">{d.buyQty}手</span></span>
                            )}
                            {d.sellAvg != null && (
                              <span className="t-avg-item"><span className="t-avg-k sell">卖出均价</span><b>{fmtNum(d.sellAvg)}</b><span className="t-avg-q">{d.sellQty}手</span></span>
                            )}
                            <span className="t-avg-fee">费{d.totalFee.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="t-flow-list">
                          {d.flows.map((f) => (
                            <div className="t-flow-row" key={f.id}>
                              <span className={'t-flow-side ' + f.side}>{f.side === 'buy' ? '买' : '卖'}</span>
                              <span className="t-flow-p">{fmtNum(f.price)} × {f.qty}手</span>
                              <span className="t-flow-fee">费{f.fee.toFixed(2)}</span>
                              <span className="t-flow-time">{new Date(f.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                              <span className="del" onClick={() => planStore.removeTFlow(h.id, f.id)}>×</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 预估本次做T净收益（第二腿输入时）
function estT(pending, price2) {
  const { dir, leg1Price, qty } = pending
  const shares = qty * 100
  const p2 = Number(price2)
  const buyP = dir === 'positive' ? leg1Price : p2
  const sellP = dir === 'positive' ? p2 : leg1Price
  const gross = (sellP - buyP) * shares
  const buyFee = Math.max(buyP * shares * 0.0003, 5) + buyP * shares * 0.00001
  const sellFee = Math.max(sellP * shares * 0.0003, 5) + sellP * shares * 0.0005 + sellP * shares * 0.00001
  return +(gross - buyFee - sellFee).toFixed(2)
}
void estT
