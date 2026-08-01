import { useState, useRef, useMemo, useEffect } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import ConfirmDialog from './ConfirmDialog'
import { AlertForm } from './AlertCenter'
import { usePolling } from '../hooks'
import { callAI } from '../ai'
import { planStore, usePlanStore, calcBuyFee, calcSellFee, computeTFlows } from '../planStore'
import { aiStore } from '../aiStore'
import { generateReview, sessionLabel, forceGenerateReviews, currentAutoSession, missingReviewCount } from '../review'
import { fmtPct, pctClass, fmtNum, fmtInflow , fmtRaw, hasVal, opText } from '../format'

// 从交易记录里提取某只股的历史买卖(供 AI 贴合用户成本带/操作习惯)
function tradeHistoryOf(closed, code) {
  return (closed || [])
    .filter((c) => c.code === code)
    .slice(0, 12)
    .map((c) => ({
      type: c.kind || c.type,
      buy: c.buyPrice != null ? +Number(c.buyPrice).toFixed(3) : null,
      sell: c.sellPrice != null ? +Number(c.sellPrice).toFixed(3) : null,
      qty: c.qty, pnl: c.netPnl != null ? +Number(c.netPnl).toFixed(0) : null,
    }))
}

// 通用「AI 建议价」按钮：点击→基于历史规律+实时价+交易记录给挂单价→填入输入框
// props: code,name,actionKind(buy|add|sell),quote,holdCost,onPick(price)
function SuggestPriceBtn({ code, name, actionKind, quote, holdCost, onPick }) {
  const [st, setSt] = useState(null) // {loading}|{result}|{error}
  const book = usePlanStore()
  const q = quote && quote[code]
  const ask = async () => {
    setSt({ loading: true })
    try {
      const r = await callAI('price', {
        code, name, action: actionKind === 'sell' ? 'sell' : 'buy', actionKind,
        nowPrice: q?.price, pct: q?.pct,
        dayHigh: q?.high, dayLow: q?.low, open: q?.open, prevClose: q?.prevClose,
        turnover: q?.turnover, volRatio: q?.volRatio,
        holdCost: holdCost || null,
        tradeHistory: tradeHistoryOf(book.closed, code),
      })
      if (r.ok && r.result && r.result.price != null) {
        onPick(String(r.result.price))
        setSt({ result: r.result })
      } else setSt({ error: r.error || 'AI 未能给出价格' })
    } catch (e) { setSt({ error: String(e.message || e) }) }
  }
  const isSell = actionKind === 'sell'
  return (
    <div className="sug-price">
      <button type="button" className={'sug-price-btn' + (isSell ? ' sell' : ' buy')} onClick={ask} disabled={st && st.loading}
        title="AI 结合历史规律 + 当前实时价 + 你的过往交易记录，给一个合理挂单价">
        {st && st.loading ? <><Icon name="refresh" size={12} className="spin" />算价中</> : <><Icon name="spark" size={12} />AI 建议{isSell ? '卖' : '买'}价</>}
      </button>
      {st && st.result && (
        <div className="sug-price-info">
          <span className="sug-price-val">{st.result.price}{st.result.altPrice ? <span className="sug-alt"> / 备用 {st.result.altPrice}</span> : null}</span>
          {st.result.anchor && <span className="sug-price-anchor">{st.result.anchor}</span>}
          {st.result.reason && <div className="sug-price-reason">{st.result.reason}</div>}
          {st.result.histNote && <div className="sug-price-hist"><Icon name="history" size={11} />{st.result.histNote}</div>}
          {st.result.techNote && <div className="sug-price-hist tech"><Icon name="target" size={11} />{st.result.techNote}</div>}
          {st.result.quantNote && <div className="sug-price-hist quant"><Icon name="gauge" size={11} />{st.result.quantNote}</div>}
          {st.result.confidence && <span className="sug-price-conf">信心 {st.result.confidence}</span>}
        </div>
      )}
      {st && st.error && <span className="sug-price-err">{st.error} <span className="expand-btn" onClick={ask}>重试</span></span>}
    </div>
  )
}

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

// ========== 盘中时段操盘提示引擎 ==========
// 依据用户的盘中交易规律：不同时段 + 实时盘面(高开/封板/量比/冲高缩量/跳水) → 一句话"此刻该怎么做"
// 返回 { phase, when, tag, tone, tip } 或 null(非交易时段/数据不足)
// tone: sell(偏减) | buy(偏吸) | hold(持有) | watch(观望)
function intradayPlaybook(q) {
  if (!q || !q.price) return null
  // 北京时间（东八区）当前分钟数
  const now = new Date()
  const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000)
  const hm = bj.getHours() * 60 + bj.getMinutes()
  const inSession = (hm >= 570 && hm <= 690) || (hm >= 780 && hm <= 900) // 9:30-11:30 / 13:00-15:00
  if (!inSession) return null

  const open = q.open, prev = q.prevClose, price = q.price, high = q.high, low = q.low
  const pct = q.pct
  const openGap = (open != null && prev) ? (open - prev) / prev * 100 : null   // 高/低开幅度
  const vr = q.volRatio
  const limitUp = q.isLimitUp
  const nearHigh = high && price >= high * 0.997
  const offHigh = high && high > 0 ? (high - price) / high * 100 : null          // 距日内高点回落%
  const shrink = vr != null && vr < 1                                            // 缩量

  const mk = (tag, tone, tip, when) => ({ when, tag, tone, tip })

  // —— 9:30–10:00 早盘：以减仓为主 ——
  if (hm < 600) {
    if (limitUp) return mk('封板持有', 'hold', '早盘已封涨停，封单稳则持有观察，别急着卖。', '9:30–10:00')
    if (openGap != null && openGap >= 3 && !limitUp) return mk('高开未封·减五成', 'sell', `高开${openGap.toFixed(1)}%但未封板，早盘冲高兑现窗口，先减约五成锁利。`, '9:30–10:00')
    if (offHigh != null && offHigh >= 1.5 && shrink) return mk('冲高缩量·止盈', 'sell', `早盘冲高后缩量回落(距高点${offHigh.toFixed(1)}%)，优先止盈不恋战。`, '9:30–10:00')
    if (openGap != null && Math.abs(openGap) < 1 && vr != null && vr >= 1.3 && pct > 0) return mk('平开放量·可顺势', 'buy', '平开后放量小步走高，10点后若量能持续可考虑顺势加一点。', '9:30–10:00')
    return mk('早盘多看少动', 'watch', '早盘以减仓为主、少加仓；等量价方向明确再动手。', '9:30–10:00')
  }
  // —— 10:00–11:00：观察量价，不盲目追涨 ——
  if (hm < 660) {
    if (limitUp) return mk('封板持有', 'hold', '封板中，封单稳定继续持有。', '10:00–11:00')
    if (offHigh != null && offHigh >= 1.5 && shrink) return mk('冲高缩量·止盈', 'sell', `冲高后缩量(距高点${offHigh.toFixed(1)}%)、无资金配合，及时止盈。`, '10:00–11:00')
    if (pct > 3 && vr != null && vr >= 1.5) return mk('放量上扬·持有', 'hold', '一路放量上扬、有资金配合，持有;若11点后突然加速要防冲高回落。', '10:00–11:00')
    return mk('看量价·不追高', 'watch', '重点看量能是否持续放大;缩量别追,放量才可靠。', '10:00–11:00')
  }
  // —— 11:00–13:30：午盘,减少冲动 ——
  if (hm < 810) {
    return mk('午盘观察', 'watch', '午盘减少冲动交易:看板块持续性与承接,不追短拉、不因短调恐慌。', '11:00–13:30')
  }
  // —— 13:30–14:30：日内次强波动段 ——
  if (hm < 870) {
    if (offHigh != null && offHigh >= 1.5 && shrink) return mk('未破高点·止盈', 'sell', `未突破上午高点且缩量(距高点${offHigh.toFixed(1)}%)，可考虑止盈。`, '13:30–14:30')
    if (pct <= -3) return mk('午后大跌·不急抄', 'watch', `午后跌${pct.toFixed(1)}%，不急于当日抄底;看次日能否回踩10日线获支撑再接。`, '13:30–14:30')
    return mk('观察承接', 'watch', '观察个股承接与量能,有支撑+量价配合才考虑动作。', '13:30–14:30')
  }
  // —— 14:30–15:00：尾盘,决定持仓与次日 ——
  if (limitUp && hm >= 840) return mk('午后封板·谨慎', 'sell', '午后小单封板需谨慎,封单不实考虑清仓/大幅减仓。', '14:30–15:00')
  if (pct >= 5 || (nearHigh && pct >= 3)) return mk('尾盘大涨·减仓', 'sell', `尾盘大涨(${pct.toFixed(1)}%),以减仓为主、不盲目追高。`, '14:30–15:00')
  if (pct <= -3) return mk('尾盘跳水·次日看', 'watch', `尾盘跳水${pct.toFixed(1)}%,次日若回踩10日线获支撑再考虑接回。`, '14:30–15:00')
  if (offHigh != null && offHigh <= 1 && low && price <= low * 1.01 && vr != null && vr < 1.2) return mk('尾盘低吸窗口', 'buy', '尾盘企稳、贴近日内低点,若有支撑+量价依据可低吸;需谨慎。', '14:30–15:00')
  return mk('尾盘少动', 'watch', '尾盘原则上少减仓、不追高,重点看是否有尾盘资金承接。', '14:30–15:00')
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
          <div className="buy-inline-wrap">
            <div className="buy-inline">
              <input className="wl-input" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="买入价" />
              <input className="wl-input" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="手" />
              {price && Number(qty) > 0 && <span className="fee-hint">费≈{calcBuyFee(Number(price) * Number(qty) * 100).toFixed(0)}</span>}
              <button className="chip-btn done" onClick={() => confirmBuy(p.code)}><Icon name="check" size={12} />确认</button>
              <button className="chip-btn ghost" onClick={() => setBuying(null)}>取消</button>
            </div>
            <SuggestPriceBtn code={p.code} name={(q && q.name) || p.name} actionKind="buy" quote={quote} onPick={setPrice} />
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

  // 行业归类：优先用实时行情的 industry，其次用已缓存到候选上的 industry，否则「其他」
  const [tab, setTab] = useState('全部') // 当前选中行业 tab
  const industryOf = (p) => {
    const q = quote[p.code]
    return (q && q.industry) || p.industry || '其他'
  }
  // 行情返回行业后，回写缓存到候选，保证行情缺失时仍能分类（且持久化到云端）
  useEffect(() => {
    ;(book.plan || []).forEach((p) => {
      const q = quote[p.code]
      if (q && q.industry && q.industry !== p.industry) {
        planStore.setCandPlan(p.code, { industry: q.industry })
      }
    })
    // eslint-disable-next-line
  }, [Object.keys(quote).length, book.plan.length])

  // 排序规则：重点关注置顶 → 当日涨幅高在前(强势优先) → 无行情的排后
  const sortRule = (a, b) => {
    if (!!a.star !== !!b.star) return a.star ? -1 : 1
    const qa = quote[a.code], qb = quote[b.code]
    const pa = qa ? qa.pct : -999, pb = qb ? qb.pct : -999
    return pb - pa
  }

  // 汇总每个行业的只数 + 平均涨幅（用于 tab 排序：热门行业靠前）
  const industries = useMemo(() => {
    const map = new Map()
    ;(book.plan || []).forEach((p) => {
      const ind = industryOf(p)
      const q = quote[p.code]
      const o = map.get(ind) || { name: ind, count: 0, pctSum: 0, pctN: 0 }
      o.count++
      if (q && q.pct != null) { o.pctSum += q.pct; o.pctN++ }
      map.set(ind, o)
    })
    const arr = [...map.values()].map((o) => ({ ...o, avgPct: o.pctN ? o.pctSum / o.pctN : null }))
    // 行业排序：「其他」永远最后；其余按 只数降序 → 平均涨幅降序
    arr.sort((a, b) => {
      if (a.name === '其他') return 1
      if (b.name === '其他') return -1
      if (b.count !== a.count) return b.count - a.count
      return (b.avgPct ?? -999) - (a.avgPct ?? -999)
    })
    return arr
    // eslint-disable-next-line
  }, [book.plan, quote])

  // 当前 tab 下要显示的候选（全部=所有；否则=该行业）
  const shown = (tab === '全部' ? book.plan : book.plan.filter((p) => industryOf(p) === tab)).slice().sort(sortRule)
  // tab 可能因删票失效 → 回退到全部
  useEffect(() => {
    if (tab !== '全部' && !industries.some((i) => i.name === tab)) setTab('全部')
    // eslint-disable-next-line
  }, [industries])

  return (
    <div className="panel">
      <div className="panel-head plan-head">
        <div className="panel-title"><Icon name="eye" size={16} /> 自选 / 候选 <span className="sub-name">{book.plan.length} 只 · 按行业分类</span></div>
        <div className="plan-search"><StockSearch /></div>
      </div>
      {book.plan.length === 0 ? (
        <div className="empty small">搜索股票加入自选，或在「今日选股」点「加自选」。这里实时盯盘资金/量比，并按行业分类；点每张卡左上的星标可置顶重点关注。</div>
      ) : (
        <>
          {/* 行业 Tab 栏：全部 + 各行业(按只数/强度排序) + 其他 */}
          <div className="ind-tabs">
            <button className={'ind-tab' + (tab === '全部' ? ' on' : '')} onClick={() => setTab('全部')}>
              全部 <span className="ind-tab-n">{book.plan.length}</span>
            </button>
            {industries.map((i) => (
              <button key={i.name} className={'ind-tab' + (tab === i.name ? ' on' : '') + (i.name === '其他' ? ' other' : '')} onClick={() => setTab(i.name)}>
                {i.name} <span className="ind-tab-n">{i.count}</span>
                {i.avgPct != null && <span className={'ind-tab-pct ' + (i.avgPct >= 0 ? 'red' : 'green')}>{i.avgPct >= 0 ? '+' : ''}{i.avgPct.toFixed(1)}%</span>}
              </button>
            ))}
          </div>
          {/* 当前 tab 的候选卡（重点关注置顶 → 涨幅降序）*/}
          <div className="plan-cand-grid">{shown.map(Card)}</div>
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
// ---------- 军师战绩：AI建议真实胜率(事后回测统计) ----------
function AdvisorScore({ book }) {
  const stats = planStore.adviceStats()
  if (!stats || (stats.total === 0 && stats.pending === 0)) return null
  const wr = stats.winRate
  const tone = wr == null ? 'muted' : wr >= 55 ? 'red' : wr >= 45 ? 'gold' : 'green'
  return (
    <div className="advisor-score" title="AI建议隔日自动比对真实价格得出的命中率，样本越多越可信">
      <Icon name="target" size={13} />
      <span className="as-k">军师战绩</span>
      {wr != null
        ? <><span className={'as-wr ' + tone}>{wr}%</span><span className="as-sub">胜率 · {stats.total}次已验</span></>
        : <span className="as-sub">积累中 · {stats.pending}次待验</span>}
    </div>
  )
}

// ---------- 当前持仓 ----------
function HoldingList({ book, quote }) {
  const [reviewing, setReviewing] = useState(null) // null | 'loading' | {ok,fail,skipped}
  // "补全复盘"：只对今天还没有复盘的持仓补生成，与单卡"重生成"(覆盖单只)职责分离，避免重复。
  const missing = missingReviewCount()
  const runReview = async () => {
    if (reviewing === 'loading' || missing === 0) return
    setReviewing('loading')
    const qmap = {}
    Object.keys(quote || {}).forEach((c) => { qmap[c] = { price: quote[c].price } })
    const session = currentAutoSession() || 'manual'
    try {
      const res = await forceGenerateReviews(session, qmap, { onlyMissing: true })
      setReviewing(res)
      setTimeout(() => setReviewing(null), 4000)
    } catch { setReviewing({ ok: 0, fail: 1 }); setTimeout(() => setReviewing(null), 4000) }
  }
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="wallet" size={16} /> 当前持仓 <span className="sub-name">{book.holding.length} 只 · 支持做T</span></div>
        <div className="hold-head-actions">
          <AdvisorScore book={book} />
          {book.holding.length > 0 && (
            <button className="mini-btn" onClick={runReview} disabled={reviewing === 'loading' || (reviewing == null && missing === 0)}
              title={missing === 0 ? '所有持仓今日复盘已就绪；如需更新单只，展开该卡的「复盘」点重生成' : `为今天还没有复盘的 ${missing} 只持仓补生成复盘`}>
              <Icon name={reviewing === 'loading' ? 'refresh' : 'history'} size={12} className={reviewing === 'loading' ? 'spin' : ''} />
              {reviewing === 'loading' ? '复盘中…'
                : (reviewing && typeof reviewing === 'object') ? `已补${reviewing.ok}只${reviewing.fail ? `·失败${reviewing.fail}` : ''}`
                : missing === 0 ? '复盘已就绪' : `补全复盘 (${missing})`}
            </button>
          )}
        </div>
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
  const [tStyle, setTStyle] = useState('auto') // auto(按历史规律) | conservative | balanced | aggressive
  const [openDays, setOpenDays] = useState({}) // 做T流水按天折叠，key→是否展开
  const [expanded, setExpanded] = useState(false) // 卡片明细区（盘中提示/复盘/信号/计划/做T）默认折叠
  const [detailTab, setDetailTab] = useState(null) // 明细手风琴当前展开的分段: 'review'|'signal'|'plan'|'t'|null

  const book = usePlanStore()

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
  // 盘中时段操盘提示（时段 + 实时盘面 → 此刻该怎么做）
  const play = q ? intradayPlaybook(q) : null

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
        const base = costWithFee || (q && q.price) || h.buyPrice
        const round = (v) => (v < 10 ? +v.toFixed(3) : +v.toFixed(2))
        let tp = rs.tp != null && !isNaN(rs.tp) ? Number(rs.tp) : null
        let sl = rs.sl != null && !isNaN(rs.sl) ? Number(rs.sl) : null
        // 兜底校验：止盈必须显著高于成本、止损必须低于成本，防 AI 越界给出低于成本的"止盈"
        if (base) {
          if (tp == null || tp <= base * 1.03) tp = round(base * 1.08)   // 止盈至少成本+8%
          if (sl == null || sl >= base) sl = round(base * 0.92)          // 止损至多成本-8%
          if (sl < base * 0.90) sl = round(base * 0.92)                  // 止损别离谱过深
        }
        if (tp != null) setPlanTP(String(tp))
        if (sl != null) setPlanSL(String(sl))
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
  // 实时持仓手数/成本（做T后即时反映）
  const netT = (tStat.openBuy || 0) - (tStat.openSell || 0)
  const liveQty = h.qty + netT
  const liveCost = tStat.realized ? effCost : costWithFee
  // 主行动：此刻最该做的一件事（触及止盈/止损 > 信号动作 > 盘中提示）
  const focus = (() => {
    if (hitTP) return { tone: 'red', badge: '止盈', text: `已到止盈价 ${fmtRaw(h.tp)}，考虑落袋` }
    if (hitSL) return { tone: 'green', badge: '止损', text: `已到止损价 ${fmtRaw(h.sl)}，按纪律离场` }
    if (signal) return { tone: (signal.level === 'buy' || signal.level === 'hold') ? 'red' : (signal.level === 'sell' || signal.level === 'danger') ? 'green' : 'muted', badge: signal.tag, text: signal.action }
    if (play) return { tone: play.tone === 'buy' ? 'red' : play.tone === 'sell' ? 'green' : 'muted', badge: play.when, text: play.tip }
    return null
  })()
  return (
    <div className="hold-item">
      {/* 决策条：股名 + 特大号浮盈亏（第一视觉焦点）*/}
      <div className="hold-head">
        <div className="hold-head-l">
          <StockName code={h.code} name={h.name}><span className="hh-name">{h.name}</span></StockName>
          <span className="hh-code">{h.code}</span>
          {q && <span className={'hh-price ' + pctClass(q.pct)}>{fmtRaw(q.price)} <span className="hh-chg">{fmtPct(q.pct)}</span></span>}
        </div>
        {pnl != null && (
          <div className={'hold-pnl ' + (pnl >= 0 ? 'red' : 'green')} title="相对含费成本的浮动盈亏">
            <span className="hp-pct">{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%</span>
            {floatPnl != null && <span className="hp-amt">{fmtMoney(floatPnl)}</span>}
          </div>
        )}
      </div>

      {/* 数据行：只留 持仓手数 · 成本（现价已并入顶部）*/}
      <div className="hold-meta">
        <span title={netT !== 0 ? `底仓 ${h.qty} 手，今日做T未结算净${netT > 0 ? '买入+' : '卖出'}${netT} 手` : '当前持仓手数'}>
          持仓 {liveQty}手{netT !== 0 && <span className="sub-name"> (底仓{h.qty}{netT > 0 ? '+' : ''}{netT})</span>}
        </span>
        <span title={`裸买入价 ${fmtRaw(h.buyPrice)} + 买入手续费 ${(h.buyFee || 0).toFixed(2)}${tStat.realized ? `；做T差价摊薄 ${fmtMoney(tStat.realized)}` : ''}`}>
          成本 {fmtRaw(liveCost)} <span className="sub-name">{tStat.realized ? '(做T后)' : '(含费)'}</span>
        </span>
      </div>

      {/* 主行动：此刻唯一最该关注的一句（徽标 + 一句话）*/}
      {focus && (
        <div className={'hold-focus focus-' + focus.tone}>
          {focus.badge && <span className="hf-badge">{focus.badge}</span>}
          <span className="hf-text">{focus.text}</span>
        </div>
      )}

      {/* 明细展开开关：把复盘/信号/计划/做T 收纳，展开后手风琴分段(一次看一类) */}
      {(() => {
        const hasReview = !!(book.reviews && book.reviews[h.code])
        const hasSignal = !!signal
        const hasPlan = !!(h.tp || h.sl || h.planReason)
        const hasT = !!(h.tFlows && h.tFlows.length > 0)
        const segs = [
          { key: 'review', label: '复盘', dot: !hasReview },
          hasSignal && { key: 'signal', label: '信号' },
          hasPlan && { key: 'plan', label: '计划' },
          hasT && { key: 't', label: `做T${h.tFlows.length}` },
        ].filter(Boolean)
        if (!segs.length && !play) return null
        // 打开明细时默认选中第一个分段
        const openDetail = () => { const nx = !expanded; setExpanded(nx); if (nx && !detailTab && segs.length) setDetailTab(segs[0].key) }
        return (
          <>
            <button className="hold-detail-toggle" onClick={openDetail}>
              <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
              {expanded ? '收起明细' : '明细'}
              {!expanded && <span className="hdt-chips">{segs.map((s) => <span key={s.key} className={'hdt-chip' + (s.dot ? ' pending' : '')}>{s.label}</span>)}</span>}
            </button>

            {expanded && (
              <div className="hold-detail">
                {/* 盘中时段操盘提示（若与主行动不同，作为补充展示在明细顶部）*/}
                {play && (
                  <div className={'ipb ipb-' + play.tone}>
                    <span className="ipb-when">{play.when}</span>
                    <span className={'ipb-tag ipb-' + play.tone}>{play.tag}</span>
                    <span className="ipb-tip">{play.tip}</span>
                  </div>
                )}

                {/* 手风琴分段切换条 */}
                {segs.length > 0 && (
                  <div className="hd-segs">
                    {segs.map((s) => (
                      <button key={s.key} className={'hd-seg' + (detailTab === s.key ? ' on' : '') + (s.dot ? ' has-dot' : '')} onClick={() => setDetailTab(s.key)}>{s.label}</button>
                    ))}
                  </div>
                )}

                {/* 复盘结论：即使还没有自动复盘，也暴露按钮支持手动生成/重新生成 */}
                {detailTab === 'review' && (
                  <HoldReview code={h.code} name={h.name} cost={costWithFee} qty={h.qty} price={q && q.price} />
                )}

                {/* 「踏5不破10」策略信号灯 */}
                {detailTab === 'signal' && signal && (
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

                {/* 交易计划条：止盈/止损/理由 */}
                {detailTab === 'plan' && hasPlan && mode !== 'plan' && (
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

                {/* 做T战绩（流水式）：数据一行、结算入账另起一行，不再挤 */}
                {detailTab === 't' && hasT && (
                  <div className="t-stat t-stat-v">
                    <div className="t-stat-row">
                      <span className="t-badge"><Icon name="refresh" size={12} />做T {h.tFlows.length}笔</span>
                      <span>差价已实现 <b className={tStat.realized >= 0 ? 'red' : 'green'}>{fmtMoney(tStat.realized)}</b></span>
                      {tStat.realized !== 0 && <span>实际成本 <b className="red">{fmtRaw(effCost)}</b> <span className="t-down">↓{fmtRaw(h.buyPrice - effCost)}</span></span>}
                      {tStat.openBuy > 0 && <span className="t-open" style={{ color: 'var(--red)' }}>净买入 {tStat.openBuy}手 → 加仓</span>}
                      {tStat.openSell > 0 && <span className="t-open" style={{ color: 'var(--green)' }}>净卖出 {tStat.openSell}手 → {tStat.openSell >= h.qty ? '清仓' : '减仓'}</span>}
                    </div>
                    <div className="t-stat-foot">
                      <button className="chip-btn done t-settle-btn" onClick={() => setConfirmSettle(true)} title="立即把今天的做T流水固化进交易记录并调整底仓">
                        <Icon name="check" size={12} />结算入账
                      </button>
                      <span className="t-auto-hint">或次日自动结算</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )
      })()}

      {/* 操作区 */}
      {mode === 'add' ? (
        <div className="buy-inline-wrap">
          <div className="buy-inline">
            <input className="wl-input" value={addPrice} onChange={(e) => setAddPrice(e.target.value)} placeholder="加仓价" />
            <input className="wl-input" value={addQty} onChange={(e) => setAddQty(e.target.value)} placeholder="手" />
            {addPrice && Number(addQty) > 0 && <span className="fee-hint">费≈{calcBuyFee(Number(addPrice) * Number(addQty) * 100).toFixed(2)}</span>}
            <button className="chip-btn buy" onClick={confirmAdd}><Icon name="check" size={13} />确认加仓</button>
            <button className="chip-btn ghost" onClick={() => setMode(null)}>取消</button>
          </div>
          <SuggestPriceBtn code={h.code} name={h.name} actionKind="add" quote={q ? { [h.code]: q } : null} holdCost={costWithFee} onPick={setAddPrice} />
        </div>
      ) : mode === 'sell' ? (
        <div className="buy-inline-wrap">
          <div className="buy-inline">
            <input className="wl-input" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} placeholder="卖出价" />
            <input className="wl-input" value={sellQty} onChange={(e) => setSellQty(e.target.value)} placeholder="手" />
            <span className="qty-hint">/{h.qty}手</span>
            {sellPrice && Number(sellQty) > 0 && <span className="fee-hint">费≈{calcSellFee(Number(sellPrice) * Number(sellQty) * 100).toFixed(2)}</span>}
            <button className="chip-btn done" onClick={confirmSell}><Icon name="check" size={13} />{Number(sellQty) >= h.qty ? '确认清仓' : '确认减仓'}</button>
            <button className="chip-btn ghost" onClick={() => setMode(null)}>取消</button>
          </div>
          <SuggestPriceBtn code={h.code} name={h.name} actionKind="sell" quote={q ? { [h.code]: q } : null} holdCost={costWithFee} onPick={setSellPrice} />
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
            {/* 风格选择：默认「自动」由 AI 按该股历史规律选定 */}
            <div className="t-style">
              <span className="t-style-label">风格</span>
              {[['auto', '自动'], ['conservative', '稳健'], ['balanced', '均衡'], ['aggressive', '激进']].map(([k, label]) => (
                <button key={k} className={'t-style-btn' + (tStyle === k ? ' active ' + k : '')} onClick={() => askTAdvice(k)} title={k === 'auto' ? 'AI 分析这只股的历史规律，自动选激进/均衡/稳健并定正T或反T' : ''}>{label}</button>
              ))}
            </div>
            {!tAdvice && (
              <button className="t-ai-btn" onClick={() => askTAdvice()}><Icon name="spark" size={14} />{tStyle === 'auto' ? 'AI 按历史规律自动决策做T策略' : `获取 AI 做T参考（${tStyle === 'conservative' ? '稳健' : tStyle === 'aggressive' ? '激进' : '均衡'}）`}</button>
            )}
            {tAdvice && tAdvice.loading && <div className="t-ai-loading"><Icon name="refresh" size={13} className="spin" />AI 正在分析历史规律/分时/大盘/资金…</div>}
            {tAdvice && tAdvice.error && <div className="err">{tAdvice.error} <span className="expand-btn" onClick={askTAdvice}>重试</span></div>}
            {tAdvice && tAdvice.result && (
              <div className={'t-ai-card ' + (tAdvice.result.light || 'yellow')}>
                <div className="t-ai-head">
                  <span className="t-ai-badge">{tAdvice.result.dirLabel || tAdvice.result.advisable}</span>
                  {tAdvice.result.chosenStyle && <span className={'t-style-tag ' + tAdvice.result.chosenStyle}>{{ conservative: '稳健', balanced: '均衡', aggressive: '激进' }[tAdvice.result.chosenStyle] || tAdvice.result.chosenStyle}</span>}
                  {tAdvice.result.confidence && <span className="t-conf">信心 {tAdvice.result.confidence}</span>}
                  <div className="t-ai-actions" style={{ marginLeft: 'auto' }}>
                    <span className="expand-btn" onClick={() => askTAdvice()}>重新生成</span>
                    <span className="expand-btn" onClick={() => setTAdvice(null)}>收起</span>
                  </div>
                </div>
                {tAdvice.result.reasoning && (
                  <div className="ai-reasoning"><span className="ai-reasoning-k">研判</span>{tAdvice.result.reasoning}</div>
                )}
                {tAdvice.result.actionPlan && (
                  <div className="t-ai-plan"><Icon name="target" size={13} /><span className="t-ai-plan-k">这样操作</span>{tAdvice.result.actionPlan}</div>
                )}
                {tAdvice.result.histPattern && (
                  <div className="t-ai-hist"><Icon name="history" size={12} /><span>历史规律</span>{tAdvice.result.histPattern}</div>
                )}
                {tAdvice.result.plain && <div className="t-ai-plain">{tAdvice.result.plain}</div>}
                <div className="t-ai-basis">
                  {tAdvice.result.styleReason && <div className="t-basis-row"><span className="t-basis-k">选型</span>{tAdvice.result.styleReason}</div>}
                  {tAdvice.result.marketNote && <div className="t-basis-row"><span className="t-basis-k">大盘</span>{tAdvice.result.marketNote}</div>}
                  {tAdvice.result.stockNote && <div className="t-basis-row"><span className="t-basis-k">盘面</span>{tAdvice.result.stockNote}</div>}
                  {tAdvice.result.fundNote && <div className="t-basis-row"><span className="t-basis-k">资金</span>{tAdvice.result.fundNote}</div>}
                  {(tAdvice.result.support || tAdvice.result.resistance) && (
                    <div className="t-basis-row"><span className="t-basis-k">支撑压力</span>支撑 <b className="green">{tAdvice.result.support ?? '--'}</b> · 压力 <b className="red">{tAdvice.result.resistance ?? '--'}</b></div>
                  )}
                  {tAdvice.result.quantNote && <div className="t-basis-row"><span className="t-basis-k quant">量化</span>{tAdvice.result.quantNote}</div>}
                  {tAdvice.result.newsNote && <div className="t-basis-row"><span className="t-basis-k">消息</span>{tAdvice.result.newsNote}</div>}
                  {tAdvice.result.macroNote && <div className="t-basis-row"><span className="t-basis-k">宏观</span>{tAdvice.result.macroNote}</div>}
                  {tAdvice.result.riskReward && <div className="t-basis-row"><span className="t-basis-k">盈亏比</span>{tAdvice.result.riskReward}</div>}
                  {tAdvice.result.bearCase && <div className="t-basis-row"><span className="t-basis-k">反方</span>{tAdvice.result.bearCase}</div>}
                  {tAdvice.result.invalidation && <div className="t-basis-row"><span className="t-basis-k theory">失效</span>{tAdvice.result.invalidation}</div>}
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

// ---------- 持仓卡上的复盘结论条（午间/收盘自动生成，只显示最新一条；无按钮，纯自动）----------
function HoldReview({ code, name, cost, qty, price }) {
  const book = usePlanStore()
  const review = (book.reviews || {})[code] || null
  const [open, setOpen] = useState(false) // 展开完整细节
  const [regen, setRegen] = useState(null) // null | loading | error
  const r = review && review.result
  const tone = r ? (r.tone || 'muted') : 'muted'
  const ts = review ? new Date(review.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
  const nextLabel = review ? (review.session === 'noon' ? '下午' : review.session === 'close' ? '明天开盘' : '后续') : '后续'
  const doRegenerate = async () => {
    if (regen === 'loading') return
    setRegen('loading')
    try {
      const pnlPct = (price && cost) ? +(((price - cost) / cost) * 100).toFixed(2) : null
      const res = await generateReview({ code, name, session: currentAutoSession() || 'manual', hold: { cost, qty, pnlPct } })
      if (res && !res.error) { setRegen(null); setOpen(false) }
      else setRegen(res && res.error ? res.error : '生成失败')
    } catch (e) {
      setRegen(String(e.message || e || '生成失败'))
    }
  }
  if (!review || !r) {
    return (
      <div className="hold-review rev-muted">
        <div className="hr-top minimal">
          <span className="hr-badge"><Icon name="history" size={12} /> 复盘</span>
          <button className="hr-link" onClick={doRegenerate} disabled={regen === 'loading'}>
            {regen === 'loading' ? '生成中…' : '生成复盘'}
          </button>
        </div>
        <div className="hr-empty">还没有复盘。可点右上「生成复盘」为这只单独生成，或用顶部「补全复盘」一次补齐所有缺口；午间/收盘也会自动生成。</div>
        {regen && regen !== 'loading' && <div className="hr-empty err">{regen}</div>}
      </div>
    )
  }
  return (
    <div className={'hold-review rev-' + tone}>
      {/* ① 顶部元信息条：徽标 + 场次 + 时间（复盘由午间/收盘自动生成，无需按钮）*/}
      <div className="hr-top minimal">
        <span className="hr-badge"><Icon name="history" size={12} /> 复盘</span>
        {review && <span className={'hr-sess ' + review.session}>{sessionLabel(review.session)}</span>}
        {ts && <span className="hr-time">{ts}</span>}
        <button className="hr-link" onClick={doRegenerate} disabled={regen === 'loading'} title="基于当前账户资金/持仓/行情重新生成复盘意见">
          {regen === 'loading' ? '生成中…' : '重生成'}
        </button>
      </div>
      {regen && regen !== 'loading' && <div className="hr-empty err">{regen}</div>}

      {/* ② 结论行：只保留“动作 + 一句话结论”，避免复盘卡堆太多分区 */}
      {r && (
        <div className={'hr-verdict tone-' + tone} onClick={() => setOpen((v) => !v)}>
          {r.stance && <span className={'hr-stance tone-' + tone}>{r.stance}</span>}
          <span className="hr-headline">{r.headline || r.stance}</span>
        </div>
      )}

      {/* ReAct 研判思路：复盘结论背后的推理链 */}
      {r && r.reasoning && (
        <div className="ai-reasoning" style={{ margin: '8px 10px 0' }}><span className="ai-reasoning-k">研判</span>{r.reasoning}</div>
      )}

      {/* ③ 下一步行动：保留核心操作指令 */}
      {r && r.nextAction && (
        <div className="hr-next compact">
          <span className="hr-next-k">下一步</span>
          <span className="hr-next-txt">{r.nextAction}</span>
        </div>
      )}

      {/* ③b 算账条：预期赚整行 hero + 短标量 chip + 仓位整句独行 —— 不截断不出血。
          持有/观望时 opQty/opAmount 为 0，经 hasVal 过滤后不渲染，避免出现迷惑的"00"。 */}
      {r && (hasVal(r.opQty) || hasVal(r.opAmount) || hasVal(r.expReturn) || hasVal(r.riskReward) || hasVal(r.posAfter)) && (
        <div className="op-calc">
          {hasVal(r.expReturn) && <div className="oc-exp"><span className="oc-k">预期收益</span><b>{r.expReturn}</b></div>}
          {(hasVal(r.opQty) || hasVal(r.opAmount) || hasVal(r.newCost) || hasVal(r.riskReward)) && (
            <div className="oc-grid">
              {hasVal(r.opQty) && <div className="oc-cell"><span className="oc-k">操作</span><b>{opText(r.opQty, r.stance)}</b></div>}
              {hasVal(r.opAmount) && <div className="oc-cell"><span className="oc-k">资金</span><b>{r.opAmount}</b></div>}
              {hasVal(r.newCost) && <div className="oc-cell"><span className="oc-k">新成本</span><b>{r.newCost}</b></div>}
              {hasVal(r.riskReward) && <div className="oc-cell"><span className="oc-k">盈亏比</span><b>{r.riskReward}</b></div>}
            </div>
          )}
          {hasVal(r.posAfter) && <div className="oc-line"><span className="oc-k">仓位</span><span>{r.posAfter}</span></div>}
        </div>
      )}

      {/* 无需操作也要明确展示，避免“持有0/观望0”这种含糊表达 */}
      {r && !hasVal(r.opQty) && !hasVal(r.opAmount) && (r.stance === '持有' || r.stance === '观望') && (
        <div className="op-calc noop-calc">
          <div className="oc-exp noop"><span className="oc-k">本次操作</span><b>无需操作</b></div>
          {hasVal(r.posAfter) && <div className="oc-line"><span className="oc-k">当前仓位</span><span>{r.posAfter}</span></div>}
          <div className="oc-line"><span className="oc-k">怎么做</span><span>{r.nextAction || r.keyLevel || '按当前仓位继续观察，等触发价或失效信号出现再动。'}</span></div>
        </div>
      )}

      {/* ④ 明细：只保留少量核心，其他细节放到个股详情页里看 */}
      {r && open && (
        <div className="hr-detail slim">
          {(r.addPrice != null || r.reducePrice != null || r.stopPrice != null) && (
            <div className="hr-prices">
              {r.addPrice != null && <span className="hr-p"><span className="hr-pk">加仓价</span><b className="red">{r.addPrice}</b></span>}
              {r.reducePrice != null && <span className="hr-p"><span className="hr-pk">减仓价</span><b className="green">{r.reducePrice}</b></span>}
              {r.stopPrice != null && <span className="hr-p"><span className="hr-pk">止损价</span><b className="green">{r.stopPrice}</b></span>}
            </div>
          )}
          {r.keyLevel && <div className="hr-row"><span className="hr-k">盯住</span><span className="hr-v">{r.keyLevel}</span></div>}
          {r.invalidation && <div className="hr-row"><span className="hr-k risk">失效</span><span className="hr-v">{r.invalidation}</span></div>}
        </div>
      )}
    </div>
  )
}

