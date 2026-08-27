import { useState, useRef, useMemo, useEffect } from 'react'
import Icon from './Icon'
import { HL } from './RichText'
import StockName from './StockName'
import StockTags from './StockTags'
import { StockNoteSummary } from './StockNote'
import StockGroupFilter from './StockGroupFilter'
import AutoRefreshStockSelector from './AutoRefreshStockSelector'
import Reasoning from './Reasoning'
import ConfirmDialog from './ConfirmDialog'
import OverlayPortal from './OverlayPortal'
import HoldingPlanDialog from './HoldingPlanDialog'
import AdviceGenerationStatus, {
  useAdviceGeneration,
  useAdviceReviewCardState,
} from './AdviceGenerationStatus'
import ExecutionQueue from './ExecutionQueue'
import { AlertForm } from './AlertCenter'
import { useMediaQuery, usePolling, useSwipe } from '../hooks'
import { callAIStream } from '../ai'
import { api } from '../apiBase'
import { planStore, usePlanStore, calcBuyFee, calcSellFee, computeTFlows, computePortfolio, sortHoldingsByProfit, livePositionOf, t1StatusOf, advicePlan, advicePlanSyncPatch } from '../planStore'
import { aiStore } from '../aiStore'
import { openStockDetail, useDetailStore } from '../detailStore'
import { getAdvice, subscribeAdvice } from '../adviceCache'
import { runBatchAdvice, subscribeBatch, getBatchState, cancelBatch, cancelOne, regenerateFailed, peekBatchBusy } from '../adviceBatch'
import { generatingList } from '../adviceGate'
import { subscribeRunner } from '../adviceRunner'
import {
  getAutoConfig,
  runManualAdviceRefresh,
  setAutoConfigSetting,
  setAutoSelectedCodes,
  K_HOLD_ENABLED,
  K_HOLD_INTERVAL,
  K_WATCH_ENABLED,
  K_WATCH_INTERVAL,
  MIN_INTERVAL,
  MAX_INTERVAL,
  DEFAULT_HOLD,
  DEFAULT_WATCH,
} from '../adviceAutoRefresh'
import { ensureQuantScore, ensureQuantScores } from '../quantScore'
import { fmtPct, pctClass, fmtNum, fmtInflow, fmtRaw, hasVal, opText, formatAdviceTime } from '../format'
import {
  computeDailyAttribution,
  computeDailyFinance,
  computeTodayOperationPnl,
  todayTradeCodes,
} from '../../shared/dailyFinance.js'
import {
  buildTActionContext,
  positionCostBasis,
  tradeActivityContext,
} from '../../shared/portfolioAccounting.js'
import {
  isContinuousTrading,
  nextTradingDayLabel,
} from '../../shared/tradingCalendar.js'
import {
  rankWatchlistCandidates,
} from '../../shared/watchlistRanking.js'
import {
  buildActionProgress,
  buildAdviceActionView,
  buildHoldingCardDecisionView,
} from '../../shared/adviceActionView.js'
import { visibleAiSources } from '../../shared/aiSearchUi.js'
import { useAiSearchConfig } from '../aiSearchConfigStore'
import { useStockTags } from '../stockTagStore'
import {
  buildStockGroups,
  filterStocksByGroup,
  selectBatchGroupCodes,
  toggleBatchGroupSelection,
} from '../../shared/stockGroupFilter.js'
import { adviceRecency } from '../../shared/adviceRecency.js'
import { selectAutoRefreshCodes } from '../../shared/adviceAutoRefreshPolicy.js'
import { stockNoteText } from '../../shared/stockNotes.js'
import { quoteDisplayState } from '../../shared/quoteDisplay.js'

const REVIEW_STATUS_ICON = Object.freeze({
  queued: 'clock',
  running: 'refresh',
  publishing: 'refresh',
  done: 'check',
  failed: 'info',
  stopped: 'close',
})

function CandidateReviewStatus({
  code,
  alerts,
  priceReached,
}) {
  const [, forceAdvice] = useState(0)
  useEffect(
    () => subscribeAdvice(() =>
      forceAdvice((value) => value + 1)
    ),
    [code],
  )
  const adviceAt = getAdvice(code, 'buy_advice')?.at
  const reviewState = useAdviceReviewCardState(
    code,
    alerts,
    { adviceAt },
  )
  const state = reviewState || (
    priceReached
      ? {
          kind: 'queued',
          label: '条件已到，预计1分钟内开始复核',
          detail: '云端定时任务每分钟扫描一次',
        }
      : null
  )
  if (!state) return null
  const spinning = ['running', 'publishing'].includes(state.kind)

  return (
    <div
      className={`pc-buyalert review-paths review-${state.kind}`}
      title={state.detail}
      aria-live="polite"
      aria-atomic="true"
      aria-busy={spinning}
    >
      <Icon
        name={REVIEW_STATUS_ICON[state.kind] || 'bell'}
        size={11}
        className={spinning ? 'spin' : ''}
      />
      <span>{state.label}</span>
    </div>
  )
}

// —— 搜索结果 → 定位到卡片:轻量模块级事件总线 ——
// 搜索框(StockSearch)、自选区(PlanList)、持仓区(HoldingList)同在本文件,用一个 Set 广播即可:
// 点击「已加/已持有」的搜索结果 → requestLocate(code) → 各区认领自己名下的 code,滚动居中并高亮。
const locateSubs = new Set()
function requestLocate(code) { if (code) locateSubs.forEach((fn) => { try { fn(code) } catch { /* ignore */ } }) }
function subscribeLocate(fn) { locateSubs.add(fn); return () => locateSubs.delete(fn) }
// 滚动到 data-code 卡片并高亮脉冲。tab 可能刚切到「全部」→ 卡片本帧才渲染,故用 rAF 等下一帧再查 DOM。
function scrollToCard(code) {
  const find = () => document.querySelector(`[data-code="${code}"]`)
  const go = (retry) => {
    const el = find()
    if (!el) { if (retry > 0) requestAnimationFrame(() => go(retry - 1)); return }
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch { el.scrollIntoView() }
    el.classList.remove('locate-flash')
    // 强制重排以便重复点击同一张卡也能重新触发动画
    void el.offsetWidth
    el.classList.add('locate-flash')
    setTimeout(() => { try { el.classList.remove('locate-flash') } catch { /* ignore */ } }, 1800)
  }
  requestAnimationFrame(() => go(8))
}

// 金额格式化（元 → 带符号，万以上转万）
function fmtMoney(v) {
  const sign = v >= 0 ? '+' : '-'
  const a = Math.abs(v)
  if (a >= 10000) return sign + (a / 10000).toFixed(2) + '万'
  return sign + a.toFixed(0)
}

function quoteSecondaryText(priceView) {
  if (!priceView) return '暂无报价'
  const pctText = priceView.pct == null
    ? ''
    : fmtPct(priceView.pct)
  return priceView.label
    ? [priceView.label, pctText].filter(Boolean).join(' ')
    : pctText
}

function QuotePrice({ quote, className = 'pc-price' }) {
  const priceView = quoteDisplayState(quote)
  const tone = (
    priceView.livePrice != null
    || priceView.status === 'AUCTION'
  ) ? pctClass(priceView.pct) : 'muted'
  return (
    <span className={`${className} ${tone}`.trim()}>
      {fmtRaw(priceView.price)}
      <span className="pc-pct">
        {quoteSecondaryText(priceView)}
      </span>
    </span>
  )
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
  const searchConfig = useAiSearchConfig()
  const tradedToday = todayTradeCodes(book.closed, book.holding)
  const codes = [...new Set([
    ...book.plan.map((x) => x.code),
    ...book.holding.map((x) => x.code),
    ...tradedToday,
  ])]
  const { data } = usePolling(
    codes.length ? `/api/quote?codes=${codes.join(',')}` : null,
    interval,
    [codes.join(',')]
  )
  const quote = {}
  ;(data?.list || []).forEach((s) => { quote[s.code] = s })
  const executionQuote = Object.fromEntries(
    codes
      .filter((code) => quote[code])
      .map((code) => {
        const livePrice = quoteDisplayState(quote[code]).livePrice
        return [
          code,
          livePrice == null
            ? { ...quote[code], price: null }
            : quote[code],
        ]
      }),
  )
  const executionQuoteKey = codes
    .map((code) => (
      `${code}:${quoteDisplayState(quote[code]).livePrice ?? ''}`
    ))
    .join('|')
  useEffect(() => {
    planStore.refreshExecutionPlans(executionQuote)
    // 只按价格变化推进 ARMED -> ALERTED，避免 store emit 形成渲染循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionQuoteKey])
  const stockTags = useStockTags(codes)
  // ===== 批量一次性生成 AI 操作建议:统一入口(军师战绩旁),勾选可跨【持仓+自选】 =====
  // 状态上提到 PlanTab,持仓区与自选区共享同一套 selectMode/selected → 只有一个入口、一条进度。
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [batchScope, setBatchScope] = useState('all')
  const [batchPinnedOnly, setBatchPinnedOnly] = useState(false)
  const [batchDimension, setBatchDimension] = useState('concept')
  const [batchGroup, setBatchGroup] = useState(() => [])
  const toggleSel = (code) => {
    setBatchPinnedOnly(false)
    setBatchGroup([])
    setSelected((prev) => {
      const nx = new Set(prev); nx.has(code) ? nx.delete(code) : nx.add(code); return nx
    })
  }
  const batchSel = {
    selectMode,
    setSelectMode,
    selected,
    setSelected,
    toggleSel,
    batchScope,
    setBatchScope,
    batchPinnedOnly,
    setBatchPinnedOnly,
    batchDimension,
    setBatchDimension,
    batchGroup,
    setBatchGroup,
  }

  return (
    <div className="plan">
      <ExecutionQueue
        plans={book.executionPlans || []}
        attributions={book.executionAttributions || []}
        onOpen={openStockDetail}
      />
      <HoldingList
        book={book}
        quote={quote}
        stockTags={stockTags}
        searchConfig={searchConfig}
        batchSel={batchSel}
      />
      <PlanList book={book} quote={quote} stockTags={stockTags} batchSel={batchSel} />
    </div>
  )
}

// ---------- 股票搜索框（自己搜、加入计划） ----------
function StockSearch() {
  const [kw, setKw] = useState('')
  const [list, setList] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const timer = useRef(null)
  const reqSeq = useRef(0)  // 防竞态：只认最新一次请求的结果

  // 真正发起搜索：名称/代码/拼音 → 后端 /api/search（真实A股+ETF+北交所数据）
  const runSearch = async (raw) => {
    const v = (raw ?? kw).trim()
    if (!v) { setList([]); setErr(''); setLoading(false); return }
    const seq = ++reqSeq.current
    setLoading(true); setErr(''); setOpen(true)
    try {
      const r = await fetch(api('/api/search?kw=' + encodeURIComponent(v))).then((x) => x.json())
      if (seq !== reqSeq.current) return  // 已有更新的请求，丢弃旧结果
      if (r && r.ok) { setList(r.list || []); setErr('') }
      else { setList([]); setErr((r && r.error) ? '搜索失败，请重试' : '搜索失败，请重试') }
    } catch {
      if (seq !== reqSeq.current) return
      setList([]); setErr('网络异常，请重试')
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }

  const onChange = (v) => {
    setKw(v); setOpen(true); setErr('')
    if (timer.current) clearTimeout(timer.current)
    if (!v.trim()) { setList([]); setLoading(false); return }
    timer.current = setTimeout(() => runSearch(v), 250)  // 输入防抖自动搜
  }
  // 回车 / 点搜索按钮：取消防抖、立即搜（用户主动触发，反馈更快）
  const submit = () => {
    if (timer.current) clearTimeout(timer.current)
    runSearch()
  }
  const pick = (s) => {
    planStore.addPlan({ code: s.code, name: s.name })
    setKw(''); setList([]); setErr(''); setOpen(false)
  }

  return (
    <div className="stock-search">
      <div className="ss-input">
        <Icon name="search" size={15} />
        <input
          value={kw} onChange={(e) => onChange(e.target.value)}
          onFocus={() => kw && setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') setOpen(false) }}
          placeholder="搜索股票名称、代码或拼音…"
        />
        <button className="ss-btn" onClick={submit} disabled={loading} title="搜索">
          {loading ? <span className="ss-spin" /> : <Icon name="search" size={14} />}
          <span className="ss-btn-txt">搜索</span>
        </button>
      </div>
      {open && kw.trim() && (
        <div className="ss-dropdown">
          {loading && list.length === 0 && <div className="ss-hint">搜索中…</div>}
          {!loading && err && <div className="ss-hint err">{err}</div>}
          {!loading && !err && list.length === 0 && <div className="ss-hint">没有匹配的股票，换个名称/代码试试</div>}
          {list.map((s) => {
            const added = planStore.has(s.code)
            const held = (planStore.get().holding || []).some((x) => x.code === s.code)
            const inBook = added || held
            // 已加入/已持有 → 点击不再是「加入」,而是定位到已有卡片(自选多了也能秒找到)
            const onItem = () => {
              if (inBook) { requestLocate(s.code); setOpen(false) }
              else pick(s)
            }
            return (
              <button type="button" className={'ss-item' + (inBook ? ' locatable' : '')} key={s.code} onClick={onItem}
                title={inBook ? '点击定位到已有卡片' : '点击加入自选'}>
                <span className="ss-name">
                  <StockName
                    code={s.code}
                    name={s.name}
                    interactive={false}
                  />
                </span>
                <span className="ss-type">{s.type}</span>
                {inBook
                  ? <span className="ss-add locate"><Icon name="target" size={13} />{held ? '已持有 · 定位' : '已加 · 定位'}</span>
                  : <span className="ss-add"><Icon name="plus" size={13} />加入</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------- 量化得分徽标（自选卡 / 持仓卡通用）----------
// 分数来源:qlib 量化服务(LightGBM达标概率+GARCH)。>=62 偏多(红) / <=38 偏空(绿) / 其余中性(金)。
// 未评分(qScore==null)时占位「评分中」,由卡片挂载时的 ensureQuantScore 触发补分后自动回填。
function quantTone(s) { return s == null ? 'muted' : s >= 62 ? 'red' : s <= 38 ? 'green' : 'gold' }
function QuantBadge({ score, bias, size }) {
  const tone = quantTone(score)
  const scored = score != null && !isNaN(score)
  return (
    <span className={'q-badge ' + tone + (size ? ` ${size}` : '')}
      title={scored ? `量化得分 ${score}（${bias || (tone === 'red' ? '偏多' : tone === 'green' ? '偏空' : '中性')}）· LightGBM+GARCH，统计口径非投资建议` : '正在计算量化得分…'}>
      <span className="q-badge-k">量化</span>
      {scored ? <b className="q-badge-v">{Math.round(score)}</b> : <span className="q-badge-load" />}
    </span>
  )
}

function AdviceUpdatedAt({ entry, score, bias }) {
  const label = formatAdviceTime(entry && entry.at)
  const recency = adviceRecency(entry && entry.at)
  if (!label || !recency) return null
  return (
    <div className="advice-updated-at" data-recency={recency.tone} title={`最近一次军师操作建议生成于 ${new Date(entry.at).toLocaleString('zh-CN')}`}>
      <Icon name="history" size={11} />
      <span>最近生成</span>
      <strong>{recency.label}</strong>
      {recency.tone === 'fresh' && (
        <time dateTime={new Date(entry.at).toISOString()}>{label}</time>
      )}
      <QuantBadge score={score} bias={bias} size="auxiliary" />
    </div>
  )
}

function MarketPulse({ quote }) {
  if (!quote) return null
  return (
    <div className="trade-card-pulse" role="group" aria-label="盘面证据">
      <span>
        <em>换手</em>
        <b className={quote.turnover > 10 ? 'gold' : ''}>
          {Number.isFinite(Number(quote.turnover))
            ? `${fmtNum(quote.turnover, 1)}%`
            : '--'}
        </b>
      </span>
      <span>
        <em>量比</em>
        <b className={quote.volRatio > 2 ? 'gold' : ''}>
          {fmtNum(quote.volRatio, 1)}
        </b>
      </span>
      <span>
        <em>主力</em>
        <b className={pctClass(quote.mainInflow)}>
          {fmtInflow(quote.mainInflow)}
        </b>
      </span>
      <span title="散户资金（小单净流入）">
        <em>散户</em>
        <b className={pctClass(quote.retailInflow)}>
          {fmtInflow(quote.retailInflow)}
        </b>
      </span>
    </div>
  )
}

const roundActionPrice = (value) => (
  value == null || isNaN(value)
    ? null
    : Number(value) < 10
      ? +Number(value).toFixed(3)
      : +Number(value).toFixed(2)
)

const actionHands = (value) => {
  const match = String(value ?? '').match(/\d+(?:\.\d+)?/)
  if (!match) return null
  const number = Math.trunc(Number(match[0]))
  return Number.isFinite(number) && number > 0 ? number : null
}

const actionQtyLabel = (value) => {
  const hands = actionHands(value)
  return hands ? `${hands}手` : ''
}

const actionTone = (kind) => (
  kind === 'buy' || kind === 'add'
    ? 'buy'
    : kind === 'reduce' || kind === 'sell'
      ? 'sell'
      : kind === 'wait'
        ? 'wait'
        : 'hold'
)

const actionLevelIcon = (level) => {
  if (
    level.key === 'reduce'
    || level.key === 'target'
    || level.key === 'holding_add_breakout'
  ) return 'arrowUp'
  if (level.key === 'stop') return 'shield'
  if (level.key === 'watch') return 'eye'
  return 'arrowDown'
}

const reachedLevelKey = (view, progress) => {
  if (!progress?.reached) return ''
  if (progress.reachedKey) return progress.reachedKey
  if (view.trigger?.direction === 'range') {
    if (progress.currentPrice < view.trigger.low) {
      return view.trigger.lowKey || 'add'
    }
    if (progress.currentPrice > view.trigger.high) {
      return view.trigger.highKey || 'reduce'
    }
    return ''
  }
  return view.levels.find((item) => item.active)?.key || ''
}

function ActionProgress({ trigger, currentPrice, progress: preparedProgress }) {
  if (!trigger) return null
  if (trigger.direction === 'inactive') {
    return (
      <div className="action-progress inactive">
        <div className="action-progress-summary">
          <span className="action-direction">
            <Icon name="activity" size={13} />
            {trigger.stateLabel || '保持观望'}
          </span>
          <span className="action-current-marker">
            {trigger.detailLabel || '等待量价确认'}
          </span>
          <b className="action-progress-target">{trigger.metricLabel}</b>
        </div>
      </div>
    )
  }
  const progress = preparedProgress || buildActionProgress(trigger, currentPrice)
  if (!progress) return null
  const directionIcon = trigger.direction === 'gte'
    ? 'arrowUp'
    : trigger.direction === 'lte'
      ? 'arrowDown'
      : 'activity'
  const targetText = trigger.direction === 'range'
    ? `${fmtRaw(trigger.low)}–${fmtRaw(trigger.high)}`
    : trigger.direction === 'review_paths'
      ? trigger.paths
          .map((path) =>
            `${path.direction === 'LTE' ? '回踩' : '突破'}${fmtRaw(path.price)}`
          )
          .join(' / ')
      : `${trigger.label} ${fmtRaw(trigger.price)}`
  if (progress.reached) {
    return (
      <div
        className={'action-trigger-state ' + progress.tone}
        role="status"
        aria-live="polite"
      >
        <span className="action-trigger-label">
          <Icon name="bell" size={12} />
          {trigger.direction === 'lte'
            ? '买入条件已触发'
            : trigger.direction === 'gte'
              ? '卖出条件已触发'
              : progress.stateLabel}
        </span>
        <strong>{targetText}</strong>
        <span>
          {progress.reachedHint
            || (
              trigger.direction === 'review_paths'
                ? '等待自动复核'
                : '等待人工确认'
            )}
        </span>
      </div>
    )
  }
  return (
    <div className={'action-progress ' + progress.tone}>
      <div className="action-progress-summary">
        <span className="action-direction">
          <Icon name={directionIcon} size={13} />
          {progress.stateLabel}
        </span>
        <span className="action-current-marker">{progress.label}</span>
        <b className="action-progress-target">{targetText}</b>
      </div>
      <div className="action-progress-track">
        <div className="action-progress-fill" style={{ width: progress.pct + '%' }} />
      </div>
    </div>
  )
}

function ActionLevel({ level, reached = false }) {
  return (
    <div className={'action-level level-' + level.tone + (level.active ? ' active' : '') + (reached ? ' reached' : '')}>
      <span className="action-level-name">
        <span className="action-level-icon"><Icon name={actionLevelIcon(level)} size={13} /></span>
        {level.label}
      </span>
      <strong className="action-level-price">{fmtRaw(level.price)}</strong>
      {level.basisLabel && (
        <span className="action-level-basis">{level.basisLabel}</span>
      )}
    </div>
  )
}

function EmptyActionLevels() {
  return (
    <div className="action-levels-empty" aria-label="关键价位等待信号确认">
      <Icon name="target" size={13} />
      <span>关键价位</span>
      <strong>等待信号确认</strong>
    </div>
  )
}

function ActionCommand({ view, onOpen }) {
  const instruction = view.instruction || '等待下一步执行条件'
  const quantity =
    view.quantityLabel || actionQtyLabel(view.quantity)

  return (
    <button
      type="button"
      className="action-command"
      title="查看完整建议"
      onClick={onOpen}
    >
      <span className="action-command-body">
        <span className="action-command-meta">
          {view.commandLabel || '当前指令'}
          {view.shortHorizon && <em>{view.shortHorizon}</em>}
        </span>
        <strong className="action-command-primary">
          {view.action}
          {quantity && <span className="action-command-qty">{quantity}</span>}
        </strong>
        <span className="action-command-text" title={instruction}>
          {instruction}
        </span>
      </span>
    </button>
  )
}

function AdviceActionPanel({ view, currentPrice, onPrompt }) {
  if (!view) {
    return (
      <button type="button" className="action-prompt" onClick={onPrompt} aria-label="生成操作建议">
        <Icon name="spark" size={14} />
        <span className="action-prompt-label">尚无操作建议</span>
        <span className="action-prompt-action">生成</span>
        <Icon name="chevronRight" size={14} />
      </button>
    )
  }
  const tone = view.displayTone || actionTone(view.kind)
  const progress = buildActionProgress(view.trigger, currentPrice)
  const reachedKey = reachedLevelKey(view, progress)
  return (
    <div className={'action-decision tone-' + tone}>
      <ActionCommand view={view} onOpen={onPrompt} />
      {view.levels.length > 0 && (
        <div className={'action-levels levels-' + Math.min(view.levels.length, 3)}>
          {view.levels.map((item) => (
            <ActionLevel key={item.key} level={item} reached={item.key === reachedKey} />
          ))}
        </div>
      )}
      {view.levels.length === 0 && view.kind !== 'wait' && (
        <EmptyActionLevels />
      )}
      <ActionProgress trigger={view.trigger} currentPrice={currentPrice} progress={progress} />
    </div>
  )
}

// 候选卡的动作、价位、手数和进度只由同一份 AI 建议驱动。
// 观望时撤下买入控件与旧买点进度，只显示不可执行状态和完整文字条件。
function CandDecision({ p, q }) {
  const [, force] = useState(0)
  useEffect(() => subscribeAdvice(() => force((n) => n + 1)), [])
  const generation = useAdviceGeneration(p.code)
  const entry = getAdvice(p.code, 'buy_advice')
  const advice = entry?.advice || null
  const hasAdvice = !!advice
  const executionOpen = isContinuousTrading(Date.now())
  const livePrice = quoteDisplayState(q).livePrice
  const baseView = advice
    ? buildAdviceActionView(advice, {
        mode: 'buy_advice',
        currentPrice: livePrice,
        executionOpen,
      })
    : null
  const actionable = baseView?.kind === 'buy'
    && baseView.actionable !== false
  const contractEntry = baseView?.levels.find(
    (level) => level.key === 'entry',
  )
  const aiPrice = actionable
    ? roundActionPrice(contractEntry?.price)
    : null
  const aiQty = actionable
    ? actionHands(advice?.planQtyNum ?? advice?.planQty)
    : null
  const hasSystemBuyAlert = planStore.get().alerts
    .some((alert) => alert.candCode === p.code)

  useEffect(() => {
    const patch = {}
    if (!p.targetManual) {
      const nextPrice = actionable ? aiPrice : null
      if (roundActionPrice(p.targetPrice) !== nextPrice) patch.targetPrice = nextPrice
    }
    if (!p.qtyManual) {
      const nextQty = actionable ? aiQty : null
      if ((p.buyQty ?? null) !== nextQty) patch.buyQty = nextQty
    }
    if (Object.keys(patch).length) planStore.setCandPlan(p.code, patch)
    planStore.autoSyncCandAlert(
      p.code,
      p.name,
      advice,
      entry?.at,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entry?.at,
    hasAdvice,
    actionable,
    aiPrice,
    aiQty,
    p.targetManual,
    p.qtyManual,
    p.targetPrice,
    p.buyQty,
    p.alertSyncedPrice,
    hasSystemBuyAlert,
  ])

  const target = p.targetPrice != null
    ? Number(p.targetPrice)
    : aiPrice
  const qty = p.buyQty != null ? p.buyQty : aiQty
  const view = advice
    ? buildAdviceActionView({
        ...advice,
        ...(actionable ? { buyPrice: target, planQty: qty } : {}),
      }, {
        mode: 'buy_advice',
        currentPrice: livePrice,
        executionOpen,
      })
    : null
  const progress = view?.trigger
  const progressState = buildActionProgress(progress, livePrice)
  const reachedKey = view ? reachedLevelKey(view, progressState) : ''
  const otherLevels = view?.levels.filter((item) => item.key !== 'entry') || []

  const onPrice = (event) => {
    const value = event.target.value.trim()
    if (value === '') {
      planStore.setCandPlan(p.code, { targetPrice: aiPrice, targetManual: false })
    } else if (!isNaN(Number(value))) {
      planStore.setCandPlan(p.code, { targetPrice: Number(value), targetManual: true })
    }
  }
  const onQty = (event) => {
    const value = event.target.value.trim()
    if (value === '') {
      planStore.setCandPlan(p.code, { buyQty: aiQty, qtyManual: false })
    } else if (!isNaN(Number(value))) {
      planStore.setCandPlan(p.code, {
        buyQty: Math.max(0, Math.trunc(Number(value))),
        qtyManual: true,
      })
    }
  }

  return (
    <div className="card-decision-slot">
      {!view ? (
        !generation?.active && (
          <AdviceActionPanel
            onPrompt={() => openStockDetail(p.code, q?.name || p.name)}
          />
        )
      ) : (
        <div
          className={
            'action-decision cand-decision tone-'
            + (view.displayTone || actionTone(view.kind))
          }
        >
          <ActionCommand
            view={view}
            onOpen={() => openStockDetail(p.code, q?.name || p.name)}
          />
          {actionable ? (
            <>
              <div className="action-levels editable">
                <label className={'action-level action-field active level-buy' + (reachedKey === 'entry' ? ' reached' : '')}>
                  <span className="action-level-name">
                    <span className="action-level-icon"><Icon name="arrowDown" size={13} /></span>
                      买入价
                  </span>
                  <input
                    className="action-level-price"
                    inputMode="decimal"
                    placeholder={aiPrice != null ? String(aiPrice) : '手填'}
                    value={p.targetPrice != null ? String(p.targetPrice) : ''}
                    onChange={onPrice}
                  />
                  {(reachedKey === 'entry' || p.targetManual) && (
                    <em className="action-level-source">
                      {reachedKey === 'entry' ? '已触发' : '手填'}
                    </em>
                  )}
                  {!p.targetManual && contractEntry?.basisLabel && (
                    <span className="action-level-basis">
                      来源：{contractEntry.basisLabel}
                    </span>
                  )}
                </label>
                <label className="action-level action-field active level-buy">
                  <span className="action-level-name">
                    <span className="action-level-icon"><Icon name="cart" size={13} /></span>
                      买入手数
                  </span>
                  <input
                    className="action-level-price"
                    inputMode="numeric"
                    placeholder={aiQty != null ? String(aiQty) : '手'}
                    value={p.buyQty != null ? String(p.buyQty) : ''}
                    onChange={onQty}
                  />
                  {p.qtyManual && (
                    <em className="action-level-source">手填</em>
                  )}
                </label>
                {otherLevels.map((item) => (
                  <ActionLevel key={item.key} level={item} reached={item.key === reachedKey} />
                ))}
              </div>
              <ActionProgress trigger={progress} currentPrice={livePrice} progress={progressState} />
            </>
          ) : (
            <>
              {view.levels.length > 0 ? (
                <div className={'action-levels levels-' + Math.min(view.levels.length, 3)}>
                  {view.levels.map((item) => (
                    <ActionLevel key={item.key} level={item} reached={item.key === reachedKey} />
                  ))}
                </div>
              ) : view.kind !== 'wait' ? (
                <EmptyActionLevels />
              ) : null}
              <ActionProgress trigger={progress} currentPrice={livePrice} progress={progressState} />
            </>
          )}
        </div>
      )}
      <div className="card-decision-meta">
        <AdviceUpdatedAt
          entry={entry}
          score={p.qScore}
          bias={p.qBias}
        />
        {generation?.active && (
          <AdviceGenerationStatus code={p.code} />
        )}
      </div>
    </div>
  )
}

function CandidateActions({ p, q, onBuy, onAlert, onDelete }) {
  const [, force] = useState(0)
  useEffect(() => subscribeAdvice(() => force((n) => n + 1)), [])
  const entry = getAdvice(p.code, 'buy_advice')
  const executionOpen = isContinuousTrading(Date.now())
  const livePrice = quoteDisplayState(q).livePrice
  const baseView = entry?.advice
    ? buildAdviceActionView(entry.advice, {
        mode: 'buy_advice',
        currentPrice: livePrice,
        executionOpen,
      })
    : null
  const view = baseView?.kind === 'buy'
    ? buildAdviceActionView({
        ...entry.advice,
        buyPrice: p.targetPrice ?? entry.advice.buyPrice,
        planQty: p.buyQty ?? entry.advice.planQty,
      }, {
        mode: 'buy_advice',
        currentPrice: livePrice,
        executionOpen,
      })
    : baseView
  const actionable = !view
    || (view.kind === 'buy' && view.actionable !== false)
  return (
    <div
      className={
        'pc-actions'
        + (!actionable ? ' with-review' : '')
        + (view?.deferred ? ' deferred' : '')
      }
    >
      <button
        type="button"
        className="chip-btn act-buy manual-build"
        title="自主填写买入价和手数，仅记录人工成交"
        onClick={() => onBuy(p, null)}
      >
        <Icon name="cart" size={12} />
        手动建仓
      </button>
      {!actionable && (view?.deferred ? (
        <button
          type="button"
          className="chip-btn ghost review-action"
          onClick={() => openStockDetail(p.code, q?.name || p.name)}
        >
          <Icon name="clock" size={12} />
          {view?.detailActionLabel || '查看后续预案'}
        </button>
      ) : (
        <button
          type="button"
          className="chip-btn ghost review-action"
          onClick={() => openStockDetail(p.code, q?.name || p.name)}
        >
          <Icon name="spark" size={12} />重新评估
        </button>
      ))}
      <button className="chip-btn ghost pc-alert-action" onClick={onAlert}><Icon name="bell" size={12} />预警</button>
      <button className="icon-btn" aria-label={`删除${q?.name || p.name}`} title="删除" onClick={onDelete}><Icon name="trash" size={13} /></button>
    </div>
  )
}

// ---------- 自选 / 候选（合并自选监控 + 计划买入）----------
function PlanList({ book, quote, stockTags, batchSel }) {
  const [buying, setBuying] = useState(null) // code
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('1')
  const [buyErr, setBuyErr] = useState('')
  const [delTarget, setDelTarget] = useState(null) // 待删除的候选 {code,name}
  const [alerting, setAlerting] = useState(null) // 正在设预警的 code
  const [dimension, setDimension] = useState('concept')
  const [tab, setTab] = useState('全部')
  const [adviceVersion, setAdviceVersion] = useState(0)
  useEffect(
    () => subscribeAdvice(() => setAdviceVersion((value) => value + 1)),
    [],
  )

  // ===== 批量一次性生成:入口/工具条/进度条统一收敛到「持仓区(军师战绩旁)」。=====
  // 这里只消费上提到 PlanTab 的共享勾选状态,给候选卡渲染复选框;不再自带入口与进度。
  const { selectMode, selected, toggleSel } = batchSel

  const startBuy = (stock, view) => {
    const entry = view?.levels.find((item) => item.active)?.price
    const suggestedQty = actionHands(view?.quantity)
    setBuying(stock.code)
    setBuyErr('')
    const displayPrice = quoteDisplayState(quote[stock.code]).price
    setPrice(entry != null
      ? String(entry)
      : displayPrice != null ? String(displayPrice) : '')
    setQty(String(suggestedQty || 1))
  }
  const confirmBuy = (code) => {
    if (!price || !(Number(qty) > 0)) return
    const result = planStore.buy(code, price, Number(qty))
    if (!result?.ok) {
      setBuyErr(result?.error || '建仓记录失败')
      return
    }
    setBuying(null)
    setPrice('')
    setQty('1')
    setBuyErr('')
  }

  // 单张候选卡
  const Card = (p) => {
    const q = quote[p.code]
    const priceView = quoteDisplayState(q)
    const checked = selected.has(p.code)
    const stockNote = stockNoteText(book.stockNotes, p.code)
    return (
      <div className={'trade-card plan-cand' + (p.star ? ' starred' : '') + (selectMode ? ' selectable' : '') + (checked ? ' sel-on' : '')}
        key={p.code}
        data-code={p.code}
        onClickCapture={selectMode ? (e) => { e.stopPropagation(); toggleSel(p.code) } : undefined}>
        {/* 勾选模式:左上角复选框(点整卡即可切换;捕获阶段拦截,屏蔽卡内其它交互) */}
        {selectMode && (
          <span className={'pc-check' + (checked ? ' on' : '')} title={checked ? '取消选择' : '选择此股'}>
            <Icon name={checked ? 'checkSquare' : 'square'} size={16} />
          </span>
        )}
        {/* 顶行：左=股名/代码/标签，右=现价；量化分跟随建议生成信息显示。 */}
        <div className="pc-top">
          <div className="pc-name">
            <StockName
              code={p.code}
              name={(q && q.name) || p.name}
              industry={(q && q.industry) || p.industry}
            >
              <span className="pc-nm">{(q && q.name) || p.name}</span>
            </StockName>
            {/^(300|301)/.test(String(p.code)) && <span className="tag tag-cy" title="创业板(涨跌幅±20%)">创</span>}
            {String(p.code).startsWith('688') && <span className="tag tag-kc" title="科创板(涨跌幅±20%、门槛更高)">科创板</span>}
            {q && q.isLimitUp && <span className="tag tag-lu">涨停</span>}
          </div>
          <div className="pc-top-r">
            {q && (
              <QuotePrice
                quote={q}
                className="pc-price"
              />
            )}
          </div>
          <button
            className={'pc-pin' + (p.star ? ' on' : '')}
            type="button"
            aria-label={p.star ? `取消置顶${p.name}` : `置顶${p.name}`}
            aria-pressed={p.star === true}
            title={p.star ? '取消置顶重点关注' : '置顶重点关注（按量化分排序）'}
            onClick={() => planStore.toggleStar(p.code)}
          >
            <Icon name={p.star ? 'starFill' : 'star'} size={13} />
          </button>
        </div>
        {/* 主指令优先；盘面指标只作为次级证据。 */}
        <CandDecision p={p} q={q} />
        <MarketPulse quote={q} />
        {/* 卡片只展示观察复核提醒；可执行买点已在上方指令区统一表达。 */}
        {(() => {
          const stockAlerts = (book.alerts || []).filter(
            (alert) => alert.candCode === p.code,
          )
          const reviewAlerts = stockAlerts.filter(
            (alert) => alert.reviewOnly,
          )
          const executionOpen = isContinuousTrading(Date.now())
          const reached = (alert) =>
            executionOpen && priceView.livePrice != null && (
              alert.op === 'gte'
                ? priceView.livePrice >= alert.value
                : priceView.livePrice <= alert.value
            )
          const anyReached = reviewAlerts.some((alert) =>
            alert.enabled && reached(alert)
          )
          return (
            <CandidateReviewStatus
              code={p.code}
              alerts={reviewAlerts}
              priceReached={anyReached}
            />
          )
        })()}
        <StockNoteSummary
          code={p.code}
          name={q?.name || p.name}
          text={stockNote}
          onOpen={() => openStockDetail(
            p.code,
            q?.name || p.name,
            { focusNote: true },
          )}
        />
        {buying === p.code ? (
          <div className="buy-inline-wrap">
            <div className="buy-inline">
              <input className="wl-input" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="买入价" />
              <input className="wl-input" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="手" />
              {price && Number(qty) > 0 && <span className="fee-hint">费≈{calcBuyFee(Number(price) * Number(qty) * 100).toFixed(0)}</span>}
              {buyErr && <span className="err buy-inline-error">{buyErr}</span>}
              <button className="chip-btn act-buy solid" onClick={() => confirmBuy(p.code)}><Icon name="check" size={12} />确认</button>
              <button className="chip-btn ghost" onClick={() => setBuying(null)}>取消</button>
            </div>
          </div>
        ) : alerting === p.code ? (
          <div className="pc-alert-box">
            <AlertForm stock={{ code: p.code, name: (q && q.name) || p.name }} onDone={() => setAlerting(null)} />
            <button className="chip-btn ghost" style={{ marginTop: 6 }} onClick={() => setAlerting(null)}>收起</button>
          </div>
        ) : (
          <CandidateActions
            p={p}
            q={q}
            onBuy={startBuy}
            onAlert={() => setAlerting(p.code)}
            onDelete={() => setDelTarget(p)}
          />
        )}
      </div>
    )
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

  // 量化评分:自选列表变化时,给「尚无量化得分」的候选按需补分(ensureQuantScore 内部去重/防冷启动风暴)。
  // 加入自选(addPlan)后该候选无 qScore → 这里立刻触发评分,拿到分数后 setQuantScore 回写 → 卡片自动排序/展示。
  useEffect(() => {
    const codes = (book.plan || []).filter((p) => p.qScore == null).map((p) => p.code)
    if (codes.length) ensureQuantScores(codes)
    // eslint-disable-next-line
  }, [book.plan.map((p) => p.code).join(',')])

  const groups = useMemo(() => buildStockGroups(book.plan, {
    dimension,
    tagMap: stockTags,
    quoteMap: quote,
  }), [book.plan, dimension, stockTags, quote])
  const tagsLoading = dimension === 'concept'
    && (book.plan || []).some((item) => stockTags[item.code] == null)
  const filteredCandidates = useMemo(
    () => filterStocksByGroup(book.plan, tab, {
      dimension,
      tagMap: stockTags,
      quoteMap: quote,
    }),
    [book.plan, tab, dimension, stockTags, quote],
  )
  const adviceByCode = useMemo(
    () => Object.fromEntries(filteredCandidates.map((candidate) => [
      candidate.code,
      getAdvice(candidate.code, 'buy_advice'),
    ])),
    [filteredCandidates, adviceVersion],
  )
  const shown = useMemo(
    () => rankWatchlistCandidates(
      filteredCandidates,
      quote,
      adviceByCode,
    ),
    [filteredCandidates, quote, adviceByCode],
  )
  // 当前胶囊可能因删票或切换维度失效 → 回退到全部。
  useEffect(() => {
    if (tab !== '全部' && !groups.some((group) => group.name === tab)) setTab('全部')
    // eslint-disable-next-line
  }, [groups])

  // 搜索结果「定位」:命中本区(自选/候选)名下的 code → 先切回「全部」保证卡片被渲染,再滚动+高亮
  useEffect(() => subscribeLocate((code) => {
    if (!(book.plan || []).some((p) => p.code === code)) return
    setTab('全部')
    scrollToCard(code)
  }), [book.plan])

  return (
    <section className="panel plan-section plan-section-watch">
      <div className="plan-section-sticky">
        <div className="panel-head plan-head">
          <div role="heading" aria-level="2" className="panel-title"><Icon name="eye" size={16} /> 自选 / 候选 <span className="sub-name">{book.plan.length} 只 · 置顶优先，再按建议档位排序</span></div>
          <div className="plan-head-r">
            <div className="plan-search"><StockSearch /></div>
          </div>
        </div>
        {book.plan.length > 0 && (
          <StockGroupFilter
            dimension={dimension}
            onDimensionChange={(next) => { setDimension(next); setTab('全部') }}
            groups={groups}
            active={tab}
            onActiveChange={setTab}
            total={[...new Set(book.plan.map((item) => item.code))].length}
            loading={tagsLoading}
          />
        )}
      </div>

      {book.plan.length === 0 ? (
        <div className="empty small">搜索股票加入自选，或在「今日选股」点「加自选」。这里实时盯盘资金/量比，并按概念或行业分类；点每张卡左上的星标可置顶重点关注。</div>
      ) : (
        <>
          {/* 当前 tab：重点关注置顶，其余按量化55% + 买点接近度45%排序 */}
          <div className="plan-cand-grid">{shown.map(Card)}</div>
        </>
      )}
      {delTarget && (
        <ConfirmDialog
          title="从自选中删除？"
          body={<>确定把 <b>{delTarget.name}</b>（{delTarget.code}）<StockTags code={delTarget.code} variant="inline" /> 从自选 / 候选中移除？此操作不影响你已有的持仓和交易记录。</>}
          confirmText="删除"
          onConfirm={() => { planStore.removePlan(delTarget.code); setDelTarget(null) }}
          onCancel={() => setDelTarget(null)}
        />
      )}
    </section>
  )
}
// ---------- 军师战绩：AI建议真实胜率(事后回测统计) ----------
const ADVICE_MODE_LABEL = {
  hold_advice: '持仓建议', buy_advice: '买入建议', t_advice: '做T建议',
  price: '目标价', plan: '交易计划', review: '复盘', other: '其他',
}
function AdvisorScore({ book }) {
  const [open, setOpen] = useState(false)
  const stats = planStore.adviceStats()
  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open])
  if (!stats || (stats.total === 0 && stats.pending === 0)) return null
  const wr = stats.winRate
  const tone = wr == null ? 'muted' : wr >= 55 ? 'red' : wr >= 45 ? 'gold' : 'green'
  const groups = (stats.groups || []).filter((g) => g.total > 0).sort((a, b) => b.total - a.total)
  const actionGroups = (stats.actions || []).filter((g) => g.total > 0).sort((a, b) => b.total - a.total)
  const theory = planStore.theoryStats()
  const theoryGroups = (theory && theory.groups || []).filter((g) => g.total > 0)
  return (
    <div className="advisor-score-wrap">
      <button
        className="advisor-score"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="点击查看军师战绩的详细口径与分类命中率"
      >
        <Icon name="target" size={13} />
        <span className="as-k">军师战绩</span>
        {wr != null
          ? <><span className={'as-wr ' + tone}>{wr}%</span><span className="as-sub">独立回合 · {stats.total}次已验</span></>
          : <span className="as-sub">积累中 · {stats.pending}次待验</span>}
        <Icon name={open ? 'arrowUp' : 'chevronDown'} size={12} />
      </button>
      {open && (
        <OverlayPortal>
          <div className="advisor-score-mask" onClick={() => setOpen(false)}>
            <div
              className="advisor-pop advisor-score-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="advisor-score-title"
              onClick={(event) => event.stopPropagation()}
            >
          <div className="ap-title" id="advisor-score-title">
            <Icon name="target" size={13} />
            <span>军师战绩怎么看</span>
            <button type="button" className="modal-close" aria-label="关闭军师战绩" onClick={() => setOpen(false)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <p className="ap-desc">
            这是<b>独立决策回合命中率</b>，不是账户真实成交胜率；同股同一主计划的重复刷新只计一次。
            买入/加仓看 3 日内是否触及目标
            （无目标时看最大涨幅是否≥2%）；继续持有看是否有效跌破止损、期末回撤是否超过3%；
            减仓/清仓与观望看后续是否避免明显上涨。旧口径记录会自动重算。
          </p>
          {wr != null ? (
            <>
              <div className="ap-hero">
                <span className={'ap-wr ' + tone}>{wr}%</span>
                <div className="ap-hero-r">
                  <span>独立决策回合命中率</span>
                  <span className="muted">{stats.hit}/{stats.total} 命中 · 平均结果 {stats.avgPct >= 0 ? '+' : ''}{stats.avgPct}%</span>
                </div>
              </div>
              <div className="ap-rows">
                {groups.map((g) => (
                  <div className="ap-row" key={g.mode}>
                    <span className="ap-mode">{ADVICE_MODE_LABEL[g.mode] || g.mode}</span>
                    <span className={'ap-rate ' + (g.winRate >= 55 ? 'red' : g.winRate >= 45 ? 'gold' : 'green')}>
                      {g.winRate}%
                    </span>
                    <span className="ap-cnt muted">{g.hit}/{g.total} · 均{g.avgPct >= 0 ? '+' : ''}{g.avgPct}%</span>
                  </div>
                ))}
              </div>
              {actionGroups.length > 0 && (
                <div className="ap-theory">
                  <div className="ap-subtitle"><Icon name="gauge" size={12} /> 按动作拆分</div>
                  <div className="ap-rows">
                    {actionGroups.map((g) => (
                      <div className="ap-row" key={g.kind}>
                        <span className="ap-mode theory">{g.label}</span>
                        <span className={'ap-rate ' + (g.winRate >= 55 ? 'red' : g.winRate >= 45 ? 'gold' : 'green')}>
                          {g.winRate}%
                        </span>
                        <span className="ap-cnt muted">{g.hit}/{g.total} · 均{g.avgPct >= 0 ? '+' : ''}{g.avgPct}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {theoryGroups.length > 0 && (
                <div className="ap-theory">
                  <div className="ap-subtitle"><Icon name="spark" size={12} /> 实际采用理论的建议归因 <span className="muted">（至少8次才用于校准）</span></div>
                  <div className="ap-rows">
                    {theoryGroups.map((g) => (
                      <div className="ap-row" key={g.theory}>
                        <span className="ap-mode theory">{g.theory}</span>
                        <span className={'ap-rate ' + (g.total < 8 ? 'muted' : g.winRate >= 55 ? 'red' : g.winRate >= 45 ? 'gold' : 'green')}>
                          {g.total < 8 ? '样本不足' : `${g.winRate}%`}
                        </span>
                        <span className="ap-cnt muted">{g.hit}/{g.total} · 均{g.avgPct >= 0 ? '+' : ''}{g.avgPct}%</span>
                      </div>
                    ))}
                  </div>
                  <p className="ap-desc muted" style={{ marginTop: 6 }}>
                    仅统计建议正文 theoryNote 实际采用2至3个理论，6条检索候选不计入。
                    这里是相关性归因，不是理论本身的独立因果检验；样本达到8次后才用于军师校准。
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="ap-desc muted">还没有满 3 个交易日的样本，正在积累中（{stats.pending} 条待验证）。</p>
          )}
          <p className="ap-foot muted">
            {stats.pending > 0 && `${stats.pending} 条独立回合未满窗口，暂不计入。`}
            {stats.duplicateRefreshes > 0 && ` 已合并 ${stats.duplicateRefreshes} 条重复刷新；原始刷新样本 ${stats.raw?.total || 0} 条。`}
            样本越多越可信；胜率高≠稳赚，仓位与止损纪律仍是第一位。
          </p>
            </div>
          </div>
        </OverlayPortal>
      )}
    </div>
  )
}

// 单笔持仓的"含费成本 / 浮盈% / 紧急度"轻量测算（列表级排序用，只依赖实时报价）
// urgency：数值越大越该先处理。止损触及/破8%纪律 > 止盈触及 > 常规
function holdSnapshot(h, q) {
  const costWithFee = positionCostBasis(h).costWithFees ?? h.buyPrice
  const quoteView = quoteDisplayState(q)
  // 盈亏可用最近有效价；止盈止损与紧急度只认连续竞价实时价。
  const px = quoteView.livePrice
  const effPx = quoteView.price
  const pnl = effPx != null && costWithFee ? +(((effPx - costWithFee) / costWithFee) * 100).toFixed(2) : null
  const hitTP = px != null && h.tp && px >= Number(h.tp)
  const hitSL = px != null && h.sl && px <= Number(h.sl)
  let urgency = 0, flag = null
  if (hitSL) { urgency = 100; flag = { tone: 'green', text: '触止损' } }
  else if (pnl != null && pnl <= -8) { urgency = 95; flag = { tone: 'green', text: '破8%纪律' } }
  else if (hitTP) { urgency = 80; flag = { tone: 'red', text: '触止盈' } }
  else if (pnl != null && pnl <= -5) { urgency = 40; flag = { tone: 'green', text: '浮亏' } }
  return { costWithFee, pnl, hitTP, hitSL, urgency, flag }
}

// ---------- 持仓作战总览条：总浮盈亏 / 今日操作盈亏 / 仓位 / 需立即处理 ----------
function HoldOverview({ book, quote }) {
  const holding = book.holding || []
  const pf = computePortfolio(holding, quote, book.account)
  const daily = computeDailyFinance({
    holdings: holding,
    trades: book.closed || [],
    quoteMap: quote,
  })
  const attribution = computeDailyAttribution({
    holdings: holding,
    trades: book.closed || [],
    quoteMap: quote,
  })
  const operationPnl = computeTodayOperationPnl({
    holdings: holding,
    trades: book.closed || [],
  })
  const [showAttribution, setShowAttribution] = useState(false)
  const [showOperationPnl, setShowOperationPnl] = useState(false)
  // 需立即处理的只数(触止损/止盈/破纪律)
  const urgent = holding.filter((h) => holdSnapshot(h, quote[h.code]).urgency >= 80)
  const pnlTone = daily.floatPnl >= 0 ? 'red' : 'green'
  const dayTone = daily.dayChangeAmount == null ? 'muted' : daily.dayChangeAmount >= 0 ? 'red' : 'green'
  const operationTone = operationPnl.realizedCount
    ? operationPnl.total >= 0 ? 'red' : 'green'
    : 'muted'
  const dayStatus = {
    closed: '今日休市',
    preopen: '待开盘',
    active: '盘中实时',
    postclose: '今日收盘',
  }[daily.marketStatus]
  const hasActivity = holding.length || daily.buyCount || daily.sellCount
  if (!hasActivity) return null
  return (
    <>
    <div className="hold-overview">
      <div className="ho-cell">
        <span className="ho-k">持仓浮盈亏</span>
        <span className={'ho-v ' + pnlTone}>{fmtMoney(daily.floatPnl)}</span>
        {daily.floatPct != null && <span className={'ho-sub ' + pnlTone}>{daily.floatPct >= 0 ? '+' : ''}{daily.floatPct.toFixed(2)}%</span>}
      </div>
      <div className="ho-cell" title="今日买入成交额加买入费用，即实际资金支出">
        <span className="ho-k">今日买入支出</span>
        <span className="ho-v green">{daily.buyCount ? fmtMoney(-daily.buyOutflow) : '—'}</span>
        <span className="ho-sub muted">{daily.buyCount ? `${daily.buyCount} 笔 · 含费` : dayStatus}</span>
      </div>
      <div className="ho-cell" title="今日卖出成交额扣除卖出费用，即实际到账金额">
        <span className="ho-k">今日卖出入账</span>
        <span className="ho-v red">{daily.sellCount ? fmtMoney(daily.sellInflow) : '—'}</span>
        <span className="ho-sub muted">{daily.sellCount ? `${daily.sellCount} 笔 · 扣费后` : dayStatus}</span>
      </div>
      <div className="ho-cell" title="当前持仓市值 + 今日卖出净入账 - 今日买入净支出 - 前一交易日收盘持仓市值">
        <span className="ho-k">较前收</span>
        <span className={'ho-v ' + dayTone}>{daily.dayChangeAmount == null ? '—' : fmtMoney(daily.dayChangeAmount)}</span>
        <span className={'ho-sub ' + dayTone}>
          {daily.dayChangePct == null
            ? dayStatus
            : `${daily.dayChangePct >= 0 ? '+' : ''}${daily.dayChangePct.toFixed(2)}% · ${dayStatus}`}
        </span>
      </div>
      <button
        type="button"
        className="ho-cell ho-operation-pnl"
        onClick={() => setShowOperationPnl((value) => !value)}
        aria-expanded={showOperationPnl}
        aria-controls="today-operation-pnl-detail"
        title="查看今日减仓、清仓和做T产生的扣费后已实现盈亏"
      >
        <span className="ho-k">
          今日操作盈亏
          <Icon name={showOperationPnl ? 'chevronDown' : 'chevronRight'} size={11} />
        </span>
        <span className={'ho-v ' + operationTone}>
          {operationPnl.realizedCount ? fmtMoney(operationPnl.total) : '—'}
        </span>
        <span className="ho-sub muted">
          {operationPnl.realizedCount ? `${operationPnl.realizedCount} 笔 · 扣费后` : '暂无已实现'}
        </span>
      </button>
      <div className="ho-cell">
        <span className="ho-k">当前仓位</span>
        <span className="ho-v">{pf.position != null ? pf.position + '%' : '—'}</span>
        {pf.available != null && <span className="ho-sub muted">可用 {fmtMoney(pf.available).replace('+', '')}</span>}
      </div>
      <div className={'ho-cell ho-alert' + (urgent.length ? ' on' : '')}>
        <span className="ho-k">需处理</span>
        {urgent.length
          ? <span className="ho-v alert-num" title={urgent.map((h) => h.name).join('、')}>{urgent.length} 只</span>
          : <span className="ho-v muted">无</span>}
        {urgent.length > 0 && <span className="ho-sub green">{urgent.slice(0, 2).map((h) => h.name).join(' ')}{urgent.length > 2 ? '…' : ''}</span>}
      </div>
    </div>
    {showOperationPnl && (
      <div className="operation-pnl-detail" id="today-operation-pnl-detail">
        <div className="operation-pnl-head">
          <span><Icon name="coins" size={13} /> 今日操作已实现</span>
          <b className={operationTone}>{operationPnl.realizedCount ? fmtMoney(operationPnl.total) : '—'}</b>
        </div>
        <div className="operation-pnl-breakdown">
          <div>
            <span>减仓 / 清仓</span>
            <b className={operationPnl.positionCount ? (operationPnl.positionPnl >= 0 ? 'red' : 'green') : 'muted'}>
              {operationPnl.positionCount ? fmtMoney(operationPnl.positionPnl) : '—'}
            </b>
            <small>{operationPnl.positionCount} 笔</small>
          </div>
          <div>
            <span>做T</span>
            <b className={operationPnl.tCount ? (operationPnl.tPnl >= 0 ? 'red' : 'green') : 'muted'}>
              {operationPnl.tCount ? fmtMoney(operationPnl.tPnl) : '—'}
            </b>
            <small>{operationPnl.tCount} 组</small>
          </div>
        </div>
        <p><Icon name="info" size={12} />仅统计今天完成卖出及做T的扣费后已实现盈亏；今日买入、未卖持仓浮盈不计入。</p>
      </div>
    )}
    {daily.dayChangeAmount != null && (
      <div className="daily-attribution">
        <button
          type="button"
          className="daily-attribution-toggle"
          onClick={() => setShowAttribution((value) => !value)}
          aria-expanded={showAttribution}
        >
          <span><Icon name="chart" size={12} /> 当日损益归因</span>
          <b className={attribution.total >= 0 ? 'red' : 'green'}>{fmtMoney(attribution.total)}</b>
          <Icon name={showAttribution ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        {showAttribution && (
          <div className="daily-attribution-body">
            <div className="da-metrics">
              <span>隔夜持仓 <b className={attribution.overnightPnl >= 0 ? 'red' : 'green'}>{fmtMoney(attribution.overnightPnl)}</b></span>
              <span>今日新买 <b className={attribution.newBuyPnl >= 0 ? 'red' : 'green'}>{fmtMoney(attribution.newBuyPnl)}</b></span>
              <span>卖出执行 <b className={attribution.sellExecutionPnl >= 0 ? 'red' : 'green'}>{fmtMoney(attribution.sellExecutionPnl)}</b></span>
            </div>
            {attribution.topLosses.length > 0 && (
              <div className="da-losses">
                <span>主要拖累</span>
                {attribution.topLosses.slice(0, 3).map((item) => (
                  <b key={item.code}>
                    {item.name} <StockTags code={item.code} variant="inline" /> {fmtMoney(item.total)}
                  </b>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    )}
    </>
  )
}

// ---------- 盘中定时刷新 AI 建议：任务配置 ----------
// 用户可开启一个后台定时任务:交易时段内,每隔 N 分钟对选定范围(自选/持仓/两者)
// 批量重生成 AI 操作建议(复用 runBatchAdvice,与手动/每日同源,保证连续性一致性)。
// 展示最近一次更新时间；自动调度由 FC Timer 执行，浏览器只负责配置和手动触发。
function AutoRefreshControl({ quote, stockTags }) {
  const book = usePlanStore()
  const [open, setOpen] = useState(false)
  const [expandedScope, setExpandedScope] = useState('hold')
  const [manualNotice, setManualNotice] = useState('')
  const [, forceBatch] = useState(0)
  useEffect(() => subscribeBatch(() => forceBatch((n) => n + 1)), [])
  const cfg = getAutoConfig()
  const availableSelection = selectAutoRefreshCodes({
    config: {
      ...cfg,
      holdEnabled: true,
      watchEnabled: true,
    },
    holdings: book.holding || [],
    watchlist: book.plan || [],
  })
  const runnableSelection = selectAutoRefreshCodes({
    config: cfg,
    holdings: book.holding || [],
    watchlist: book.plan || [],
  })
  const enabled = cfg.enabled && runnableSelection.allCodes.length > 0
  const batch = getBatchState()
  const updateSelectedCodes = (scope, codes) => {
    setAutoSelectedCodes({
      holdCodes: scope === 'hold'
        ? codes
        : availableSelection.holdCodes,
      watchCodes: scope === 'watch'
        ? codes
        : availableSelection.watchCodes,
    })
  }

  const fmtLast = (t) => {
    if (!t) return '尚未刷新'
    const d = new Date(t)
    const pad = (n) => String(n).padStart(2, '0')
    const same = new Date().toDateString() === d.toDateString()
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    return same ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
  }
  const setInterval_ = (key, value, fallback) => {
    let n = parseInt(value, 10)
    if (!Number.isFinite(n)) n = fallback
    if (n < MIN_INTERVAL) n = MIN_INTERVAL
    if (n > MAX_INTERVAL) n = MAX_INTERVAL
    setAutoConfigSetting(key, n)
  }

  const manualRefresh = async () => {
    setManualNotice('正在发起…')
    const result = await runManualAdviceRefresh('both', quote || {})
    const text = result?.status === 'started'
      ? `已开始复核 ${result.selectedCount || 0} 只股票`
      : result?.status === 'running'
        ? '已有生成任务正在运行'
        : result?.status === 'full'
          ? '生成通道正忙，请稍后再试'
          : '当前没有可刷新的股票'
    setManualNotice(text)
  }

  const scheduleRow = ({
    scope,
    label,
    hint,
    checked,
    enabledKey,
    intervalKey,
    intervalMin,
    fallback,
    lastAt,
    items,
    selectedCodes,
  }) => {
    const availableCount = new Set(
      items.map((item) => item?.code).filter(Boolean),
    ).size
    return (
      <div className={'arp-schedule' + (checked ? ' on' : '')}>
        <div className="arp-schedule-main">
          <label className="arp-scope-check">
            <input type="checkbox" checked={checked}
              onChange={(event) => setAutoConfigSetting(enabledKey, event.target.checked)} />
            <span><b>{label}</b><small>{hint}</small></span>
          </label>
          <span className="arp-v">
            <input className="arp-num" type="number" min={MIN_INTERVAL} max={MAX_INTERVAL}
              aria-label={`${label}自动刷新间隔`}
              value={intervalMin}
              onChange={(event) => setInterval_(intervalKey, event.target.value, fallback)} />
            分钟
          </span>
        </div>
        <div className="arp-schedule-meta">
          <span className="arp-schedule-last">
            最近刷新：{fmtLast(lastAt)}
          </span>
          <button
            type="button"
            className="arp-selection-toggle"
            aria-expanded={expandedScope === scope}
            onClick={() => setExpandedScope((current) =>
              current === scope ? '' : scope)}
          >
            已选 {selectedCodes.length}/{availableCount}
            <Icon
              name={expandedScope === scope
                ? 'chevronDown'
                : 'chevronRight'}
              size={12}
            />
          </button>
        </div>
        {expandedScope === scope && (
          <AutoRefreshStockSelector
            scope={scope}
            items={items}
            selectedCodes={selectedCodes}
            quoteMap={quote || {}}
            tagMap={stockTags || {}}
            onChange={(codes) => updateSelectedCodes(scope, codes)}
          />
        )}
      </div>
    )
  }

  const panel = (
    <div className="auto-ref-panel auto-ref-dialog" role="dialog" aria-modal="true"
      aria-label="操作建议刷新设置" onClick={(event) => event.stopPropagation()}>
      <div className="arp-head">
        <span className="arp-title"><Icon name="clock" size={13} /> 操作建议刷新</span>
        <button className="arp-x" aria-label="关闭刷新设置" onClick={() => setOpen(false)}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="arp-row toggle">
        <span>
          <b className="arp-master-title">
            {enabled ? '持续复核已开启' : '尚未选择复核股票'}
          </b>
          <small className="arp-master-note">云端交易时段自动运行，无需打开页面</small>
        </span>
        <b className={'arp-always-on' + (enabled ? '' : ' idle')}>
          {enabled ? '运行中' : '未运行'}
        </b>
      </div>

      <div className="arp-schedules">
        {scheduleRow({
          scope: 'hold',
          label: '持仓股票',
          hint: '建议 15 分钟',
          checked: cfg.holdEnabled,
          enabledKey: K_HOLD_ENABLED,
          intervalKey: K_HOLD_INTERVAL,
          intervalMin: cfg.holdIntervalMin,
          fallback: DEFAULT_HOLD,
          lastAt: cfg.holdLastAt,
          items: book.holding || [],
          selectedCodes: availableSelection.holdCodes,
        })}
        {scheduleRow({
          scope: 'watch',
          label: '自选股票',
          hint: '建议 30 分钟',
          checked: cfg.watchEnabled,
          enabledKey: K_WATCH_ENABLED,
          intervalKey: K_WATCH_INTERVAL,
          intervalMin: cfg.watchIntervalMin,
          fallback: DEFAULT_WATCH,
          lastAt: cfg.watchLastAt,
          items: book.plan || [],
          selectedCodes: availableSelection.watchCodes,
        })}
      </div>

      <button
        className="arp-manual"
        onClick={manualRefresh}
        disabled={batch.running || runnableSelection.allCodes.length === 0}
      >
        <Icon name="refresh" size={13} className={batch.running ? 'spin' : ''} />
        {batch.running ? '正在生成建议…' : '立即复核已选股票'}
      </button>
      {manualNotice && <div className="arp-manual-note" role="status">{manualNotice}</div>}

      <div className="arp-foot">
        <div className="arp-note sub-name">
          军师按每条建议的下次复核时间自动检查；已有任务运行时会顺延，不会重复生成。
        </div>
      </div>
    </div>
  )

  return (
    <div className="auto-ref-wrap">
      <button
        className={'mini-btn auto-ref-btn' + (enabled ? ' on' : '')}
        onClick={() => setOpen((v) => !v)}
        title="设置盘中定时刷新操作建议（可配间隔与范围）"
      >
        <Icon name={enabled ? 'refresh' : 'clock'} size={13} className={enabled ? 'spin-slow' : ''} />
        {`持续复核·已选${runnableSelection.allCodes.length}只`}
      </button>

      {open && (
        <OverlayPortal>
          <div className="auto-ref-mask" onClick={() => setOpen(false)}>{panel}</div>
        </OverlayPortal>
      )}
    </div>
  )
}

// ---------- 当前持仓 ----------
function HoldingList({ book, quote, stockTags, searchConfig, batchSel }) {
  // ===== 批量一次性生成:整体账户入口。勾选可跨【持仓+自选】,共享上提到 PlanTab 的状态 =====
  const {
    selectMode,
    setSelectMode,
    selected,
    setSelected,
    toggleSel,
    batchScope,
    setBatchScope,
    batchPinnedOnly,
    setBatchPinnedOnly,
    batchDimension,
    setBatchDimension,
    batchGroup,
    setBatchGroup,
  } = batchSel
  const [, forceBatch] = useState(0)
  useEffect(() => subscribeBatch(() => forceBatch((n) => n + 1)), [])
  const batch = getBatchState()
  // 一次性生成时若端点被单股生成占满 → 弹「端点已满 + 正在生成清单」(可点击跳转);端点空出自动关闭
  const [busyModal, setBusyModal] = useState(null)
  const [batchNotice, setBatchNotice] = useState('')
  useEffect(() => {
    if (!busyModal) return
    const refresh = () => {
      const busy = generatingList()
      if (busy.length < (busyModal.concurrency || 1)) { setBusyModal(null); return }
      setBusyModal((m) => (m ? { ...m, busy } : m))
    }
    const unsub = subscribeBatch(refresh)
    const unsubR = subscribeRunner(refresh)
    return () => { unsub(); unsubR() }
    // eslint-disable-next-line
  }, [busyModal])

  // 卡片按实时浮盈金额降序。排序口径复用账户估值，包含手续费和未结算做T净头寸。
  const sortedHolding = useMemo(
    () => sortHoldingsByProfit(book.holding, quote, book.account),
    [book.holding, quote, book.account],
  )

  const [holdDimension, setHoldDimension] = useState('concept')
  const [holdTab, setHoldTab] = useState('全部')
  // 行情返回行业后，回写缓存到持仓，保证行情缺失时仍能分类（且持久化到云端）
  useEffect(() => {
    ;(book.holding || []).forEach((h) => {
      const q = quote[h.code]
      if (q && q.industry && q.industry !== h.industry) {
        planStore.setHoldingMeta(h.id, { industry: q.industry })
      }
    })
    // eslint-disable-next-line
  }, [Object.keys(quote).length, book.holding.length])
  const holdGroups = useMemo(() => buildStockGroups(book.holding, {
    dimension: holdDimension,
    tagMap: stockTags,
    quoteMap: quote,
  }), [book.holding, holdDimension, stockTags, quote])
  const holdTagsLoading = holdDimension === 'concept'
    && (book.holding || []).some((item) => stockTags[item.code] == null)
  // 当前胶囊可能因清仓或切换维度失效 → 回退到全部。
  useEffect(() => {
    if (holdTab !== '全部' && !holdGroups.some((group) => group.name === holdTab)) setHoldTab('全部')
    // eslint-disable-next-line
  }, [holdGroups])
  // 搜索结果「定位」:命中本区(持仓)名下的 code → 先切回「全部」保证卡片被渲染,再滚动+高亮
  useEffect(() => subscribeLocate((code) => {
    if (!(book.holding || []).some((h) => h.code === code)) return
    setHoldTab('全部')
    scrollToCard(code)
  }), [book.holding])
  const shownHolding = filterStocksByGroup(sortedHolding, holdTab, {
    dimension: holdDimension,
    tagMap: stockTags,
    quoteMap: quote,
  })
  // 持仓 / 自选 去重代码集(同股多笔只算一只);用于全选/生成
  const holdCodes = [...new Set(sortedHolding.map((h) => h.code))]
  const watchCodes = [...new Set((book.plan || []).map((p) => p.code))]
  const pinnedWatchCodes = [...new Set(
    (book.plan || [])
      .filter((item) => item.star === true)
      .map((item) => item.code),
  )]
  const allCodes = [...new Set([...holdCodes, ...watchCodes])]
  const batchWatchlist = batchPinnedOnly
    ? (book.plan || []).filter((item) => item.star === true)
    : book.plan
  const batchPool = batchScope === 'holding'
    ? book.holding
    : batchScope === 'watchlist'
      ? batchWatchlist
      : [...book.holding, ...batchWatchlist]
  const batchGroups = useMemo(() => buildStockGroups(batchPool, {
    dimension: batchDimension,
    tagMap: stockTags,
    quoteMap: quote,
  }), [batchPool, batchDimension, stockTags, quote])
  const batchScopeCodes = selectBatchGroupCodes({
    holdings: book.holding,
    watchlist: book.plan,
    scope: batchScope,
    pinnedOnly: false,
    dimension: batchDimension,
    group: '全部',
    tagMap: stockTags,
    quoteMap: quote,
  })
  const batchTagsLoading = batchDimension === 'concept'
    && batchPool.some((item) => stockTags[item.code] == null)
  const selectScope = (scope) => {
    const codes = selectBatchGroupCodes({
      holdings: book.holding,
      watchlist: book.plan,
      scope,
      pinnedOnly: false,
      dimension: batchDimension,
      group: '全部',
      tagMap: stockTags,
      quoteMap: quote,
    })
    setBatchScope(scope)
    setBatchPinnedOnly(false)
    setBatchGroup(['全部'])
    setSelected(new Set(codes))
  }
  const selectPinned = () => {
    const nextPinnedOnly = !batchPinnedOnly
    const groups = batchGroup.length ? batchGroup : ['全部']
    const codes = selectBatchGroupCodes({
      holdings: book.holding,
      watchlist: book.plan,
      scope: 'watchlist',
      pinnedOnly: nextPinnedOnly,
      dimension: batchDimension,
      groups,
      tagMap: stockTags,
      quoteMap: quote,
    })
    setBatchPinnedOnly(nextPinnedOnly)
    setBatchGroup(groups)
    setSelected(new Set(codes))
  }
  const selectGroup = (group) => {
    const nextGroups = group === '全部' && batchPinnedOnly
      ? ['全部']
      : toggleBatchGroupSelection(batchGroup, group)
    const nextPinnedOnly = group === '全部'
      ? false
      : batchPinnedOnly
    const codes = selectBatchGroupCodes({
      holdings: book.holding,
      watchlist: book.plan,
      scope: batchScope,
      pinnedOnly: nextPinnedOnly,
      dimension: batchDimension,
      groups: nextGroups,
      tagMap: stockTags,
      quoteMap: quote,
    })
    setBatchPinnedOnly(nextPinnedOnly)
    setBatchGroup(nextGroups)
    setSelected(new Set(codes))
  }
  const selectDimension = (dimension) => {
    setBatchDimension(dimension)
    setBatchPinnedOnly(false)
    setBatchGroup([])
    setSelected(new Set())
  }
  // 补分：历史持仓(建仓早于本功能)没有量化得分 → 按需评分,徽标从"计算中"变为分数
  useEffect(() => {
    const codes = (book.holding || []).filter((h) => h.qScore == null).map((h) => h.code)
    if (codes.length) ensureQuantScores(codes)
    // eslint-disable-next-line
  }, [book.holding.map((h) => h.code).join(',')])

  const selHold = holdCodes.filter((c) => selected.has(c)).length
  const selWatch = watchCodes.filter((c) => selected.has(c)).length
  const selCount = allCodes.filter((c) => selected.has(c)).length
  const canBatch = allCodes.length > 0

  return (
    <section className="panel plan-section plan-section-hold">
      <div className="portfolio-overview-zone">
        <HoldOverview book={book} quote={quote} />
        <div className="portfolio-command-actions">
          <AdvisorScore book={book} />
          <AutoRefreshControl quote={quote} stockTags={stockTags} />
          {canBatch && !selectMode && (
            <button className="mini-btn batch-entry" onClick={() => {
              setSelectMode(true)
              setSelected(new Set())
              setBatchScope('all')
              setBatchPinnedOnly(false)
              setBatchDimension('concept')
              setBatchGroup([])
            }}
              disabled={batch.running} title="勾选持仓 / 自选里的若干只股票，一次性批量生成操作建议（后台处理）">
              <Icon name="spark" size={13} /> 一次性生成
            </button>
          )}
        </div>

      {/* 批量工具条：第一层选股票池，第二层按概念/行业板块选中；卡片仍可手动增删。 */}
      {selectMode && (() => {
        const doRun = async (deepMode = false) => {
          const codes = allCodes.filter((c) => selected.has(c))
          if (!codes.length) return
          // 端点占用门控:端点被单股生成占满 → 不启动,弹「端点已满」;未满则用剩余空槽并行(空出再补)
          const peek = peekBatchBusy(codes, deepMode)
          if (peek.full) { setBusyModal({ busy: peek.busy, concurrency: peek.concurrency }); return }
          setBatchNotice(deepMode ? '正在提交云端深度生成任务…' : '正在提交云端普通生成任务…')
          const result = await runBatchAdvice(codes, quote, { deepMode })
          if (result?.status === 'started') {
            setSelectMode(false)
            setBatchNotice(result.error || (deepMode ? '云端已受理，将以2路并行逐批生成' : '云端已受理'))
          } else {
            setBatchNotice(result?.status === 'running' ? '已有云端任务正在运行' : '任务提交失败，请重试')
          }
        }
        return (
          <div className="batch-bar">
            <span className="batch-hint"><Icon name="spark" size={12} /> 选择股票池，可优先选置顶，再多选概念或行业板块</span>
            <div className="batch-filter-stack">
              <div className="batch-filter-row">
                <span className="batch-filter-label">股票池</span>
                <div className="batch-scope-options" role="group" aria-label="选择批量生成股票池">
                  <button type="button" className={batchScope === 'holding' ? 'on' : ''}
                    aria-pressed={batchScope === 'holding'} onClick={() => selectScope('holding')}>
                    持仓 ({holdCodes.length})
                  </button>
                  <button type="button" className={batchScope === 'watchlist' ? 'on' : ''}
                    aria-pressed={batchScope === 'watchlist'} onClick={() => selectScope('watchlist')}>
                    自选 ({watchCodes.length})
                  </button>
                  <button type="button" className={batchScope === 'all' ? 'on' : ''}
                    aria-pressed={batchScope === 'all'} onClick={() => selectScope('all')}>
                    两者 ({allCodes.length})
                  </button>
                </div>
              </div>
              <StockGroupFilter
                compact
                label="板块维度"
                dimension={batchDimension}
                onDimensionChange={selectDimension}
                groups={batchGroups}
                active={batchGroup}
                onActiveChange={selectGroup}
                total={batchScopeCodes.length}
                loading={batchTagsLoading}
                multiSelect
                pinnedOption={batchScope === 'watchlist'
                  ? {
                      active: batchPinnedOnly,
                      count: pinnedWatchCodes.length,
                      onChange: selectPinned,
                    }
                  : null}
              />
            </div>
            <button className="chip-btn ghost" onClick={() => {
              setBatchPinnedOnly(false)
              setBatchGroup([])
              setSelected(new Set())
            }} disabled={!selCount}>清空</button>
            <span className="batch-count">已选 <b>{selCount}</b> 只
              {(selHold > 0 || selWatch > 0) && <span className="sub-name">（持仓 {selHold} · 自选 {selWatch}）</span>}
            </span>
            <span className="batch-spacer" />
            <button className="chip-btn buy" onClick={() => doRun(false)} disabled={!selCount || batch.running}>
              <Icon name="spark" size={12} />普通生成（{selCount}）
            </button>
            <button className="chip-btn batch-deep" onClick={() => doRun(true)}
              disabled={!selCount || batch.running}
              title="强制使用深度思考，最多2路并行，全部选中股票会依次完成">
              <Icon name="brain" size={12} />深度生成（2路并行）
            </button>
            <button className="chip-btn ghost" onClick={() => {
              setSelectMode(false)
              setBatchPinnedOnly(false)
              setBatchGroup([])
              setSelected(new Set())
            }}>退出</button>
            {batchNotice && (
              <span className="batch-mode-note" role="status">
                {batchNotice}
              </span>
            )}
          </div>
        )
      })()}

      {/* 批量进度条:后台处理中/刚结束时展示;可取消,可切 Tab 后台继续 */}
      {(batch.running || (batch.finishedAt > 0 && Date.now() - batch.finishedAt < 8000)) && (
        <div className={'batch-prog' + (batch.running ? ' on' : ' done')}>
          <div className="bp-head">
            <span className="bp-title">
              {batch.running
                ? <><Icon name="refresh" size={13} className="spin" /> 正在后台{batch.deepMode ? '深度' : '普通'}生成操作建议…{batch.serverMode ? <span className="sub-name"> · 云端（退后台或关页面仍会继续）</span> : null}{batch.deepMode ? <span className="bp-deep-tag">深度思考 · 耗时较长</span> : null}</>
                : <><Icon name="check" size={13} /> {batch.deepMode ? '深度' : '批量'}生成完成</>}
            </span>
            <span className="bp-stat">
              {batch.done}/{batch.total}
              {batch.ok > 0 && <span className="bp-ok"> · 成功 {batch.ok}</span>}
              {batch.fail > 0 && <span className="bp-fail"> · 失败 {batch.fail}</span>}
              {batch.skipped > 0 && <span className="sub-name"> · 已取消 {batch.skipped}</span>}
              {batch.cancelError && <span className="bp-fail"> · {batch.cancelError}</span>}
            </span>
            {batch.running
              ? <button
                  type="button"
                  className="chip-btn ghost bp-cancel"
                  onClick={() => { void cancelBatch() }}
                  disabled={batch.cancelRequested}
                  aria-busy={batch.cancelRequested}
                >
                  {batch.cancelRequested
                    ? '停止中…'
                    : batch.cancelError ? '重试停止' : '全部停止'}
                </button>
              : (batch.fail > 0
                ? <button className="chip-btn buy bp-regen" onClick={() => regenerateFailed(quote)}><Icon name="refresh" size={12} /> 重生成失败({batch.fail})</button>
                : null)}
          </div>
          <div className="bp-track"><div className="bp-fill" style={{ width: batch.pct + '%' }} /></div>
          {/* 每只独立状态:排队/生成中/成功/失败/取消;生成中或已完成的可点击跳转详情;运行中的可单只取消 */}
          {batch.items.length > 0 && (
            <div className="bp-items">
              {batch.items.map((it) => {
                const st = it.status  // pending|running|ok|fail|skipped
                const label = { pending: '排队中', queued: '排队中', running: '生成中', canceling: '取消中', ok: '已完成', fail: '失败', skipped: '已取消' }[st] || st
                const jumpable = st === 'running' || st === 'ok' || st === 'fail'
                const visibleProgress = st === 'running' && (it.phase || it.reasoning || it.sources?.length || it.model)
                return (
                  <div key={it.code} className={'bp-item bp-' + st}>
                    <span className={'bp-chip bp-' + st}
                      onClick={jumpable ? () => openStockDetail(it.code, it.name) : undefined}
                      title={jumpable ? '查看该股详情/建议' : (it.error || label)}
                      style={jumpable ? { cursor: 'pointer' } : undefined}>
                      {st === 'running' && <Icon name="refresh" size={10} className="spin" />}
                      {st === 'ok' && <Icon name="check" size={10} />}
                      <b className="bp-chip-name">{it.name}</b>
                      <StockTags code={it.code} variant="inline" />
                      <span className="bp-chip-st">{label}</span>
                      {(st === 'running' || st === 'pending' || st === 'queued') && (
                        <button className="bp-chip-x" title="取消这一只"
                          onClick={(e) => { e.stopPropagation(); cancelOne(it.code) }}>
                          <Icon name="close" size={10} />
                        </button>
                      )}
                    </span>
                    {visibleProgress && (
                      <div className="bp-detail">
                        <div className="bp-phase">{it.phase || '正在分析'}</div>
                        {(it.model || it.endpoint) && (
                          <div className="bp-route">{[it.model, it.endpoint].filter(Boolean).join(' · ')}</div>
                        )}
                        {visibleAiSources(searchConfig.enabled, it.sources).length > 0 && (
                          <div className="bp-sources">
                            {visibleAiSources(searchConfig.enabled, it.sources).map((source, index) => (
                              <span key={`${source.label}-${index}`} className={source.ok ? 'ok' : 'off'}>
                                {source.ok ? '✓' : '—'} {source.label}
                              </span>
                            ))}
                          </div>
                        )}
                        {it.reasoning && <div className="bp-reasoning">{it.reasoning}</div>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      </div>

      <div className="plan-section-hold-sticky">
        <div className="plan-section-sticky plan-section-head-sticky">
          <div className="panel-head plan-head">
            <div role="heading" aria-level="2" className="panel-title"><Icon name="wallet" size={16} />当前持仓</div>
          </div>
        </div>

        {book.holding.length > 0 && (
          <div className="plan-section-sticky plan-section-filter-sticky">
            <StockGroupFilter
              dimension={holdDimension}
              onDimensionChange={(next) => { setHoldDimension(next); setHoldTab('全部') }}
              groups={holdGroups}
              active={holdTab}
              onActiveChange={setHoldTab}
              total={holdCodes.length}
              loading={holdTagsLoading}
            />
          </div>
        )}
      </div>

      {/* 一次性生成时端点已满:列出正在生成的个股(可点击跳转),端点空出后本弹窗自动关闭 */}
      {busyModal && (
        <OverlayPortal>
          <div className="busy-modal-mask" onClick={() => setBusyModal(null)}>
            <div className="busy-modal" onClick={(e) => e.stopPropagation()}>
            <div className="busy-modal-head">
              <span className="busy-modal-title"><Icon name="gauge" size={15} /> 生成通道已满</span>
              <button className="icon-btn" onClick={() => setBusyModal(null)} title="关闭"><Icon name="close" size={15} /></button>
            </div>
            <div className="busy-modal-desc">
              当前 {busyModal.concurrency || busyModal.busy.length} 个生成通道都在使用中，请等待其中一个完成。
              下列个股正在生成，完成后会自动腾出端点，届时可再次点击「一次性生成」。
            </div>
            <div className="busy-modal-list">
              {busyModal.busy.map((x) => (
                <button
                  key={x.code}
                  className="busy-modal-item"
                  onClick={() => { openStockDetail(x.code, x.name); setBusyModal(null) }}
                  title="查看该股详情与生成进度"
                >
                  <span className="busy-item-name">{x.name}</span>
                  <StockTags code={x.code} variant="inline" />
                  <span className="busy-item-code">{x.code}</span>
                  <Icon name="refresh" size={12} className="spin" />
                  <Icon name="chevronRight" size={13} />
                </button>
              ))}
            </div>
            </div>
          </div>
        </OverlayPortal>
      )}

      {book.holding.length === 0 ? (
        <div className="empty">在下方「自选 / 候选」里点「建仓」后，持仓出现在这里。做T：在每笔持仓上高抛低吸、摊薄成本。</div>
      ) : (
        <>
          <div className="hold-grid">
            {shownHolding.map((h) => (
              selectMode ? (
                <div key={h.id}
                  className={'hold-select-wrap' + (selected.has(h.code) ? ' sel-on' : '')}
                  onClickCapture={(e) => { e.stopPropagation(); toggleSel(h.code) }}
                  title={selected.has(h.code) ? '取消选择' : '选择此股'}>
                  <span className={'pc-check' + (selected.has(h.code) ? ' on' : '')}>
                    <Icon name={selected.has(h.code) ? 'checkSquare' : 'square'} size={16} />
                  </span>
                  <HoldingItem h={h} quote={quote[h.code]} />
                </div>
              ) : (
                <HoldingItem key={h.id} h={h} quote={quote[h.code]} />
              )
            ))}
          </div>
        </>
      )}
    </section>
  )
}

// ---------- 单笔持仓 ----------
function HoldingItem({ h, quote: q }) {
  const searchConfig = useAiSearchConfig()
  const [mode, setMode] = useState(null) // null | 'sell' | 'T' | 'add' | 'cost'
  const detail = useDetailStore() // 监听个股详情弹窗：从个股页生成AI建议返回后自动代入价格
  const [sellPrice, setSellPrice] = useState('')
  const [sellQty, setSellQty] = useState('1')
  const [addPrice, setAddPrice] = useState('')
  const [addQty, setAddQty] = useState('1')
  const [costPrice, setCostPrice] = useState('')
  const [confirmDel, setConfirmDel] = useState(false) // 删除持仓二次确认
  const [confirmSettle, setConfirmSettle] = useState(false) // 手动结算做T二次确认
  // B-7 移动端横滑:右滑=看详情(左滑做T已移除——改为点「做T」按钮打开全屏页,避免误触/内容裁切)
  const isTouch = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches
  // 做T输入（流水式：直接记一腿买或卖）
  const [tSide, setTSide] = useState('buy') // buy 低吸/买回 | sell 高抛/卖出
  const [tPrice, setTPrice] = useState('')
  const [tQty, setTQty] = useState('1')
  const [tAdvice, setTAdvice] = useState(null) // {loading,result,error} AI做T参考
  const [tStyle, setTStyle] = useState('auto') // auto(按历史规律) | conservative | balanced | aggressive
  const [openDays, setOpenDays] = useState({}) // 做T流水按天折叠，key→是否展开
  const [planDetailOpen, setPlanDetailOpen] = useState(false)
  const [tradeErr, setTradeErr] = useState('')
  const mobileOperations = useMediaQuery('(max-width: 720px)')
  const swipe = useSwipe({
    enabled: isTouch && !mode && !planDetailOpen,
    onRight: () => openStockDetail(h.code, h.name),
  })

  const book = usePlanStore()
  const stockNote = stockNoteText(book.stockNotes, h.code)
  const manualTradePairs = useMemo(
    () => tradeActivityContext(book.closed || [], h.code)
      .t.pairRecords
      .filter((record) => record.manualPair)
      .sort((left, right) => Number(right.at) - Number(left.at)),
    [book.closed, h.code],
  )

  const baseQty = h.baseQty || h.qty
  const costBasis = positionCostBasis(h)
  const tStat = costBasis.flows
  const liveQty = costBasis.liveQty
  const shares = liveQty * 100
  const rawCostWithFee = costBasis.rawCostWithFees ?? h.buyPrice
  const effectiveCost = costBasis.costWithFees ?? rawCostWithFee
  const quoteView = quoteDisplayState(q)
  // 展示价可回退竞价/最近收盘；触价、止盈止损与执行计划只认连续竞价实时价。
  const validPx = quoteView.livePrice

  // 拉该股日K：用于 MA10(计划公式兜底)/收盘价兜底/盈亏计算。信号灯已移入个股详情页。
  const kd = usePolling(`/api/stock_detail?code=${h.code}&klt=101&lmt=30`, 600000, [h.code])
  const candles = (kd.data && kd.data.candles) || []
  // 收盘价兜底:无有效现价时,用最近一根日K收盘价(今收);再退到昨收 prevClose。都为正数才采用。
  const closePx = (() => {
    const c = candles.length ? Number(candles[candles.length - 1].close) : NaN
    if (Number.isFinite(c) && c > 0) return c
    const pc = Number(q && q.prevClose)
    return Number.isFinite(pc) && pc > 0 ? pc : null
  })()
  // 盈亏展示使用最新有效价格；交易动作仍只使用上面的 validPx。
  const effPx = validPx ?? quoteView.price ?? closePx

  // 持仓浮盈与展示成本必须同源：已实现做T收益已摊入有效成本。
  const floatPnl = effPx != null && shares > 0
    ? +(effPx * shares - costBasis.costValue).toFixed(2)
    : null
  const pnl = floatPnl != null && costBasis.costValue
    ? (floatPnl / costBasis.costValue) * 100
    : null

  const signal = validPx != null ? tap5break10({
    price: validPx, prevClose: q.prevClose, volRatio: q.volRatio,
    candles, cost: effectiveCost, pnlPct: pnl,
  }) : null
  // 盘中时段操盘提示（时段 + 实时盘面 → 此刻该怎么做）
  const play = validPx != null ? intradayPlaybook(q) : null

  // 交易计划：止盈(tp)/止损(sl)/理由(planReason)。触价「按纪律离场」是实时动作,仅在有真实现价时判定
  const [planPrice, setPlanTP] = useState(h.tp != null ? String(h.tp) : '')
  const [planSL, setPlanSL] = useState(h.sl != null ? String(h.sl) : '')
  const [planReason, setPlanReason] = useState(h.planReason || '')
  const [planBasis, setPlanBasis] = useState(null)       // 复用来源信息 {from:'advice', action, tone, at}

  // 订阅 AI 建议缓存：个股详情页每次刷新AI操作建议(saveAdvice) → 重渲染 → 未手动改过的止盈/止损自动跟随最新建议
  const [, forceAdv] = useState(0)
  useEffect(() => subscribeAdvice(() => forceAdv((n) => n + 1)), [])
  // 该股最新 AI 建议的【标准化】止盈/止损(与个股详情页同源同值)
  const aiPlan = advicePlan(h.code)
  const effectivePlanTarget = aiPlan && !h.tpManual
    ? aiPlan.tp
    : h.tp
  const effectivePlanStop = aiPlan && !h.slManual
    ? aiPlan.sl
    : h.sl
  const hitTP = (
    validPx != null
    && effectivePlanTarget != null
    && validPx >= Number(effectivePlanTarget)
  )
  const hitSL = (
    validPx != null
    && effectivePlanStop != null
    && validPx <= Number(effectivePlanStop)
  )
  // 自动跟随:市场在变,每次生成AI建议都基于最新盘面 → 未被手动覆盖的字段回写持仓,保证与详情页一致
  useEffect(() => {
    if (!aiPlan) return
    const patch = advicePlanSyncPatch(h, aiPlan)
    // 理由同源:未被手动改写时,自动同步 AI 操作建议里的一句话理由/操作计划
    if (!h.reasonManual && aiPlan.reason && aiPlan.reason !== h.planReason) patch.planReason = aiPlan.reason
    if (Object.keys(patch).length) planStore.setPlanRule(h.id, patch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPlan && aiPlan.tp, aiPlan && aiPlan.sl, aiPlan && aiPlan.reason, h.tpManual, h.slManual, h.reasonManual])

  // 依据该股 + 短线操作逻辑，给出默认止盈/止损/理由（用户可再改）
  const suggestPlan = () => {
    const base = effectiveCost || (q && q.price) || h.buyPrice
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
  // 复用最新 AI 操作建议里的止损/止盈价（与个股详情页同源:planStore.advicePlan 统一口径）
  const adviceForStock = () => advicePlan(h.code)
  const hasAdvicePrices = () => {
    const a = adviceForStock()
    return !!(a && (a.tp != null || a.sl != null))
  }

  // 打开计划编辑：existing=true 用已有值；否则优先复用最新 AI 建议的止损/止盈，缺失则用本地公式兜底
  const openPlan = (useExisting) => {
    setPlanDetailOpen(false)
    setPlanBasis(null)
    if (useExisting && (h.tp || h.sl || h.planReason)) {
      setPlanTP(h.tp != null ? String(h.tp) : '')
      setPlanSL(h.sl != null ? String(h.sl) : '')
      setPlanReason(h.planReason || '')
      setMode('plan')
      return
    }
    const round = (v) => (v < 10 ? +v.toFixed(3) : +v.toFixed(2))
    const adv = adviceForStock()
    if (adv && (adv.tp != null || adv.sl != null)) {
      // 直接复用 AI 操作建议里的止盈/止损
      const s = suggestPlan()
      setPlanTP(adv.tp != null ? String(round(adv.tp)) : s.tp)
      setPlanSL(adv.sl != null ? String(round(adv.sl)) : s.sl)
      setPlanReason(h.planReason || `复用军师建议${adv.action ? `（${adv.action}）` : ''}的止盈止损价`)
      setPlanBasis({ from: 'advice', action: adv.action, tone: adv.tone, at: adv.at })
      setMode('plan')
      return
    }
    // 无建议：用本地公式兜底填上（同时界面会引导去个股页生成建议）
    const s = suggestPlan()
    setPlanTP(s.tp); setPlanSL(s.sl); setPlanReason(s.reason)
    setMode('plan')
  }

  // 从个股页生成AI操作建议返回后（详情弹窗关闭），若正在填计划则自动代入建议的止盈/止损价
  const detailOpen = !!(detail && detail.stock)
  const prevDetailOpen = useRef(detailOpen)
  useEffect(() => {
    const justClosed = prevDetailOpen.current && !detailOpen
    prevDetailOpen.current = detailOpen
    if (justClosed && mode === 'plan') {
      const round = (v) => (v < 10 ? +v.toFixed(3) : +v.toFixed(2))
      const adv = adviceForStock()
      if (adv && (adv.tp != null || adv.sl != null)) {
        if (adv.tp != null) setPlanTP(String(round(adv.tp)))
        if (adv.sl != null) setPlanSL(String(round(adv.sl)))
        setPlanReason((r) => r || `复用军师建议${adv.action ? `（${adv.action}）` : ''}的止盈止损价`)
        setPlanBasis({ from: 'advice', action: adv.action, tone: adv.tone, at: adv.at })
      }
    }
  }, [detailOpen, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const savePlan = () => {
    const tpVal = planPrice === '' ? null : Number(planPrice)
    const slVal = planSL === '' ? null : Number(planSL)
    const reasonVal = planReason.trim() || null
    const ap = adviceForStock()
    // 理由:与最新 AI 理由一致 → 视为仍跟随AI(reasonManual=false);被改成别的 → 标记手动,停止自动跟随
    const reasonManual = !!(reasonVal && ap && ap.reason ? reasonVal !== ap.reason : reasonVal)
    // 手动保存 → 标记为「手动」,停止自动跟随AI(除非用户点「跟随AI」恢复);预警由 setPlanRule 内部自动同步
    planStore.setPlanRule(h.id, {
      tp: tpVal,
      sl: slVal,
      tpManual: tpVal != null,
      slManual: slVal != null,
      planReason: reasonVal,
      reasonManual,
    })
    setMode(null)
  }
  // 恢复跟随最新 AI 建议(清手动标记,让自动跟随重新接管)
  const followAI = () => {
    const ap = adviceForStock()
    const pricePatch = advicePlanSyncPatch({
      ...h,
      tpManual: false,
      slManual: false,
    }, ap)
    planStore.setPlanRule(h.id, {
      ...pricePatch,
      ...(ap && ap.reason ? { planReason: ap.reason } : {}),
      tpManual: false, slManual: false, reasonManual: false,
    })
  }

  const adviceEntry = getAdvice(h.code, 'hold_advice')
  const holdAdvice = adviceEntry?.advice || null
  useEffect(() => {
    if (holdAdvice) planStore.syncActionAlerts(h.code)
  }, [adviceEntry?.at, holdAdvice, h.code])
  const currentT1 = t1StatusOf(h.code)
  const decisionView = buildHoldingCardDecisionView({
    advice: holdAdvice,
    hitTarget: hitTP,
    hitStop: hitSL,
    targetPrice: effectivePlanTarget,
    stopPrice: effectivePlanStop,
    t1Status: currentT1,
    nextTradeDay: nextTradingDayLabel(),
  })

  const startSell = () => {
    const t1 = currentT1
    const suggestedLevel = decisionView?.levels.find((item) => item.key === 'reduce')
      || decisionView?.levels.find((item) => item.key === 'stop')
    const suggestedQty = (
      decisionView?.kind === 'reduce' || decisionView?.kind === 'sell'
    ) ? actionHands(decisionView.quantity) : null
    setTradeErr(t1.sellableToday > 0 ? '' : `今日买入 ${t1.boughtToday} 手仍受 T+1 锁定，当前没有可卖仓位`)
    setMode('sell')
    setSellPrice(suggestedLevel?.price != null
      ? String(suggestedLevel.price)
      : (q ? String(q.price) : ''))
    setSellQty(String(Math.min(
      suggestedQty || h.qty || 1,
      t1.sellableToday || 0,
    )))
  }
  const confirmSell = () => {
    if (!sellPrice || !(Number(sellQty) > 0)) return
    const result = planStore.sell(h.id, sellPrice, Number(sellQty))
    if (!result || !result.ok) { setTradeErr((result && result.error) || '卖出记录失败'); return }
    setTradeErr(result.message || '')
    setMode(null)
  }

  const startAdd = () => {
    const suggestedLevel = decisionView?.levels.find((item) => item.key === 'add')
    const suggestedQty = decisionView?.kind === 'add'
      ? actionHands(decisionView.quantity)
      : null
    setTradeErr('')
    setMode('add')
    setAddPrice(suggestedLevel?.price != null
      ? String(suggestedLevel.price)
      : (q ? String(q.price) : ''))
    setAddQty(String(suggestedQty || 1))
  }
  const confirmAdd = () => {
    if (!addPrice || !(Number(addQty) > 0)) return
    const result = planStore.addToHolding(
      h.id,
      addPrice,
      Number(addQty),
    )
    if (!result?.ok) {
      setTradeErr(result?.error || '加仓记录失败')
      return
    }
    setTradeErr('')
    setMode(null)
  }
  const startCostEdit = () => {
    setTradeErr('')
    setCostPrice(String(effectiveCost))
    setMode('cost')
  }
  const confirmCostEdit = () => {
    const result = planStore.updateHoldingCost(h.id, Number(costPrice))
    if (!result?.ok) {
      setTradeErr(result?.error || '成本价修改失败')
      return
    }
    setMode(null)
  }

  const startT = () => {
    setTradeErr('')
    setMode('T')
    setTPrice(quoteView.price != null ? String(quoteView.price) : '')
    setTQty('1')
    setTAdvice(null)
  }
  const addTFlow = () => {
    if (!tPrice || !(Number(tQty) > 0)) return
    const result = planStore.addTFlow(h.id, tSide, tPrice, Number(tQty))
    if (!result || !result.ok) { setTradeErr((result && result.error) || '做T流水记录失败'); return }
    setTradeErr(result.message || '')
    setTPrice(quoteView.price != null ? String(quoteView.price) : '')
    setTQty('1')
  }

  // AI 做T参考（可指定风格，切风格即用新风格重新生成）
  const askTAdvice = async (styleOverride) => {
    const useStyle = styleOverride || tStyle
    if (styleOverride && styleOverride !== tStyle) setTStyle(styleOverride)
    setTAdvice({ loading: true, phase: '正在准备分析…', sources: [], reasoning: '', quant: null })
    const onPhase = (p) => setTAdvice((s) => (s && s.loading ? { ...s, phase: p.text } : s))
    // 细粒度事件:数据源勾选清单 + 军师思维链增量,实时展示"发生了什么"
    const onEvent = (event, data) => {
      if (event === 'source' && data && data.label) {
        setTAdvice((s) => (s && s.loading ? { ...s, sources: [...(s.sources || []), { label: data.label, ok: !!data.ok }] } : s))
      } else if (event === 'reasoning' && data && data.text) {
        setTAdvice((s) => (s && s.loading ? { ...s, reasoning: (s.reasoning || '') + data.text } : s))
      } else if (event === 'quant' && data) {
        setTAdvice((s) => (s && s.loading ? { ...s, quant: data } : s))
      }
    }
    try {
      // 【实时可做T手数】必须扣掉未结算的反T卖腿：先卖后买的反T在"接回"前，底仓已经不在手里，
      // 可再做反T(先卖)的手数 = 底仓 + 净做T腿(openBuy-openSell)，卖光则为 0，绝不能拿原始底仓 h.qty 误当作还持有。
      const tNet = (tStat.openBuy || 0) - (tStat.openSell || 0)
      const liveHoldQty = Math.max(0, (h.qty || 0) + tNet)
      const latestBook = planStore.get()
      const t1 = t1StatusOf(h.code)
      const tContext = buildTActionContext(
        latestBook.holding || [],
        latestBook.closed || [],
        h.code,
      )
      const r = await callAIStream('t_advice', {
        name: h.name, code: h.code,
        nowPrice: validPx,
        pct: validPx != null ? quoteView.pct : null,
        dayHigh: q?.high, dayLow: q?.low, open: q?.open, prevClose: q?.prevClose,
        turnover: q?.turnover, volRatio: q?.volRatio,
        mainInflowYi: q ? +(q.mainInflow / 1e8).toFixed(2) : null,
        holdCost: effectiveCost, holdQty: liveHoldQty, baseQty,
        openTNet: tNet,  // 未结算做T净手数(正=已净加仓;负=已净卖出/反T未接回，底仓被占用)
        boughtTodayQty: t1.boughtToday,
        sellableTodayQty: t1.sellableToday,
        t1Locked: t1.boughtToday > 0,
        todayBuys: (t1.buys || []).map((buy) => ({
          price: buy.price,
          qty: buy.qty,
          kind: buy.kind,
        })),
        nextTradeDay: nextTradingDayLabel(),
        tradeContext: tradeActivityContext(latestBook.closed || [], h.code),
        tContext,
        style: useStyle,
      }, onPhase, undefined, onEvent)
      if (r.ok) {
        setTAdvice({ result: r.result })
        // 已经完成第一腿时按 nextSide 落到待执行的第二腿；新一轮建议才按 dir 选择第一腿。
        if (r.result.nextSide === 'buy' || r.result.nextSide === 'sell') {
          setTSide(r.result.nextSide)
        } else if (r.result.dir === 'positive') setTSide('buy')
        else if (r.result.dir === 'reverse') setTSide('sell')
      } else setTAdvice({ error: r.error || '生成失败' })
    } catch (e) { setTAdvice({ error: String(e.message || e) }) }
  }
  // 采纳建议：填入第一腿方向/价位/手数
  const adoptAdvice = () => {
    const r = tAdvice && tAdvice.result
    if (!r) return
    if (r.nextSide === 'buy' || r.nextSide === 'sell') setTSide(r.nextSide)
    else if (r.dir === 'positive') setTSide('buy')
    else if (r.dir === 'reverse') setTSide('sell')
    const nextPrice = r.nextPrice ?? r.leg1Price
    if (nextPrice) setTPrice(String(nextPrice))
    if (r.suggestQty) setTQty(String(r.suggestQty))
  }

  const flowDays = groupTFlowsByDay(h.tFlows)
  const hasPlan = !!(h.tp || h.sl || h.planReason)
  // 实时持仓手数/成本（做T后即时反映）
  const netT = (tStat.openBuy || 0) - (tStat.openSell || 0)
  const liveCost = effectiveCost
  const operationTitle = mode === 'add'
    ? '加仓'
    : mode === 'sell'
      ? '减仓 / 清仓'
      : mode === 'plan'
        ? '设置交易计划'
        : mode === 'cost'
          ? '修改成本价'
          : ''
  const isPlanEditor = mode === 'plan'
  const operationForm = mode === 'add' ? (
    <div className="buy-inline-wrap">
      <div className="buy-inline">
        <input className="wl-input" value={addPrice} onChange={(e) => setAddPrice(e.target.value)} placeholder="加仓价" inputMode="decimal" />
        <input className="wl-input" value={addQty} onChange={(e) => setAddQty(e.target.value)} placeholder="手" inputMode="numeric" />
        {addPrice && Number(addQty) > 0 && <span className="fee-hint">费≈{calcBuyFee(Number(addPrice) * Number(addQty) * 100).toFixed(2)}</span>}
        <button className="chip-btn act-add solid" onClick={confirmAdd}><Icon name="check" size={13} />确认加仓</button>
        <button className="chip-btn ghost" onClick={() => setMode(null)}>取消</button>
      </div>
    </div>
  ) : mode === 'sell' ? (
    <div className="buy-inline-wrap">
      <div className="buy-inline">
        <input className="wl-input" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} placeholder="卖出价" inputMode="decimal" />
        <input className="wl-input" value={sellQty} onChange={(e) => setSellQty(e.target.value)} placeholder="手" inputMode="numeric" />
        <span className="qty-hint">今日可卖 / {h.qty}手</span>
        {sellPrice && Number(sellQty) > 0 && <span className="fee-hint">费≈{calcSellFee(Number(sellPrice) * Number(sellQty) * 100).toFixed(2)}</span>}
        <button className={'chip-btn solid ' + (Number(sellQty) >= h.qty ? 'act-clear' : 'act-reduce')} onClick={confirmSell}><Icon name="check" size={13} />{Number(sellQty) >= h.qty ? '确认清仓' : '确认减仓'}</button>
        <button className="chip-btn ghost" onClick={() => setMode(null)}>取消</button>
      </div>
    </div>
  ) : mode === 'cost' ? (
    <div className="cost-edit-form">
      <label className="cost-edit-field">
        <span>持仓成本价（含费）</span>
        <input
          className="wl-input"
          type="number"
          min="0.001"
          step="0.001"
          inputMode="decimal"
          value={costPrice}
          onChange={(event) => {
            setCostPrice(event.target.value)
            setTradeErr('')
          }}
        />
      </label>
      <div className="cost-edit-note">
        只校准当前持仓成本，不改变现金、手数、T+1和历史成交；原手续费继续保留。
      </div>
      <div className="cost-edit-actions">
        <button className="chip-btn done" onClick={confirmCostEdit}><Icon name="check" size={12} />保存成本</button>
        <button className="chip-btn ghost" onClick={() => setMode(null)}>取消</button>
      </div>
    </div>
  ) : mode === 'plan' ? (
    <div className="plan-edit">
      <div className="plan-edit-tip">
        {planBasis && planBasis.from === 'advice'
          ? <><Icon name="spark" size={12} /> 已带入最新建议{planBasis.action ? `(${planBasis.action})` : ''}的止盈止损价</>
          : <><Icon name="spark" size={12} /> 已按短线逻辑给默认值，可直接改</>}
        <button className="plan-refill" onClick={() => { const s = suggestPlan(); setPlanTP(s.tp); setPlanSL(s.sl); setPlanReason(s.reason); setPlanBasis(null) }}>用公式</button>
        {!hasAdvicePrices() && (
          <button className="plan-refill" onClick={() => openStockDetail(h.code, h.name)} title="去个股页生成建议，返回后自动代入止盈止损价">生成建议</button>
        )}
      </div>
      {(!hasAdvicePrices() && (!planBasis || planBasis.from !== 'advice')) && (
        <div className="plan-basis">
          <span className="muted">当前使用公式默认值；生成军师建议后可自动带入止盈止损价。</span>
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
  ) : null
  return (
    <div className="hold-swipe-wrap">
      {swipe.swiping && isTouch && swipe.dx > 0 && (
        <div className={'hsw-hint hsw-right' + (swipe.dx >= 64 ? ' armed' : '')}><Icon name="chart" size={16} /><span>详情</span></div>
      )}
      <div className="trade-card hold-item" {...swipe.bind}
        data-code={h.code}
        style={swipe.dx ? { transform: `translateX(${swipe.dx}px)`, transition: swipe.swiping ? 'none' : 'transform .2s ease' } : undefined}>
      {/* 身份行聚合股票身份、现价和盈亏；仓位与成本留在稳定指标带。 */}
      <div className="hold-head">
        <div className="hold-head-l">
          <StockName
            code={h.code}
            name={h.name}
            industry={(q && q.industry) || h.industry}
          >
            <span className="hh-name">{h.name}</span>
          </StockName>
        </div>
        <div className="hold-head-market">
          {effPx != null && (
            <div
              className={
                'hold-live-quote '
                + (
                  validPx != null
                  || quoteView.status === 'AUCTION'
                    ? pctClass(quoteView.pct)
                    : 'muted'
                )
              }
            >
              <strong>{fmtRaw(effPx)}</strong>
              <span>
                {effPx === quoteView.price
                  ? quoteSecondaryText(quoteView)
                  : '最近收盘'}
              </span>
            </div>
          )}
          {pnl != null && (
            <div className={'hold-pnl ' + (pnl >= 0 ? 'red' : 'green')} title={costBasis.tRealizedPnl
              ? '相对做T后有效成本的持仓总盈亏（含已实现做T收益）'
              : '相对含费成本的浮动盈亏'}>
              <span className="hp-pct">{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%</span>
              {floatPnl != null && <span className="hp-amt">{fmtMoney(floatPnl)}</span>}
            </div>
          )}
        </div>
      </div>

      {/* 当前动作永远先于持仓快照与盘面证据。 */}
      <div className="card-decision-slot">
        <AdviceActionPanel
          view={decisionView}
          currentPrice={validPx}
          onPrompt={() => openStockDetail(h.code, h.name)}
        />
        <div className="card-decision-meta">
          <AdviceUpdatedAt
            entry={adviceEntry}
            score={h.qScore}
            bias={h.qBias}
          />
          <AdviceGenerationStatus code={h.code} />
        </div>
      </div>

      <div className="stock-card-metrics hold-card-metrics">
        <span className="stock-card-metric" title={netT !== 0 ? `底仓 ${h.qty} 手，今日做T未结算净${netT > 0 ? '买入+' : '卖出'}${netT} 手` : '当前持仓手数'}>
          <span>持仓</span>
          <strong className="stock-card-metric-value">
            {liveQty}<small>手</small>
          </strong>
          {netT !== 0 && <em>底仓 {h.qty}{netT > 0 ? '+' : ''}{netT}</em>}
        </span>
        <span className="stock-card-metric" title={`裸买入价 ${fmtRaw(h.buyPrice)} + 买入手续费 ${(h.buyFee || 0).toFixed(2)}${costBasis.tRealizedPnl ? `；累计做T收益摊薄 ${fmtMoney(costBasis.tRealizedPnl)}` : ''}`}>
          <span>成本</span>
          <span className="stock-card-metric-value-row">
            <strong className="stock-card-metric-value">{fmtRaw(liveCost)}</strong>
            <em>{costBasis.tRealizedPnl ? '做T后' : '含费'}</em>
          </span>
          <button
            type="button"
            className="hold-cost-edit"
            aria-label={`修改${h.name}成本价`}
            title="修改成本价"
            onClick={startCostEdit}
          >
            <Icon name="edit" size={11} />
          </button>
        </span>
        <span className="stock-card-metric hold-t1-metric">
          <span>今日可卖</span>
          <strong className="stock-card-metric-value">
            {currentT1.sellableToday}<small>手</small>
          </strong>
          <em>
            {currentT1.boughtToday > 0
              ? `T+1锁定${currentT1.boughtToday}手`
              : '无当日锁定'}
          </em>
        </span>
      </div>

      <MarketPulse quote={q} />

      {hasPlan && (
        <button
          type="button"
          className={
            'holding-plan-summary'
            + (hitTP ? ' hit-tp' : hitSL ? ' hit-sl' : '')
          }
          aria-haspopup="dialog"
          onClick={() => setPlanDetailOpen(true)}
        >
          <span className="holding-plan-summary-label">
            <Icon name="target" size={13} />
            计划
          </span>
          <span className="holding-plan-summary-values">
            {h.tp != null && <span>止盈 <b className="red">{fmtRaw(h.tp)}</b></span>}
            {h.sl != null && <span>止损 <b className="green">{fmtRaw(h.sl)}</b></span>}
            {h.tp == null && h.sl == null && <span>查看执行纪律</span>}
          </span>
          <Icon name="chevronRight" size={13} />
        </button>
      )}

      <StockNoteSummary
        code={h.code}
        name={h.name}
        text={stockNote}
        onOpen={() => openStockDetail(
          h.code,
          h.name,
          { focusNote: true },
        )}
      />

      {/* 操作区 */}
      {!mobileOperations && tradeErr && <div className="err" style={{ margin: '8px 0' }}>{tradeErr}</div>}
      {!(h.tp || h.sl || h.planReason) && (
        <button
          type="button"
          className="chip-btn ghost hold-plan-mobile"
          onClick={() => openPlan(false)}
        >
          <Icon name="target" size={13} />
          添加计划
        </button>
      )}
      {operationForm && !mobileOperations && mode !== 'plan' ? operationForm : (
        <div className="pi-actions">
          <div className="pi-trade-actions">
            <button className={'chip-btn act-add' + (decisionView?.kind === 'add' ? ' recommended' : '')} onClick={startAdd}>加仓</button>
            <button className="chip-btn act-t" onClick={startT}>做T</button>
            <button className={'chip-btn act-reduce' + (['reduce', 'sell'].includes(decisionView?.kind) ? ' recommended' : '')} onClick={startSell}>减仓/清仓</button>
          </div>
          <div className="pi-card-tools">
            {!(h.tp || h.sl || h.planReason) && <button className="chip-btn ghost" onClick={() => openPlan(false)}>设计划</button>}
            <button className="icon-btn act-del" aria-label={`删除${h.name}持仓`} title="删除持仓" onClick={() => setConfirmDel(true)}><Icon name="trash" size={14} /></button>
          </div>
        </div>
      )}
      {operationForm && (mobileOperations || mode === 'plan') && (
        <OverlayPortal>
          <div
            className={
              isPlanEditor
                ? 'modal-mask mobile-trade-mask plan-edit-mask'
                : 'modal-mask mobile-trade-mask'
            }
            onClick={() => setMode(null)}
          >
            <div
              className={
                isPlanEditor
                  ? 'mobile-trade-dialog plan-edit-dialog'
                  : 'mobile-trade-dialog'
              }
              role="dialog"
              aria-modal="true"
              aria-label={`${operationTitle} · ${h.name}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mobile-trade-head">
                <div>
                  <div className="modal-title">
                    {operationTitle} · {h.name}
                    <StockTags code={h.code} variant="inline" />
                  </div>
                  <span className="detail-code">{h.code}</span>
                </div>
                <button type="button" className="modal-close" aria-label={`关闭${operationTitle}弹框`} onClick={() => setMode(null)}><Icon name="close" size={16} /></button>
              </div>
              <div className="mobile-trade-body">
                {tradeErr && <div className="err" style={{ marginBottom: 10 }}>{tradeErr}</div>}
                {operationForm}
              </div>
            </div>
          </div>
        </OverlayPortal>
      )}

      <HoldingPlanDialog
        open={planDetailOpen && hasPlan}
        holding={h}
        aiPlan={aiPlan}
        hitTP={hitTP}
        hitSL={hitSL}
        play={play}
        onClose={() => setPlanDetailOpen(false)}
        onEdit={() => openPlan(true)}
        onClear={() => {
          planStore.clearPlanRule(h.id)
          setPlanDetailOpen(false)
        }}
        onFollow={followAI}
      />

      {confirmDel && (
        <ConfirmDialog
          title="删除此持仓？"
          body={<>确定删除持仓 <b>{h.name}</b>（{h.code}，{h.qty}手）<StockTags code={h.code} variant="inline" />？该持仓上已配对的做T收益会归档进交易记录，不会丢失；但这笔持仓本身将从列表移除。</>}
          confirmText="删除持仓"
          onConfirm={() => { planStore.removeHolding(h.id); setConfirmDel(false) }}
          onCancel={() => setConfirmDel(false)}
        />
      )}

      {confirmSettle && (
        <ConfirmDialog
          title="结算做T入账？"
          body={<>
            确定把 <b>{h.name}</b><StockTags code={h.code} variant="inline" /> 今天的 {h.tFlows?.length || 0} 笔做T流水结算入账吗？结算后：
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              {tStat.realized !== 0 && <li>配对差价 <b className={tStat.realized >= 0 ? 'red' : 'green'}>{fmtMoney(tStat.realized)}</b> 计入交易记录（做T）</li>}
              {tStat.openBuy > 0 && <li>净买入 <b className="red">{tStat.openBuy}手</b> → 加仓，底仓成本按加权平均更新</li>}
              {tStat.openSell > 0 && <li>净卖出 <b className="green">{tStat.openSell}手</b> → {tStat.openSell >= h.qty ? '清仓（自动回归自选股，继续盯盘）' : '减仓'}</li>}
              <li>做T流水清空，结算不可撤销</li>
            </ul>
          </>}
          confirmText="确认结算"
          onConfirm={() => { planStore.settleTFlows(h.id); setConfirmSettle(false) }}
          onCancel={() => setConfirmSettle(false)}
        />
      )}

      {/* 做T：独立居中弹窗，保留足够宽度展示策略与交易输入。 */}
      {mode === 'T' && (
        <OverlayPortal>
          <div className="modal-mask t-trade-mask" onClick={() => setMode(null)}>
            <div
              className="t-drawer"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`t-dialog-title-${h.id}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="t-drawer-head">
                <div className="modal-title" id={`t-dialog-title-${h.id}`}>
                  <Icon name="refresh" size={16} /> 做T · {h.name}
                  <span className="detail-code">{h.code}</span>
                  <StockTags code={h.code} variant="inline" />
                </div>
                <button type="button" className="modal-close" aria-label="关闭做T弹层" onClick={() => setMode(null)}><Icon name="close" size={16} /></button>
              </div>
              <div className="t-drawer-body">
                {tradeErr && <div className="err" style={{ marginBottom: 10 }}>{tradeErr}</div>}
              {/* 持仓概览 */}
              <div className="t-drawer-meta">
                <span>{liveQty}手</span><span title={`原始含费成本 ${fmtRaw(rawCostWithFee)}${costBasis.tRealizedPnl ? `；累计做T收益 ${fmtMoney(costBasis.tRealizedPnl)}` : ''}`}>成本 {fmtRaw(effectiveCost)} <span className="sub-name">{costBasis.tRealizedPnl ? '(做T后)' : '(含费)'}</span></span>
                {q && (
                  <span>
                    现价 <b className={
                      validPx != null
                      || quoteView.status === 'AUCTION'
                        ? pctClass(quoteView.pct)
                        : 'muted'
                    }>
                      {fmtRaw(effPx)}
                    </b>
                    {' '}{quoteSecondaryText(quoteView)}
                  </span>
                )}
                {costBasis.tRealizedPnl !== 0 && <span>累计做T收益 <b className={costBasis.tRealizedPnl >= 0 ? 'red' : 'green'}>{fmtMoney(costBasis.tRealizedPnl)}</b></span>}
                {h.tFlows && h.tFlows.length > 0 && (
                  <button className="chip-btn done t-settle-btn" style={{ marginLeft: 'auto' }} onClick={() => { setConfirmSettle(true) }} title="把今天的做T流水固化进交易记录并调整底仓">
                    <Icon name="check" size={12} />结算入账
                  </button>
                )}
              </div>
              {manualTradePairs.length > 0 && (
                <div className="t-record-pairs">
                  <div className="t-record-pairs-head">
                    <Icon name="refresh" size={12} />
                    <span>交易记录已配对</span>
                    <b>{manualTradePairs.length}组</b>
                  </div>
                  <div className="t-record-pairs-list">
                    {manualTradePairs.slice(0, 5).map((record) => (
                      <div className="t-record-pair" key={record.id}>
                        <span>{dayKeyOf(record.at).slice(5)}</span>
                        <span>{fmtRaw(record.buyPrice)} → {fmtRaw(record.sellPrice)}</span>
                        <span>{record.qty}手</span>
                        <b className={record.realizedPnl >= 0 ? 'red' : 'green'}>
                          {fmtMoney(record.realizedPnl)}
                        </b>
                      </div>
                    ))}
                  </div>
                </div>
              )}
        <div className="t-panel">
          {/* AI 做T参考 */}
          <div className="t-ai">
            {/* 风格选择：默认「自动」由 AI 按该股历史规律选定 */}
            <div className="t-style">
              <span className="t-style-label">风格</span>
              {[['auto', '自动'], ['conservative', '稳健'], ['balanced', '均衡'], ['aggressive', '激进']].map(([k, label]) => (
                <button key={k} className={'t-style-btn' + (tStyle === k ? ' active ' + k : '')} onClick={() => askTAdvice(k)} title={k === 'auto' ? '根据这只股的历史规律自动选择风格和做T方向' : ''}>{label}</button>
              ))}
            </div>
            {!tAdvice && (
              <button className="t-ai-btn" onClick={() => askTAdvice()}><Icon name="spark" size={14} />{tStyle === 'auto' ? '按历史规律生成做T策略' : `生成做T参考（${tStyle === 'conservative' ? '稳健' : tStyle === 'aggressive' ? '激进' : '均衡'}）`}</button>
            )}
            {tAdvice && tAdvice.loading && (
              <div className="t-ai-loading-wrap">
                <div className="t-ai-loading"><Icon name="refresh" size={13} className="spin" />{tAdvice.phase || '正在分析历史规律、分时、大盘和资金…'}</div>
                {visibleAiSources(searchConfig.enabled, tAdvice.sources).length > 0 && (
                  <div className="adv-sources">
                    {visibleAiSources(searchConfig.enabled, tAdvice.sources).map((s, i) => (
                      <span className={'adv-src' + (s.ok ? ' ok' : ' none')} key={s.label + i}>
                        <Icon name={s.ok ? 'check' : 'close'} size={11} /> {s.label}
                      </span>
                    ))}
                  </div>
                )}
                {tAdvice.quant && (
                  <div className="adv-quant">
                    <div className="adv-quant-head"><Icon name="activity" size={12} /> 量化模型结论</div>
                    <div className="adv-quant-body">{tAdvice.quant.summary || '已完成打分'}</div>
                  </div>
                )}
                {tAdvice.reasoning && (
                  <div className="adv-reasoning">
                    <div className="adv-reasoning-head"><Icon name="brain" size={12} /> 军师推理过程</div>
                    <div className="adv-reasoning-body" ref={(el) => { if (el) el.scrollTop = el.scrollHeight }}><HL text={tAdvice.reasoning} /></div>
                  </div>
                )}
              </div>
            )}
            {tAdvice && tAdvice.error && <div className="err">{tAdvice.error} <button type="button" className="expand-btn" onClick={askTAdvice}>重试</button></div>}
            {tAdvice && tAdvice.result && (
              <div className={'t-ai-card ' + (tAdvice.result.light || 'yellow')}>
                <div className="t-ai-head">
                  <span className="t-ai-badge">{tAdvice.result.dirLabel || tAdvice.result.advisable}</span>
                  {tAdvice.result.chosenStyle && <span className={'t-style-tag ' + tAdvice.result.chosenStyle}>{{ conservative: '稳健', balanced: '均衡', aggressive: '激进' }[tAdvice.result.chosenStyle] || tAdvice.result.chosenStyle}</span>}
                  {tAdvice.result.confidence && <span className="t-conf">信心 {tAdvice.result.confidence}</span>}
                  <div className="t-ai-actions" style={{ marginLeft: 'auto' }}>
                    <button type="button" className="expand-btn" onClick={() => askTAdvice()}>重新生成</button>
                    <button type="button" className="expand-btn" onClick={() => setTAdvice(null)}>收起</button>
                  </div>
                </div>
                {(tAdvice.truncated || tAdvice.result.truncated) && (
                  <div className="t-ai-warn"><Icon name="shield" size={12} /> 内容较长被截断，已展示已生成部分，可点「重新生成」重试</div>
                )}
                {tAdvice.result.raw && (
                  <div className="t-ai-plain" style={{ whiteSpace: 'pre-wrap' }}><HL text={tAdvice.result.raw} /></div>
                )}
                {tAdvice.result.reasoning && (
                  <Reasoning text={tAdvice.result.reasoning} />
                )}
                {tAdvice.result.actionPlan && (
                  <div className="t-ai-plan"><Icon name="target" size={13} /><span className="t-ai-plan-k">这样操作</span><HL text={tAdvice.result.actionPlan} /></div>
                )}
                {tAdvice.result.histPattern && (
                  <div className="t-ai-hist"><Icon name="history" size={12} /><span>历史规律</span><HL text={tAdvice.result.histPattern} /></div>
                )}
                {tAdvice.result.plain && <div className="t-ai-plain"><HL text={tAdvice.result.plain} /></div>}
                <div className="t-ai-basis">
                  {tAdvice.result.styleReason && <div className="t-basis-row"><span className="t-basis-k">选型</span><HL text={tAdvice.result.styleReason} /></div>}
                  {tAdvice.result.marketNote && <div className="t-basis-row"><span className="t-basis-k">大盘</span><HL text={tAdvice.result.marketNote} /></div>}
                  {tAdvice.result.stockNote && <div className="t-basis-row"><span className="t-basis-k">盘面</span><HL text={tAdvice.result.stockNote} /></div>}
                  {tAdvice.result.fundNote && <div className="t-basis-row"><span className="t-basis-k">资金</span><HL text={tAdvice.result.fundNote} /></div>}
                  {(tAdvice.result.support || tAdvice.result.resistance) && (
                    <div className="t-basis-row"><span className="t-basis-k">支撑压力</span>支撑 <b className="green">{tAdvice.result.support ?? '--'}</b> · 压力 <b className="red">{tAdvice.result.resistance ?? '--'}</b></div>
                  )}
                  {tAdvice.result.quantNote && <div className="t-basis-row"><span className="t-basis-k quant">量化</span><HL text={tAdvice.result.quantNote} /></div>}
                  {tAdvice.result.newsNote && <div className="t-basis-row"><span className="t-basis-k">消息</span><HL text={tAdvice.result.newsNote} /></div>}
                  {tAdvice.result.macroNote && <div className="t-basis-row"><span className="t-basis-k">宏观</span><HL text={tAdvice.result.macroNote} /></div>}
                  {tAdvice.result.riskReward && <div className="t-basis-row"><span className="t-basis-k">盈亏比</span>{tAdvice.result.riskReward}</div>}
                  {tAdvice.result.bearCase && <div className="t-basis-row"><span className="t-basis-k">反方</span><HL text={tAdvice.result.bearCase} /></div>}
                  {tAdvice.result.invalidation && <div className="t-basis-row"><span className="t-basis-k theory">失效</span><HL text={tAdvice.result.invalidation} /></div>}
                  {tAdvice.result.theory && <div className="t-basis-row"><span className="t-basis-k theory">理论</span><HL text={tAdvice.result.theory} /></div>}
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
                {tAdvice.result.addOn && <div className="t-ai-addon"><Icon name="bolt" size={12} />加码：<HL text={tAdvice.result.addOn} /></div>}
                {tAdvice.result.risk && <div className="t-ai-risk"><Icon name="shield" size={12} /><HL text={tAdvice.result.risk} /></div>}
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
                    <button type="button" className="t-day-head" onClick={() => setOpenDays((s) => ({ ...s, [d.key]: !expanded }))}>
                      <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
                      <span className="t-day-label">{d.label}</span>
                      <span className="t-day-count">{d.count}笔</span>
                      <span className={'t-day-net ' + (d.realized >= 0 ? 'red' : 'green')}>{fmtMoney(d.realized)}</span>
                    </button>
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
        </OverlayPortal>
      )}
    </div>
    </div>
  )
}

// 单条做T流水行：展示 + 就地编辑（价格精确到3位小数、可改方向/手数）
function TFlowRow({ f, holdingId }) {
  const [editing, setEditing] = useState(false)
  const [side, setSide] = useState(f.side)
  const [price, setPrice] = useState(String(f.price))
  const [qty, setQty] = useState(String(f.qty))
  const [date, setDate] = useState(dayKeyOf(f.at))
  const [error, setError] = useState('')

  const start = () => {
    setError('')
    setSide(f.side)
    setPrice(String(f.price))
    setQty(String(f.qty))
    setDate(dayKeyOf(f.at))
    setEditing(true)
  }
  const save = () => {
    const result = planStore.editTFlow(holdingId, f.id, { side, price: Number(price), qty: Number(qty) })
    if (!result || !result.ok) { setError((result && result.error) || '流水修改失败'); return }
    if (date !== dayKeyOf(f.at)) {
      const dateResult = planStore.updateTFlowDate(holdingId, f.id, date)
      if (!dateResult || !dateResult.ok) {
        setError((dateResult && dateResult.error) || '日期修改失败')
        return
      }
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="t-flow-row t-flow-edit">
        <div className="t-side-toggle">
          <button className={'t-side-btn buy' + (side === 'buy' ? ' active' : '')} onClick={() => setSide('buy')}>买</button>
          <button className={'t-side-btn sell' + (side === 'sell' ? ' active' : '')} onClick={() => setSide('sell')}>卖</button>
        </div>
        <input className="wl-input t-edit-price" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="单价" inputMode="decimal" />
        <input className="wl-input t-edit-qty" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="手" inputMode="numeric" />
        <input
          className="wl-input t-edit-date"
          type="date"
          value={date}
          max={dayKeyOf(Date.now())}
          onChange={(event) => { setDate(event.target.value); setError('') }}
        />
        <button className="chip-btn done" onClick={save}><Icon name="check" size={12} />保存</button>
        <button className="chip-btn ghost" onClick={() => setEditing(false)}>取消</button>
        {error && <span className="err">{error}</span>}
      </div>
    )
  }
  return (
    <div className="t-flow-row">
      <span className={'t-flow-side ' + f.side}>{f.side === 'buy' ? '买' : '卖'}</span>
      <span className="t-flow-p">{fmtRaw(f.price)} × {f.qty}手</span>
      <span className="t-flow-fee">费{f.fee.toFixed(2)}</span>
      <span className="t-flow-time">{dayKeyOf(f.at).slice(5)} {new Date(f.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      <button type="button" className="t-flow-edit-btn" title="编辑此笔" onClick={start}><Icon name="edit" size={12} /></button>
      <button type="button" className="del" title="删除此笔" onClick={() => planStore.removeTFlow(holdingId, f.id)}>×</button>
    </div>
  )
}

// ---------- 持仓卡上的复盘结论条（完全复用 AI 操作建议生成的内容，纯展示，无按钮/无定时任务）----------
// 数据源唯一化：直接读 adviceCache 里最新一次「AI 操作建议」(hold_advice/buy_advice)，
// 里面已带 todayRecap/tradeReview(今日回顾)、actionPlan(下一步)、theoryNote/invalidation 等复盘价值字段。
// AI 操作建议生成一次即可供复盘、主行动条、止盈止损全部复用，用户不必再单独点「生成复盘」。
function HoldReview({ code, name, cost, qty, price }) {
  const [, force] = useState(0)
  const [open, setOpen] = useState(false) // 展开完整细节
  // 订阅建议缓存：AI 操作建议刷新时本卡自动跟随更新
  useEffect(() => subscribeAdvice(() => force((n) => n + 1)), [])
  const a = getAdvice(code, 'hold_advice')
  const adv = a && a.advice
  // 把 AI 操作建议标准化成复盘展示口径：动作/结论/今日回顾/下一步/理论/失效
  const r = adv ? {
    stance: adv.action || adv.stance || '',
    headline: adv.title || adv.actionPlan || adv.reason || '',
    reasoning: adv.reasoning || '',
    todayRecap: adv.todayRecap || '',
    tradeReview: adv.tradeReview || '',
    nextAction: adv.actionPlan || adv.timing || '',
    exitTiming: adv.exitTiming || '',
    nextOpenPlan: adv.nextOpenPlan || '',
    futurePlan: adv.futurePlan || '',
    theoryNote: adv.theoryNote || '',
    invalidation: adv.invalidation || '',
    tone: adv.tone || 'muted',
  } : null
  const tone = r ? (r.tone || 'muted') : 'muted'
  const ts = a ? new Date(a.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
  if (!r) {
    return (
      <div className="hold-review rev-muted">
        <div className="hr-top minimal">
          <span className="hr-badge"><Icon name="history" size={12} /> 复盘</span>
        </div>
        <button className="hr-goadvice" onClick={() => openStockDetail(code, name)}>
          <Icon name="target" size={12} />
          <span>复盘与操作指导已合并到 <b>军师建议</b>，点此生成一次即可</span>
          <Icon name="chevronRight" size={13} />
        </button>
      </div>
    )
  }
  return (
    <div className={'hold-review rev-' + tone}>
      {/* ① 顶部元信息条：徽标 + 时间（内容取自 AI 操作建议，无按钮/无定时任务）*/}
      <div className="hr-top minimal">
        <span className="hr-badge"><Icon name="history" size={12} /> 复盘</span>
        <span className="hr-sess close">同源军师建议</span>
        {ts && <span className="hr-time">{ts}</span>}
      </div>

      {/* ② 结论行：只保留“动作 + 一句话结论” */}
      <button type="button" className={'hr-verdict tone-' + tone} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {r.stance && <span className={'hr-stance tone-' + tone}>{r.stance}</span>}
        <span className="hr-headline">{r.headline || r.stance}</span>
      </button>

      {/* ReAct 研判思路：复盘结论背后的推理链 */}
      {r.reasoning && (
        <Reasoning text={r.reasoning} style={{ margin: '8px 10px 0' }} />
      )}

      {/* ③ 今日回顾：AI 操作建议里带的 todayRecap/tradeReview——今天走成啥样 + 操作点评 */}
      {(r.todayRecap || (r.tradeReview && r.tradeReview !== '今日无成交')) && (
        <div className="hr-recap">
          {r.todayRecap && <div className="hr-recap-row"><span className="hr-recap-k">今日</span><span>{r.todayRecap}</span></div>}
          {r.tradeReview && r.tradeReview !== '今日无成交' && <div className="hr-recap-row"><span className="hr-recap-k">操作点评</span><span>{r.tradeReview}</span></div>}
        </div>
      )}

      {/* ④ 下一步方向：直接用 AI 操作建议的 actionPlan(一句可照做的操作) */}
      {r.nextAction && (
        <div className="hr-next compact">
          <span className="hr-next-k">下一步</span>
          <span className="hr-next-txt"><HL text={r.nextAction} /></span>
        </div>
      )}

      {/* ④a 到价后怎么做：把"见价即砍"升级为"到价→看信号确认→再执行"，避免被瞬时插针骗出局 */}
      {r.exitTiming && (
        <div className="advice-exit-timing" style={{ margin: '8px 10px 0' }}>
          <Icon name="shield" size={13} /> <b>到价后怎么做</b>：<HL text={r.exitTiming} />
        </div>
      )}

      {/* ④b 两段式指导：下个开盘时段怎么做 + 未来后续路径(今天买不了不必硬买) */}
      {(r.nextOpenPlan || r.futurePlan) && (
        <div className="advice-horizon" style={{ margin: '8px 10px 0' }}>
          {r.nextOpenPlan && <div className="ah-row now"><span className="ah-k">下个开盘</span><span className="ah-v"><HL text={r.nextOpenPlan} /></span></div>}
          {r.futurePlan && <div className="ah-row future"><span className="ah-k">未来</span><span className="ah-v"><HL text={r.futurePlan} /></span></div>}
        </div>
      )}

      {/* ⑤ 分工引导：想看此刻具体买卖价/加减仓算账 → 去详情页看完整 AI 操作建议 */}
      <button className="hr-goadvice" onClick={() => openStockDetail(code, name)}>
        <Icon name="target" size={12} />
        <span>想看此刻<b>具体买卖价 / 加减仓算账</b>？打开军师建议</span>
        <Icon name="chevronRight" size={13} />
      </button>

      {/* ⑥ 理论 + 失效信号：风控底线，其余明细都在操作建议里 */}
      {r.theoryNote && (
        <div className="hr-row" style={{ margin: '8px 10px 0' }}><span className="hr-k theory">理论</span><span className="hr-v"><HL text={r.theoryNote} /></span></div>
      )}
      {r.invalidation && (
        <div className="hr-row" style={{ margin: '8px 10px 0' }}><span className="hr-k risk">失效</span><span className="hr-v"><HL text={r.invalidation} /></span></div>
      )}
    </div>
  )
}
