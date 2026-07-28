import { useState, useRef } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import ConfirmDialog from './ConfirmDialog'
import { AlertForm } from './AlertCenter'
import { usePolling } from '../hooks'
import { callAI } from '../ai'
import { planStore, usePlanStore, calcBuyFee, calcSellFee, computeTFlows } from '../planStore'
import { aiStore } from '../aiStore'
import { fmtPct, pctClass, fmtNum, fmtInflow , fmtRaw } from '../format'

// 金额格式化（元 → 带符号，万以上转万）
function fmtMoney(v) {
  const sign = v >= 0 ? '+' : '-'
  const a = Math.abs(v)
  if (a >= 10000) return sign + (a / 10000).toFixed(2) + '万'
  return sign + a.toFixed(0)
}

// 从日K算 N 日均线（收盘价），取最后一根为当日
function maOf(candles, n) {
  if (!candles || candles.length < n) return null
  let sum = 0
  for (let i = candles.length - n; i < candles.length; i++) sum += candles[i].close
  return +(sum / n).toFixed(3)
}

// ========== 「踏5不破10」策略信号引擎 ==========
// 依据用户交易法：现价 vs MA5/MA10 + 量能 + 盈亏，输出信号灯 + 操作建议
// 返回 { level, tag, action, reasons[], ma5, ma10 }
//   level: hold(持有) | dip(低吸) | reduce(减仓) | clear(清仓) | stop(止损) | na(数据不足)
function tap5break10({ price, prevClose, volRatio, candles, cost, pnlPct }) {
  const ma5 = maOf(candles, 5)
  const ma10 = maOf(candles, 10)
  if (ma5 == null || ma10 == null || !price) {
    return { level: 'na', tag: '数据加载中', action: '正在获取日K均线…', reasons: [], ma5, ma10 }
  }
  const reasons = []
  const above5 = price >= ma5
  const above10 = price >= ma10
  const dist5 = +((price - ma5) / ma5 * 100).toFixed(2)   // 距MA5 %
  const dist10 = +((price - ma10) / ma10 * 100).toFixed(2) // 距MA10 %
  const bigVol = volRatio != null && volRatio >= 1.5       // 放量
  const dayPct = prevClose ? +((price - prevClose) / prevClose * 100).toFixed(2) : null

  // ① 止损优先：单票亏损超 8% → 强制止损（交易纪律2）
  if (pnlPct != null && pnlPct <= -8) {
    reasons.push(`浮亏 ${pnlPct}%，已破 8% 止损纪律`)
    return { level: 'stop', tag: '止损', action: '按纪律止损离场，短线单票亏损不宜超 8%', reasons, ma5, ma10 }
  }

  // ② 放量跌破10日线 → 清仓信号（卖点2）
  if (!above10 && bigVol) {
    reasons.push(`放量(量比${volRatio})跌破10日线 ${Math.abs(dist10)}%`)
    return { level: 'clear', tag: '清仓', action: '放量破10日线，趋势走坏，清仓信号', reasons, ma5, ma10 }
  }
  // ③ 跌破10日线(未放量) → 清仓/减仓预警
  if (!above10) {
    reasons.push(`已跌破10日线 ${Math.abs(dist10)}%（生命线失守）`)
    return { level: 'clear', tag: '破10清仓', action: '跌破10日线，减至清仓；若尾盘收回可留观察', reasons, ma5, ma10 }
  }
  // ④ 收盘价跌破5日线(仍在10上方) → 减仓信号（卖点1）
  if (!above5) {
    reasons.push(`跌破5日线 ${Math.abs(dist5)}%，但仍守住10日线`)
    return { level: 'reduce', tag: '减仓', action: '跌破5日线先减仓，跌破10日线再清仓', reasons, ma5, ma10 }
  }
  // ⑤ 站上5日线：健康持有区。细分低吸/持有
  //   缩量回踩5日线不破(距5线很近且缩量) → 低吸点（买点2）
  if (above5 && dist5 <= 1.5 && (volRatio == null || volRatio < 1)) {
    reasons.push(`缩量回踩5日线不破（距${dist5}%）`)
    return { level: 'dip', tag: '低吸', action: '缩量回踩5日线不破，可低吸/加仓', reasons, ma5, ma10 }
  }
  //   放量突破且大幅冲高 → 止盈提示（交易纪律1）
  if (bigVol && dayPct != null && dayPct >= 5) {
    reasons.push(`放量大幅冲高 +${dayPct}%（未封板）`)
    return { level: 'reduce', tag: '可落袋', action: '低吸后次日大幅冲高不封板，可做T落袋一部分', reasons, ma5, ma10 }
  }
  // 默认：站稳5日线之上，持有
  reasons.push(`站稳5日线上方 ${dist5}%，10日线上方 ${dist10}%`)
  return { level: 'hold', tag: '持有', action: '踏5不破10，趋势健康，持有为主', reasons, ma5, ma10 }
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
  const [alerting, setAlerting] = useState(null) // 正在设预警的 code

  const startBuy = (s) => { setBuying(s.code); setPrice(quote[s.code] ? String(quote[s.code].price) : ''); setQty('1') }
  const confirmBuy = (code) => { if (price && Number(qty) > 0) { planStore.buy(code, price, Number(qty)); setBuying(null); setPrice(''); setQty('1') } }

  // 单张候选卡
  const Card = (p) => {
    const q = quote[p.code]
    return (
      <div className={'plan-cand' + (p.star ? ' starred' : '')} key={p.code}>
        <div className="pc-top">
          <button className={'star-btn' + (p.star ? ' on' : '')} title={p.star ? '取消重点关注' : '标记重点关注'} onClick={() => planStore.toggleStar(p.code)}>
            <Icon name={p.star ? 'starFill' : 'star'} size={15} />
          </button>
          <div className="pc-name">
            <StockName code={p.code} name={(q && q.name) || p.name}><span className="pc-nm">{(q && q.name) || p.name}</span></StockName>
            <span className="pc-code">{p.code}</span>
            {q && q.isLimitUp && <span className="tag tag-lu">涨停</span>}
          </div>
          {q && <span className={'pc-price ' + pctClass(q.pct)}>{fmtRaw(q.price)} <span className="pc-pct">{fmtPct(q.pct)}</span></span>}
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
        ) : alerting === p.code ? (
          <div className="pc-alert-box">
            <AlertForm stock={{ code: p.code, name: (q && q.name) || p.name }} onDone={() => setAlerting(null)} />
            <button className="chip-btn ghost" style={{ marginTop: 6 }} onClick={() => setAlerting(null)}>收起</button>
          </div>
        ) : (
          <div className="pc-actions">
            <button className="chip-btn buy" onClick={() => startBuy(p)}><Icon name="cart" size={12} />建仓</button>
            <button className="chip-btn ghost" onClick={() => setAlerting(p.code)}><Icon name="bell" size={12} />预警</button>
            <button className="icon-btn" onClick={() => setDelTarget(p)}><Icon name="trash" size={13} /></button>
          </div>
        )}
      </div>
    )
  }

  const starred = book.plan.filter((p) => p.star)
  const others = book.plan.filter((p) => !p.star)

  return (
    <div className="panel">
      <div className="panel-head plan-head">
        <div className="panel-title"><Icon name="eye" size={16} /> 自选 / 候选 <span className="sub-name">{book.plan.length} 只 · 点 ☆ 标记重点关注</span></div>
        <div className="plan-search"><StockSearch /></div>
      </div>
      {book.plan.length === 0 ? (
        <div className="empty small">搜索股票加入自选，或在「今日选股」点「加自选」。这里实时盯盘资金/量比；点每张卡左上的星标可置顶重点关注。</div>
      ) : (
        <>
          {starred.length > 0 && (
            <div className="star-zone">
              <div className="star-zone-head"><Icon name="starFill" size={13} /> 重点关注 <span className="sub-name">{starred.length} 只</span></div>
              <div className="plan-cand-grid">{starred.map(Card)}</div>
            </div>
          )}
          {others.length > 0 && (
            <>
              {starred.length > 0 && <div className="star-zone-divider">其他自选 · {others.length} 只</div>}
              <div className="plan-cand-grid">{others.map(Card)}</div>
            </>
          )}
        </>
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
  const [confirmSettle, setConfirmSettle] = useState(false) // 手动结算做T二次确认

  // 做T输入（流水式：直接记一腿买或卖）
  const [tSide, setTSide] = useState('buy') // buy 低吸/买回 | sell 高抛/卖出
  const [tPrice, setTPrice] = useState('')
  const [tQty, setTQty] = useState('1')
  const [tAdvice, setTAdvice] = useState(null) // {loading,result,error} AI做T参考
  const [tStyle, setTStyle] = useState('balanced') // conservative | balanced | aggressive
  const [openDays, setOpenDays] = useState({}) // 做T流水按天折叠，key→是否展开

  const baseQty = h.baseQty || h.qty
  const tStat = computeTFlows(h.tFlows)
  // 含费成本价：把买入手续费摊进每股成本，才是真实持仓成本
  const shares = (h.qty || 0) * 100
  const costWithFee = shares ? +(((h.buyPrice * shares) + (h.buyFee || 0)) / shares).toFixed(3) : h.buyPrice
  const effCost = tStat.realized ? +(costWithFee - tStat.realized / (baseQty * 100)).toFixed(3) : costWithFee
  // 浮盈(净)：现价市值 − 裸成本市值 − 已付买入手续费
  const floatPnl = q && h.buyPrice ? (q.price - h.buyPrice) * shares - (h.buyFee || 0) : null
  const pnl = q && costWithFee ? ((q.price - costWithFee) / costWithFee) * 100 : null

  // 「踏5不破10」策略信号：拉该股日K算 MA5/MA10 → 出信号灯
  const [showStrat, setShowStrat] = useState(false) // 展开信号依据
  const kd = usePolling(`/api/stock_detail?code=${h.code}&klt=101&lmt=30`, 600000, [h.code])
  const candles = (kd.data && kd.data.candles) || []
  const signal = q ? tap5break10({
    price: q.price, prevClose: q.prevClose, volRatio: q.volRatio,
    candles, cost: costWithFee, pnlPct: pnl,
  }) : null

  // 交易计划：止盈(tp)/止损(sl)/理由(planReason)。判断现价是否触及
  const hitTP = q && h.tp && q.price >= Number(h.tp)
  const hitSL = q && h.sl && q.price <= Number(h.sl)
  const [planPrice, setPlanTP] = useState(h.tp != null ? String(h.tp) : '')
  const [planSL, setPlanSL] = useState(h.sl != null ? String(h.sl) : '')
  const [planReason, setPlanReason] = useState(h.planReason || '')
  const [planLoading, setPlanLoading] = useState(false) // LLM 生成建议中
  const [planBasis, setPlanBasis] = useState(null)       // LLM 给的定价依据 {tpBasis, slBasis, theory, confidence}

  // 依据该股 + 短线操作逻辑，给出默认止盈/止损/理由（用户可再改）
  const suggestPlan = () => {
    const base = costWithFee || (q && q.price) || h.buyPrice
    if (!base) return { tp: '', sl: '', reason: '' }
    // 止损：成本 -8%（短线纪律）与 MA10 生命线取较高者，更靠上的防线先触发
    const stopByPct = base * 0.92
    const ma10 = signal && signal.ma10
    const slRaw = ma10 && ma10 > stopByPct && ma10 < base ? ma10 : stopByPct
    // 止盈：短线常见 +10%（成本基准）
    const tpRaw = base * 1.10
    const round = (v) => {
      // 按价位量级取合适小数位：<10 用3位、<100 用2位、否则2位
      if (v < 10) return +v.toFixed(3)
      return +v.toFixed(2)
    }
    const usedMa = slRaw === ma10 && ma10 != null
    const reason = `短线：成本${fmtRaw(base)}，止损${usedMa ? '守MA10生命线' : '-8%纪律'}，止盈+10%；跌破5日线减仓、破10日线清仓`
    return { tp: String(round(tpRaw)), sl: String(round(slRaw)), reason }
  }
  // 打开计划编辑：existing=true 用已有值；否则先用本地建议兜底，再异步用 LLM 覆盖
  const openPlan = (useExisting) => {
    setPlanBasis(null)
    if (useExisting && (h.tp || h.sl || h.planReason)) {
      setPlanTP(h.tp != null ? String(h.tp) : '')
      setPlanSL(h.sl != null ? String(h.sl) : '')
      setPlanReason(h.planReason || '')
      setMode('plan')
      return
    }
    // 先用本地公式兜底填上（LLM 失败/慢时也有值）
    const s = suggestPlan()
    setPlanTP(s.tp); setPlanSL(s.sl); setPlanReason(s.reason)
    setMode('plan')
    fetchAiPlan()
  }

  // 调 LLM：参考技术指标+理论生成止盈/止损/理由
  const fetchAiPlan = async () => {
    if (!q) return
    setPlanLoading(true)
    try {
      const r = await callAI('plan', {
        name: h.name, code: h.code,
        nowPrice: q.price, pct: q.pct,
        turnover: q.turnover, volRatio: q.volRatio,
        mainInflowYi: q.mainInflow != null ? +(q.mainInflow / 1e8).toFixed(2) : null,
        holdCost: costWithFee, holdQty: h.qty,
      })
      if (r.ok && r.result) {
        const rs = r.result
        if (rs.tp != null && !isNaN(rs.tp)) setPlanTP(String(rs.tp))
        if (rs.sl != null && !isNaN(rs.sl)) setPlanSL(String(rs.sl))
        if (rs.reason) setPlanReason(rs.reason)
        setPlanBasis({ tpBasis: rs.tpBasis, slBasis: rs.slBasis, theory: rs.theory, confidence: rs.confidence })
      }
    } catch { /* 失败保留本地兜底值 */ }
    setPlanLoading(false)
  }

  const savePlan = () => {
    const tpVal = planPrice === '' ? null : Number(planPrice)
    const slVal = planSL === '' ? null : Number(planSL)
    planStore.setPlanRule(h.id, {
      tp: tpVal,
      sl: slVal,
      planReason: planReason.trim() || null,
    })
    // 计划联动预警：为止盈/止损各建一条到价预警，盘中触及即经预警中心提醒
    // 先清掉本股旧的计划型预警(planId=h.id)，避免重复
    const existing = (planStore.get().alerts || []).filter((a) => a.planId === h.id)
    existing.forEach((a) => planStore.removeAlert(a.id))
    if (tpVal != null) planStore.addAlert({ code: h.code, name: h.name, type: 'price', op: 'gte', value: tpVal, note: '止盈', planId: h.id })
    if (slVal != null) planStore.addAlert({ code: h.code, name: h.name, type: 'price', op: 'lte', value: slVal, note: '止损', planId: h.id })
    setMode(null)
  }

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
        <span title={`裸买入价 ${fmtRaw(h.buyPrice)} + 买入手续费 ${(h.buyFee || 0).toFixed(2)}`}>成本 {fmtRaw(costWithFee)} <span className="sub-name">(含费)</span></span>
        {q && <span>现价 <b className={pctClass(q.pct)}>{fmtRaw(q.price)}</b></span>}
        {q && h.buyPrice && <span title="现价市值 − 裸成本 − 已付买入手续费">浮盈 <b className={floatPnl >= 0 ? 'red' : 'green'}>{fmtMoney(floatPnl)}</b></span>}
      </div>

      {/* 「踏5不破10」策略信号灯 */}
      {signal && (
        <div className={'sig5 sig-' + signal.level}>
          <div className="sig5-main" onClick={() => setShowStrat((v) => !v)}>
            <div className="sig5-top">
              <span className={'sig5-tag sig-' + signal.level}>{signal.tag}</span>
              <span className="sig5-action">{signal.action}</span>
              <Icon name={showStrat ? 'chevronDown' : 'chevronRight'} size={14} className="sig5-caret" />
            </div>
            {signal.ma5 != null && (
              <div className="sig5-ma">
                <span className="sig5-ma-item">MA5 <b className={q && q.price >= signal.ma5 ? 'red' : 'green'}>{fmtRaw(signal.ma5)}</b></span>
                <span className="sig5-ma-item">MA10 <b className={q && q.price >= signal.ma10 ? 'red' : 'green'}>{fmtRaw(signal.ma10)}</b></span>
                {q && q.turnover != null && <span className="sig5-ma-item">换手 <b className={q.turnover > 10 ? 'gold' : ''}>{fmtNum(q.turnover, 1)}%</b></span>}
                {q && q.volRatio != null && <span className="sig5-ma-item">量比 <b className={q.volRatio > 2 ? 'gold' : ''}>{fmtNum(q.volRatio, 1)}</b></span>}
                {q && q.mainInflow != null && <span className="sig5-ma-item">主力 <b className={pctClass(q.mainInflow)}>{fmtInflow(q.mainInflow)}</b></span>}
              </div>
            )}
          </div>
          {showStrat && (
            <div className="sig5-detail">
              {signal.reasons.map((r, i) => <div key={i} className="sig5-reason">· {r}</div>)}
              <div className="sig5-rule">
                踏5不破10：站上5日线持有、缩量踩5线可低吸；跌破5线减仓、放量破10线清仓；单票亏损&gt;8% 止损。信号由日K均线+量能本地测算，仅供参考。
              </div>
            </div>
          )}
        </div>
      )}

      {/* 交易计划条：止盈/止损/理由；触及时高亮提醒 */}
      {(h.tp || h.sl || h.planReason) && mode !== 'plan' && (
        <div className={'plan-card' + (hitTP ? ' hit-tp' : hitSL ? ' hit-sl' : '')}>
          <div className="plan-card-body">
            <div className="plan-card-prices">
              <span className="plan-price-item">
                <span className="plan-price-k tp"><Icon name="target" size={11} /> 止盈</span>
                <b className="red">{h.tp ? fmtRaw(h.tp) : '—'}</b>
                {hitTP && <span className="plan-hit">已触及</span>}
              </span>
              <span className="plan-price-item">
                <span className="plan-price-k sl"><Icon name="shield" size={11} /> 止损</span>
                <b className="green">{h.sl ? fmtRaw(h.sl) : '—'}</b>
                {hitSL && <span className="plan-hit">已触及</span>}
              </span>
            </div>
            {h.planReason && <div className="plan-card-reason" title={h.planReason}>{h.planReason}</div>}
          </div>
          <div className="plan-card-actions">
            <button className="icon-btn" title="修改计划" onClick={() => openPlan(true)}><Icon name="edit" size={13} /></button>
            <button className="icon-btn" title="删除计划" onClick={() => planStore.clearPlanRule(h.id)}><Icon name="trash" size={13} /></button>
          </div>
        </div>
      )}

      {/* 做T战绩（流水式）*/}
      {(h.tFlows && h.tFlows.length > 0) && (
        <div className="t-stat">
          <span className="t-badge"><Icon name="refresh" size={12} />做T {h.tFlows.length}笔</span>
          <span>差价已实现 <b className={tStat.realized >= 0 ? 'red' : 'green'}>{fmtMoney(tStat.realized)}</b></span>
          {tStat.realized !== 0 && <span>实际成本 <b className="red">{fmtRaw(effCost)}</b> <span className="t-down">↓{fmtRaw(h.buyPrice - effCost)}</span></span>}
          {tStat.openBuy > 0 && <span className="t-open" style={{ color: 'var(--red)' }}>净买入 {tStat.openBuy}手 → 加仓</span>}
          {tStat.openSell > 0 && <span className="t-open" style={{ color: 'var(--green)' }}>净卖出 {tStat.openSell}手 → {tStat.openSell >= h.qty ? '清仓' : '减仓'}</span>}
          <span className="t-settle-wrap" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <button className="chip-btn done t-settle-btn" onClick={() => setConfirmSettle(true)} title="立即把今天的做T流水固化进交易记录并调整底仓">
              <Icon name="check" size={12} />结算入账
            </button>
            <span className="t-auto-hint">或次日自动结算</span>
          </span>
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
      ) : mode === 'plan' ? (
        <div className="plan-edit">
          <div className="plan-edit-tip">
            {planLoading
              ? <><Icon name="refresh" size={12} className="spin" /> AI 正参考技术指标与理论生成建议…</>
              : <><Icon name="spark" size={12} /> {planBasis ? 'AI 已按技术面给出建议价，可直接改' : '已按短线逻辑给默认值，可直接改'}</>}
            <button className="plan-refill" onClick={fetchAiPlan} disabled={planLoading}>AI 重新生成</button>
            <button className="plan-refill" onClick={() => { const s = suggestPlan(); setPlanTP(s.tp); setPlanSL(s.sl); setPlanReason(s.reason); setPlanBasis(null) }}>用公式</button>
          </div>
          {planBasis && (
            <div className="plan-basis">
              {planBasis.tpBasis && <span><b className="red">止盈</b> {planBasis.tpBasis}</span>}
              {planBasis.slBasis && <span><b className="green">止损</b> {planBasis.slBasis}</span>}
              {planBasis.theory && <span className="plan-basis-theory"><Icon name="book" size={11} /> {planBasis.theory}</span>}
              {planBasis.confidence && <span className="plan-basis-conf">信心 {planBasis.confidence}</span>}
            </div>
          )}
          <div className="plan-edit-row">
            <label><Icon name="target" size={12} /> 止盈价</label>
            <input className="wl-input" value={planPrice} onChange={(e) => setPlanTP(e.target.value)} placeholder="到价止盈" inputMode="decimal" />
            <label><Icon name="shield" size={12} /> 止损价</label>
            <input className="wl-input" value={planSL} onChange={(e) => setPlanSL(e.target.value)} placeholder="到价止损" inputMode="decimal" />
          </div>
          <input className="wl-input plan-reason-input" value={planReason} onChange={(e) => setPlanReason(e.target.value)} placeholder="买入理由 / 交易逻辑（复盘时对照）" />
          <div className="plan-edit-actions">
            <button className="chip-btn done" onClick={savePlan}><Icon name="check" size={12} />保存计划</button>
            <button className="chip-btn ghost" onClick={() => setMode(null)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="pi-actions">
          <button className="chip-btn buy" onClick={startAdd}><Icon name="cart" size={13} />加仓</button>
          <button className="chip-btn buy" onClick={startT}><Icon name="refresh" size={13} />做T</button>
          <button className="chip-btn sell" onClick={startSell}><Icon name="sell" size={13} />减仓/清仓</button>
          {!(h.tp || h.sl || h.planReason) && <button className="chip-btn ghost" onClick={() => openPlan(false)}><Icon name="target" size={12} />设计划</button>}
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

      {confirmSettle && (
        <ConfirmDialog
          title="结算做T入账？"
          body={<>
            确定把 <b>{h.name}</b> 今天的 {h.tFlows?.length || 0} 笔做T流水结算入账吗？结算后：
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              {tStat.realized !== 0 && <li>配对差价 <b className={tStat.realized >= 0 ? 'red' : 'green'}>{fmtMoney(tStat.realized)}</b> 计入交易记录（做T）</li>}
              {tStat.openBuy > 0 && <li>净买入 <b className="red">{tStat.openBuy}手</b> → 加仓，底仓成本按加权平均更新</li>}
              {tStat.openSell > 0 && <li>净卖出 <b className="green">{tStat.openSell}手</b> → {tStat.openSell >= h.qty ? '清仓（该持仓移除）' : '减仓'}</li>}
              <li>做T流水清空，结算不可撤销</li>
            </ul>
          </>}
          confirmText="确认结算"
          onConfirm={() => { planStore.settleTFlows(h.id); setConfirmSettle(false) }}
          onCancel={() => setConfirmSettle(false)}
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
                <span>{h.qty}手</span><span title={`裸买入价 ${fmtRaw(h.buyPrice)} + 买入手续费 ${(h.buyFee || 0).toFixed(2)}`}>成本 {fmtRaw(costWithFee)} <span className="sub-name">(含费)</span></span>
                {q && <span>现价 <b className={pctClass(q.pct)}>{fmtRaw(q.price)}</b></span>}
                {tStat.realized !== 0 && <span>做T已实现 <b className={tStat.realized >= 0 ? 'red' : 'green'}>{fmtMoney(tStat.realized)}</b></span>}
                {h.tFlows && h.tFlows.length > 0 && (
                  <button className="chip-btn done t-settle-btn" style={{ marginLeft: 'auto' }} onClick={() => { setConfirmSettle(true) }} title="把今天的做T流水固化进交易记录并调整底仓">
                    <Icon name="check" size={12} />结算入账
                  </button>
                )}
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
            <input className="wl-input" style={{ width: 90 }} value={tPrice} onChange={(e) => setTPrice(e.target.value)} placeholder={tSide === 'buy' ? '买入价(3位)' : '卖出价(3位)'} inputMode="decimal" step="0.001" />
            <input className="wl-input" style={{ width: 60 }} value={tQty} onChange={(e) => setTQty(e.target.value)} placeholder="手" inputMode="numeric" />
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
                              <span className="t-avg-item"><span className="t-avg-k buy">买入均价</span><b>{fmtRaw(d.buyAvg)}</b><span className="t-avg-q">{d.buyQty}手</span></span>
                            )}
                            {d.sellAvg != null && (
                              <span className="t-avg-item"><span className="t-avg-k sell">卖出均价</span><b>{fmtRaw(d.sellAvg)}</b><span className="t-avg-q">{d.sellQty}手</span></span>
                            )}
                            <span className="t-avg-fee">费{d.totalFee.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="t-flow-list">
                          {d.flows.map((f) => (
                            <TFlowRow key={f.id} f={f} holdingId={h.id} />
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

// 单条做T流水行：展示 + 就地编辑（价格精确到3位小数、可改方向/手数）
function TFlowRow({ f, holdingId }) {
  const [editing, setEditing] = useState(false)
  const [side, setSide] = useState(f.side)
  const [price, setPrice] = useState(String(f.price))
  const [qty, setQty] = useState(String(f.qty))

  const start = () => { setSide(f.side); setPrice(String(f.price)); setQty(String(f.qty)); setEditing(true) }
  const save = () => { planStore.editTFlow(holdingId, f.id, { side, price: Number(price), qty: Number(qty) }); setEditing(false) }

  if (editing) {
    return (
      <div className="t-flow-row t-flow-edit">
        <div className="t-side-toggle">
          <button className={'t-side-btn buy' + (side === 'buy' ? ' active' : '')} onClick={() => setSide('buy')}>买</button>
          <button className={'t-side-btn sell' + (side === 'sell' ? ' active' : '')} onClick={() => setSide('sell')}>卖</button>
        </div>
        <input className="wl-input t-edit-price" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="单价" inputMode="decimal" />
        <input className="wl-input t-edit-qty" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="手" inputMode="numeric" />
        <button className="chip-btn done" onClick={save}><Icon name="check" size={12} />保存</button>
        <button className="chip-btn ghost" onClick={() => setEditing(false)}>取消</button>
      </div>
    )
  }
  return (
    <div className="t-flow-row">
      <span className={'t-flow-side ' + f.side}>{f.side === 'buy' ? '买' : '卖'}</span>
      <span className="t-flow-p">{fmtRaw(f.price)} × {f.qty}手</span>
      <span className="t-flow-fee">费{f.fee.toFixed(2)}</span>
      <span className="t-flow-time">{new Date(f.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      <span className="t-flow-edit-btn" title="编辑此笔" onClick={start}><Icon name="edit" size={12} /></span>
      <span className="del" title="删除此笔" onClick={() => planStore.removeTFlow(holdingId, f.id)}>×</span>
    </div>
  )
}
