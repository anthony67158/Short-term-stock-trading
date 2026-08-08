import { useState, useMemo, useEffect, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import Icon from './Icon'
import Reasoning from './Reasoning'
import { HL } from './RichText'
import { usePolling } from '../hooks'
import { fmtPct, pctClass, fmtRaw, fmtNum, hasVal, opText } from '../format'
import { aiStore } from '../aiStore'
import { api } from '../apiBase'
import { usePlanStore, planStore, computeTFlows, computePortfolio, t1StatusOf } from '../planStore'
import { nextTradingDayLabel } from '../review'
import { getAdvice, subscribeAdvice } from '../adviceCache'
import { subscribeRunner, isRunning, getRunning, getResult } from '../adviceRunner'
import { tryStartAdvice, generatingList } from '../adviceGate'
import { subscribeBatch, getBatchState } from '../adviceBatch'
import { detailStore } from '../detailStore'
import { AlertForm } from './AlertCenter'

// 把公司网址补全为可点击的绝对 URL（东财 F10 常给不带协议的裸域名）
function normalizeUrl(raw) {
  if (!raw) return null
  let u = String(raw).trim().split(/[,;，、\s]+/)[0] // 只取第一个
  if (!u || u === '-' || u === '--') return null
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u
  try { new URL(u); return u } catch { return null }
}
// 成交量（手）友好显示
function fmtVol(v) {
  if (v == null || isNaN(v)) return '--'
  const a = Math.abs(v)
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿手'
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万手'
  return Math.round(v) + '手'
}
// 把纯文本里的网址/域名渲染成可点击链接（公司简介里常带参考网站）
function Linkify({ text }) {
  if (!text) return null
  // 匹配 http(s):// 链接，或 www./裸域名(含常见后缀)
  const re = /(https?:\/\/[^\s，。；、）)]+|www\.[^\s，。；、）)]+|[a-zA-Z0-9-]+\.(?:com|cn|net|org|com\.cn)(?:\/[^\s，。；、）)]*)?)/g
  const out = []
  let last = 0, m, i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const raw = m[0]
    const href = /^https?:\/\//i.test(raw) ? raw : 'http://' + raw
    out.push(
      <a key={i++} href={href} target="_blank" rel="noopener noreferrer" className="inline-link">{raw}</a>
    )
    last = m.index + raw.length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

// 个股详情弹窗：代码 + 主营业务 + 分时/K线图
export default function StockDetail({ stock, onClose }) {
  const [mode, setMode] = useState('kline') // kline K线 | trend 分时
  const [klt, setKlt] = useState('101') // 101日 102周 103月
  const [chartType, setChartType] = useState('candle') // candle | line
  const [refreshing, setRefreshing] = useState(false) // 手动刷新中（保证转圈可见）
  const [refreshedAt, setRefreshedAt] = useState(null) // 最近一次成功刷新时间
  const [quantState, setQuantState] = useState(null) // 操作建议：null未取 | {loading} | {result} | {error}
  const [showTech, setShowTech] = useState(false) // 专业技术指标默认收起
  const [showForecast, setShowForecast] = useState(false) // 走势预测(蒙特卡洛)默认折叠
  const [showMa, setShowMa] = useState(false) // OHLC/MA 网格默认折叠
  const [showInfo, setShowInfo] = useState(false) // 公司简介默认折叠
  const [showBasis, setShowBasis] = useState(false) // AI建议深度分析(依据/风险)默认折叠,先给关键结论
  const [busyModal, setBusyModal] = useState(null) // 端点已满提示:{ busy:[{code,name}], concurrency } | null
  const book = usePlanStore()
  // 账户全景(总资产/可用现金/总仓位/单票占比)——供 AI 按资金和仓位算具体手数。
  // ★不要依赖 overview(它在后面才定义，提前引用会触发 TDZ 报错导致弹窗白屏)；
  //   computePortfolio 对无实时报价的持仓会退回其 buyPrice 估值，足够给 AI 做仓位约束。
  const portfolio = useMemo(() => {
    return computePortfolio(book.holding || [], {}, book.account || null)
  }, [book.holding, book.account])
  // 该股持仓（可能多笔）→ 加权成本，用于给"加/减/做T"建议；未持仓则给"买/观望"
  // ★关键：做T在结算前，未配对的那条腿实质已改变持仓——净买入腿=已加仓、净卖出腿=已减仓。
  //   所以传给 AI 的"当前持仓"必须按【实时持仓】口径(底仓±未结算做T净额)，而不是原始底仓。
  const myHold = useMemo(() => {
    const hs = (book.holding || []).filter((h) => h.code === (stock && stock.code))
    if (!hs.length) return null
    let qty = 0, costSum = 0     // 实时持仓手数 / 成本×手数(用于加权)
    let hasOpenT = false, tNetHands = 0
    for (const h of hs) {
      const baseQty = h.qty || 0
      const baseCost = h.buyPrice || 0
      // 该笔未结算做T流水的净额
      const r = computeTFlows(h.tFlows)
      const openBuy = r.openBuy || 0, openSell = r.openSell || 0
      const net = openBuy - openSell
      if (h.tFlows && h.tFlows.length) hasOpenT = hasOpenT || (openBuy > 0 || openSell > 0)
      tNetHands += net
      // 实时手数 = 底仓 + 净做T腿(可正可负)
      const liveQty = Math.max(0, baseQty + net)
      // 实时成本：净买入按其挂单均价并入加权；净卖出减手数、成本沿用底仓成本(卖出不改单位成本)
      let cost = baseCost
      if (openBuy > 0 && r.openBuyAvg != null && (baseQty + openBuy) > 0) {
        cost = ((baseCost * baseQty) + (r.openBuyAvg * openBuy)) / (baseQty + openBuy)
      }
      qty += liveQty
      costSum += cost * liveQty
    }
    if (qty <= 0) return null
    return {
      cost: +(costSum / qty).toFixed(3),
      qty,
      hasOpenT,          // 是否有未结算做T
      tNetHands,         // 未结算做T净手数(正=已净加仓/负=已净减仓)
    }
  }, [book.holding, stock && stock.code])
  // 切换股票时：重置各折叠区
  useEffect(() => {
    setShowTech(false); setShowForecast(false); setShowMa(false); setShowInfo(false)
  }, [stock && stock.code])
  // 操作建议状态源（三级优先）：①后台 runner 正在跑 → 展示实时进度；②本会话刚跑完的瞬时结果
  // (含 error/adviceMissing/truncated)；③持久缓存(关闭再进/刷新仍可见)。订阅 runner：即使
  // 关闭弹窗后台仍在生成，重新打开时 sync() 会按当前 code 拉到「后台生成中」或已完成的结果。
  useEffect(() => {
    const code = stock && stock.code
    if (!code) { setQuantState(null); return }
    const sync = () => {
      if (isRunning(code)) {
        const r = getRunning(code)
        setQuantState({ loading: true, phase: r && r.phase, sources: (r && r.sources) || [], reasoning: (r && r.reasoning) || '', quant: (r && r.quant) || null })
        return
      }
      const res = getResult(code)
      if (res && res.pending) {
        // 本地生成中断→已转云端继续,展示中转 loading,待云端回灌自动切成品
        setQuantState({ loading: true, cloud: true, phase: (res.error && String(res.error)) || '云端继续生成中,稍候自动刷新…', sources: [], reasoning: '', quant: null })
        return
      }
      if (res) {
        setQuantState(res.error
          ? { error: res.error }
          : { result: res.result, advice: res.advice, meta: res.meta, news: res.news,
              adviceMissing: res.adviceMissing, truncated: res.truncated, cachedAt: res.cachedAt })
        return
      }
      // 服务端(云端)批量/按需生成:该股在 FC 上生成,本机 isRunning 为 false。
      // 若它出现在批量进度的 current(正在跑)或仍是 pending/running 项 → 展示「云端生成中」,
      // 待结果经 authStore.pull 回灌 adviceCache 后自动切成品(见下方 subscribeAdvice)。
      try {
        const bs = getBatchState()
        if (bs && bs.serverMode && bs.running) {
          const c = String(code)
          const inCurrent = (bs.current || []).map(String).includes(c)
          const it = (bs.items || []).find((x) => String(x.code) === c)
          if (inCurrent || (it && (it.status === 'running' || it.status === 'pending'))) {
            const cloudPhase = inCurrent || (it && it.status === 'running')
              ? '云端生成中…(退到后台/关页面也在跑,完成后自动刷新)'
              : '已排队,等待云端端点空出…'
            setQuantState({ loading: true, phase: cloudPhase, cloud: true, sources: [], reasoning: '', quant: null })
            return
          }
          // 云端已把该股标记为失败 → 如实提示生成失败(不做假成功)
          if (it && it.status === 'fail') {
            setQuantState({ error: (it.error && String(it.error)) || '生成失败,请重试' })
            return
          }
        }
      } catch { /* ignore */ }
      const cached = getAdvice(code)
      setQuantState(cached
        ? { result: cached.result, advice: cached.advice, meta: cached.meta, news: cached.news, truncated: cached.truncated, cachedAt: cached.at }
        : null)
    }
    sync()
    const unRunner = subscribeRunner(sync)
    const unBatch = subscribeBatch(sync)   // 服务端批量进度回灌 → 云端生成中/失败态实时反映
    const unAdvice = subscribeAdvice(sync) // 云端结果回灌 adviceCache → 自动切成品
    return () => { unRunner(); unBatch(); unAdvice() }
  }, [stock && stock.code])
  const loadQuant = () => {
    if (!stock) return
    const hp = myHold ? `&holdCost=${myHold.cost}&holdQty=${myHold.qty}` : ''
    const quantUrl = api(`/api/stock_detail?code=${stock.code}&klt=101&lmt=60&quant=1${hp}&_t=${Date.now()}`)
    // 军师历史战绩（真实回测胜率），传给后端做自我校准：历史越差越收紧信心
    const advisorTrack = (() => {
      try {
        const s = planStore.adviceStats()
        if (!s || s.total < 5) return null // 样本太少不校准，避免噪声
        const g = (s.groups || []).find((x) => x.mode === (myHold ? 'hold_advice' : 'buy_advice')) || null
        // 各操盘理论的真实命中率 → 让军师优先采信在你这些票上"实测更灵"的理论、给低命中理论降权
        let theoryScores = null
        try {
          const t = planStore.theoryStats()
          const tg = (t && t.groups || []).filter((x) => x.total >= 3) // 每个理论≥3样本才纳入,避免噪声
          if (tg.length) theoryScores = tg.map((x) => ({ theory: x.theory, winRate: x.winRate, total: x.total, avgPct: x.avgPct }))
        } catch { /* ignore */ }
        return {
          overallWinRate: s.winRate, overallAvgPct: s.avgPct, overallTotal: s.total,
          modeWinRate: g ? g.winRate : null, modeAvgPct: g ? g.avgPct : null, modeTotal: g ? g.total : 0,
          theoryScores,
        }
      } catch { return null }
    })()
    const account = {
      totalAssets: (portfolio && portfolio.totalAssets) ?? (book.account && book.account.totalAssets) ?? null,
      cash: (portfolio && portfolio.available) ?? (book.account && book.account.cash) ?? null,
      position: portfolio && portfolio.position != null ? portfolio.position : null,
      holdMktValue: portfolio && portfolio.holdMktValue != null ? portfolio.holdMktValue : null,
      goal: portfolio && portfolio.goal != null ? portfolio.goal : null,
      goalProgress: portfolio && portfolio.goalProgress != null ? portfolio.goalProgress : null,
      goalGap: portfolio && portfolio.goalGap != null ? portfolio.goalGap : null,
      goalReturnPct: portfolio && portfolio.goalReturnPct != null ? portfolio.goalReturnPct : null,
    }
    // 持仓 → LLM 给"加/减/持有/清仓 + 具体价位"；未持仓 → LLM 给"买入/等回调/观望 结论 + 对应建议"
    const aiPayload = myHold
      ? {
          code: stock.code,
          name: (profile && profile.name) || stock.name,
          holdCost: myHold.cost,
          holdQty: myHold.qty,
          openTNet: myHold.hasOpenT ? myHold.tNetHands : 0,
          // T+1 买入时间锁定:今日买入手数当日不可卖,注入军师使其不建议卖/减超过今日可卖手数
          ...(() => {
            try {
              const t1 = t1StatusOf(stock.code)
              if (!t1) return {}
              return {
                boughtTodayQty: t1.boughtToday,
                sellableTodayQty: t1.sellableToday != null ? t1.sellableToday : myHold.qty,
                t1Locked: t1.boughtToday > 0,
                todayBuys: (t1.buys || []).map((b) => ({ price: b.price, qty: b.qty, kind: b.kind })),
                nextTradeDay: nextTradingDayLabel(),
              }
            } catch { return {} }
          })(),
          advisorTrack,
          account: {
            ...account,
            stockWeight: (() => {
              const p = portfolio && portfolio.positions ? portfolio.positions.find((x) => x.code === stock.code) : null
              return p && p.weight != null ? p.weight : null
            })(),
          },
        }
      : {
          code: stock.code,
          name: (profile && profile.name) || stock.name,
          advisorTrack,
          account,
        }
    const priceHint = (overview && overview.price) || myHold?.cost || null
    // ★关键★ 生成流程交给模块级后台 runner：关闭弹窗也照跑完、落缓存、记决策；
    // 本组件仅订阅 runner + 缓存来展示进度/结果（见下方 useEffect）。
    // 经门控层触发:并发已满 → 不启动,弹「端点已满 + 正在生成清单」;该股已在生成 → 复用进度不重复触发。
    const r = tryStartAdvice({
      code: stock.code,
      mode: myHold ? 'hold_advice' : 'buy_advice',
      name: (profile && profile.name) || stock.name,
      myHold: !!myHold,
      aiPayload,
      quantUrl,
      priceHint,
    })
    if (r && r.status === 'full') setBusyModal({ busy: r.busy || [], concurrency: r.concurrency || 0 })
  }
  const [showAlert, setShowAlert] = useState(false) // 设预警表单开关
  // 端点已满弹窗打开时,订阅本地/云端生成进度 → 实时刷新「正在生成」清单;
  // 有端点腾空(清单减少到并发上限以下)则自动关闭弹窗,方便用户马上重试。
  useEffect(() => {
    if (!busyModal) return
    const refresh = () => {
      const busy = generatingList().filter((x) => x.code !== (stock && stock.code))
      if (busy.length < (busyModal.concurrency || 1)) { setBusyModal(null); return }
      setBusyModal((m) => (m ? { ...m, busy } : m))
    }
    const unsub = subscribeBatch(refresh)
    const unsubR = subscribeRunner(refresh)
    return () => { unsub(); unsubR() }
    // eslint-disable-next-line
  }, [busyModal, stock && stock.code])
  const { data, loading, error, reload } = usePolling(
    stock ? `/api/stock_detail?code=${stock.code}&klt=${klt}&lmt=120&trends=1` : null,
    600000, // 详情不需要频繁刷新
    [stock && stock.code, klt]
  )

  // 手动刷新：破缓存重拉 + 转圈至少 600ms + 完成后记录更新时间
  const doRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    retryRef.current = 0
    const started = Date.now()
    try { await reload() } catch { /* usePolling 内部已兜底 */ }
    const wait = Math.max(0, 600 - (Date.now() - started))
    setTimeout(() => { setRefreshing(false); setRefreshedAt(Date.now()) }, wait)
  }

  const profile = data && data.profile
  const candles = (data && data.candles) || []
  const trends = (data && data.trends) || []
  const preClose = data && data.preClose
  const tech = data && data.tech

  // K线为空时自动重试（东财偶发空响应）：最多重试 2 次，间隔递增
  const retryRef = useRef(0)
  useEffect(() => {
    retryRef.current = 0 // 换股/换周期时重置
  }, [stock && stock.code, klt])
  useEffect(() => {
    if (!stock) return
    // 加载完成、无错误，但 candles 为空 → 说明数据源瞬时空，自动重试
    if (!loading && data && candles.length === 0 && retryRef.current < 2) {
      retryRef.current += 1
      const t = setTimeout(() => reload(), 500 * retryRef.current)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line
  }, [loading, data, candles.length])

  const retrying = !loading && data && candles.length === 0 && retryRef.current < 2

  // 计算 N 日均线
  const ma = (arr, n) =>
    arr.map((_, i) => {
      if (i < n - 1) return '-'
      let sum = 0
      for (let j = 0; j < n; j++) sum += arr[i - j].close
      return +(sum / n).toFixed(2)
    })

  // 价格与均线概览（用最后一根K线 + 尾部均值），换周期时随 candles 重算
  const overview = useMemo(() => {
    if (!candles.length) return null
    const last = candles[candles.length - 1]
    // 以 endIdx 为“最后一根”，计算 n 日均线（用于当前值 & 上一根值，判断交叉）
    const maAt = (n, endIdx) => {
      if (endIdx < n - 1) return null
      let sum = 0
      for (let j = 0; j < n; j++) sum += candles[endIdx - j].close
      return +(sum / n).toFixed(3)
    }
    const li = candles.length - 1
    const maN = (n) => maAt(n, li)
    const price = last.close
    const mas = [5, 10, 20, 60].map((n) => {
      const v = maN(n)
      return { n, v, above: v != null ? price >= v : null, diff: v != null ? +(((price - v) / v) * 100).toFixed(2) : null }
    })
    const [m5, m10, m20, m60] = [maN(5), maN(10), maN(20), maN(60)]
    // 上一根的均线（用于交叉判定）
    const [p5, p10, p20] = [maAt(5, li - 1), maAt(10, li - 1), maAt(20, li - 1)]

    let trend = null
    if (m5 != null && m10 != null && m20 != null) {
      if (m5 >= m10 && m10 >= m20) trend = { label: '多头排列', cls: 'red' }
      else if (m5 <= m10 && m10 <= m20) trend = { label: '空头排列', cls: 'green' }
      else trend = { label: '均线纠缠', cls: 'muted' }
    }
    const periodLabel = klt === '102' ? '周' : klt === '103' ? '月' : '日'

    // ===== 技术参考结论（本地计算，非投资建议）=====
    const signals = []
    // 1) 金叉/死叉：MA5 与 MA10（短中期），以及 MA10 与 MA20（中期）
    const cross = (fastNow, slowNow, fastPrev, slowPrev, fastName, slowName) => {
      if ([fastNow, slowNow, fastPrev, slowPrev].some((x) => x == null)) return null
      if (fastPrev <= slowPrev && fastNow > slowNow) return { type: 'gold', fastName, slowName }
      if (fastPrev >= slowPrev && fastNow < slowNow) return { type: 'dead', fastName, slowName }
      return null
    }
    const c1 = cross(m5, m10, p5, p10, 'MA5', 'MA10')
    const c2 = cross(m10, m20, p10, p20, 'MA10', 'MA20')
    for (const c of [c1, c2]) {
      if (!c) continue
      if (c.type === 'gold') signals.push({ cls: 'red', tag: '金叉', text: `${c.fastName} 上穿 ${c.slowName}，短期走强信号，${periodLabel}线级别偏多` })
      else signals.push({ cls: 'green', tag: '死叉', text: `${c.fastName} 下穿 ${c.slowName}，短期转弱信号，${periodLabel}线级别偏空` })
    }
    // 2) 均线排列
    if (trend && trend.label === '多头排列') signals.push({ cls: 'red', tag: '多头排列', text: 'MA5>MA10>MA20，均线向上发散，趋势偏强，回踩均线可关注' })
    else if (trend && trend.label === '空头排列') signals.push({ cls: 'green', tag: '空头排列', text: 'MA5<MA10<MA20，均线向下压制，趋势偏弱，反弹到均线易受阻' })
    // 3) 关键均线位置（现价 vs MA20 生命线 / MA60）
    if (m20 != null) {
      const d = +(((price - m20) / m20) * 100).toFixed(2)
      if (price >= m20) signals.push({ cls: 'red', tag: '站上MA20', text: `现价在 20${periodLabel}均线上方 ${d}%，中期趋势偏多` })
      else signals.push({ cls: 'green', tag: '跌破MA20', text: `现价在 20${periodLabel}均线下方 ${Math.abs(d)}%，中期趋势承压` })
    }
    if (m60 != null) {
      if (price >= m60) signals.push({ cls: 'red', tag: '站上MA60', text: `站稳 60${periodLabel}均线（季线），中长期多头格局` })
      else signals.push({ cls: 'green', tag: '跌破MA60', text: `处于 60${periodLabel}均线（季线）下方，中长期偏弱` })
    }
    // 4) 均线粘合（5/10/20 极度靠拢，变盘临界）
    if (m5 != null && m10 != null && m20 != null) {
      const maxV = Math.max(m5, m10, m20), minV = Math.min(m5, m10, m20)
      const spread = +(((maxV - minV) / minV) * 100).toFixed(2)
      if (spread <= 1.5) signals.push({ cls: 'muted', tag: '均线粘合', text: `MA5/10/20 高度粘合（发散${spread}%），方向待选，突破方向或加速` })
    }
    // 5) 乖离过大（现价离 MA5 太远，短线过热/超跌）
    if (m5 != null) {
      const bias = +(((price - m5) / m5) * 100).toFixed(2)
      if (bias >= 8) signals.push({ cls: 'muted', tag: '正乖离大', text: `现价高出 MA5 达 ${bias}%，短线偏热，注意回踩风险` })
      else if (bias <= -8) signals.push({ cls: 'muted', tag: '负乖离大', text: `现价低于 MA5 达 ${Math.abs(bias)}%，短线超跌，或有反抽` })
    }
    if (!signals.length) signals.push({ cls: 'muted', tag: '暂无明显信号', text: '均线无交叉、排列中性，观望为主，等待方向明朗' })

    return { last, price, pct: last.pct, mas, trend, periodLabel, signals }
  }, [candles, klt])

  const option = useMemo(() => {
    if (!candles.length) return null
    const dates = candles.map((c) => c.date)
    const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high])
    const closes = candles.map((c) => c.close)
    const ma5 = ma(candles, 5)
    const ma10 = ma(candles, 10)
    const ma20 = ma(candles, 20)
    const vols = candles.map((c) => ({
      value: c.volume,
      itemStyle: { color: c.close >= c.open ? 'rgba(244,97,78,.55)' : 'rgba(63,185,80,.55)' },
    }))

    const isLine = chartType === 'line'
    const priceSeries = isLine
      ? [
          {
            name: '收盘价', type: 'line', data: closes,
            smooth: true, symbol: 'none',
            lineStyle: { color: '#5b8def', width: 2 },
            areaStyle: {
              color: {
                type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(91,141,239,.28)' },
                  { offset: 1, color: 'rgba(91,141,239,.02)' },
                ],
              },
            },
          },
        ]
      : [
          {
            name: 'K线', type: 'candlestick', data: ohlc,
            itemStyle: { color: '#f4614e', color0: '#3fb950', borderColor: '#f4614e', borderColor0: '#3fb950' },
          },
        ]

    // 均线（两种模式都叠加）
    const maSeries = [
      { name: 'MA5', type: 'line', data: ma5, smooth: true, symbol: 'none', lineStyle: { color: '#e3b341', width: 1 } },
      { name: 'MA10', type: 'line', data: ma10, smooth: true, symbol: 'none', lineStyle: { color: '#7c6bf5', width: 1 } },
      { name: 'MA20', type: 'line', data: ma20, smooth: true, symbol: 'none', lineStyle: { color: '#3fb950', width: 1 } },
    ]

    return {
      animation: false,
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      legend: {
        data: isLine ? ['收盘价', 'MA5', 'MA10', 'MA20'] : ['MA5', 'MA10', 'MA20'],
        top: 0, right: 8, textStyle: { color: '#767881', fontSize: 10 },
        itemWidth: 14, itemHeight: 8,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#16181f', borderColor: '#23252d',
        textStyle: { color: '#e6e7ea', fontSize: 12 },
        formatter: (ps) => {
          const k = candles[ps[0].dataIndex]
          if (!k) return ''
          return `${k.date}<br/>开 ${k.open} 收 ${k.close}<br/>高 ${k.high} 低 ${k.low}<br/>涨跌 ${fmtPct(k.pct)}`
        },
      },
      grid: [
        { left: 52, right: 16, top: 24, height: '58%' },
        { left: 52, right: 16, top: '74%', height: '18%' },
      ],
      xAxis: [
        { type: 'category', data: dates, boundaryGap: true, axisLabel: { color: '#767881', fontSize: 10 }, axisLine: { lineStyle: { color: '#23252d' } }, splitLine: { show: false } },
        { type: 'category', gridIndex: 1, data: dates, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#23252d' } } },
      ],
      yAxis: [
        { scale: true, axisLabel: { color: '#767881', fontSize: 10 }, splitLine: { lineStyle: { color: '#16181f' } } },
        { scale: true, gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 55, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1], bottom: 4, height: 14, start: 55, end: 100, borderColor: '#23252d', textStyle: { color: '#767881', fontSize: 9 }, fillerColor: 'rgba(124,107,245,.15)' },
      ],
      series: [
        ...priceSeries,
        ...maSeries,
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols },
      ],
    }
  }, [candles, chartType])

  // 分时图 option：现价线 + 均价线 + 昨收基准 + 成交量
  const trendOption = useMemo(() => {
    if (!trends.length) return null
    const hm = (s) => { s = String(s || ''); const i = s.indexOf(' '); return i >= 0 ? s.slice(i + 1, i + 6) : (s.length > 5 ? s.slice(11, 16) : s) }
    const times = trends.map((t) => hm(t.time)) // HH:MM（兼容东财"YYYY-MM-DD HH:MM"与腾讯"HH:MM"）
    const prices = trends.map((t) => t.price)
    const avgs = trends.map((t) => t.avg)
    const vols = trends.map((t, i) => ({
      value: t.volume,
      itemStyle: { color: (i > 0 ? t.price >= trends[i - 1].price : t.price >= (preClose || t.price)) ? 'rgba(244,97,78,.55)' : 'rgba(63,185,80,.55)' },
    }))
    const base = preClose || prices[0]
    return {
      animation: false,
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      legend: { data: ['价格', '均价'], top: 0, right: 8, textStyle: { color: '#767881', fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
      tooltip: {
        trigger: 'axis', backgroundColor: '#16181f', borderColor: '#23252d', textStyle: { color: '#e6e7ea', fontSize: 12 },
        formatter: (ps) => {
          const i = ps[0].dataIndex, t = trends[i]
          const pct = base ? ((t.price - base) / base * 100).toFixed(2) : '0'
          return `${times[i]}<br/>价格 ${fmtRaw(t.price)}（${pct >= 0 ? '+' : ''}${pct}%）<br/>均价 ${fmtRaw(t.avg)}`
        },
      },
      grid: [{ left: 52, right: 16, top: 24, height: '60%' }, { left: 52, right: 16, top: '76%', height: '16%' }],
      xAxis: [
        { type: 'category', data: times, boundaryGap: false, axisLabel: { color: '#767881', fontSize: 10, interval: Math.floor(times.length / 5) }, axisLine: { lineStyle: { color: '#23252d' } } },
        { type: 'category', gridIndex: 1, data: times, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#23252d' } } },
      ],
      yAxis: [
        { scale: true, axisLabel: { color: '#767881', fontSize: 10 }, splitLine: { lineStyle: { color: '#16181f' } } },
        { scale: true, gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
      ],
      series: [
        { name: '价格', type: 'line', data: prices, smooth: false, symbol: 'none', lineStyle: { color: '#5b8def', width: 1.5 },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(91,141,239,.22)' }, { offset: 1, color: 'rgba(91,141,239,.01)' }] } },
          markLine: base ? { symbol: 'none', silent: true, data: [{ yAxis: base, lineStyle: { color: '#767881', type: 'dashed', width: 1 }, label: { formatter: '昨收 ' + fmtRaw(base), color: '#767881', fontSize: 10, position: 'insideEndTop' } }] } : undefined,
        },
        { name: '均价', type: 'line', data: avgs, smooth: false, symbol: 'none', lineStyle: { color: '#e3b341', width: 1 } },
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols },
      ],
    }
  }, [trends, preClose])

  if (!stock) return null

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-bar">
          <div className="modal-title">
            {(profile && profile.name) || stock.name}
            <span className="detail-code">{stock.code}</span>
            {profile && profile.market && <span className="detail-market">{profile.market}</span>}
          </div>
          <div className="modal-actions">
            <button
              className="icon-btn detail-refresh"
              title="刷新最新价格 / K线"
              disabled={refreshing || loading}
              onClick={doRefresh}
            >
              <Icon name="refresh" size={15} className={refreshing || loading ? 'spin' : ''} />
              <span className="detail-refresh-txt">{refreshing ? '刷新中' : '刷新'}</span>
            </button>
            <div className="modal-close" onClick={onClose}><Icon name="close" size={16} /></div>
          </div>
        </div>

        <div className="detail-scroll">
          {/* 价格 & 均线概览 */}
          {overview && (
            <div className="detail-quote">
              <div className="dq-price-row">
                <div className="dq-price-main">
                  <span className={'dq-price ' + pctClass(overview.pct)}>{fmtRaw(overview.price)}</span>
                  <span className={'dq-pct ' + pctClass(overview.pct)}>{fmtPct(overview.pct)}</span>
                </div>
                {overview.trend && <span className={'dq-trend ' + overview.trend.cls}>{overview.trend.label}</span>}
                <span className="dq-period">
                  最新{overview.periodLabel}K
                  {refreshedAt && <span className="dq-updated">· 已更新 {new Date(refreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
                </span>
              </div>
              {/* ===== AI 操作建议（核心：紧跟价格，第一优先展示）===== */}
              <div className="decide-box">
                <div className="decide-head">
                  <div className="decide-title"><Icon name="target" size={14} /> AI 操作建议
                    {myHold ? <span className="decide-hold">持仓 {myHold.qty}手 · 成本{fmtRaw(myHold.cost)}</span>
                            : <span className="decide-hold none">未持仓</span>}
                  </div>
                  {quantState && quantState.result && quantState.result.asOf && <span className="quant-asof">量化 {quantState.result.asOf}</span>}
                </div>

                {!quantState && (
                  <div className="quant-cta">
                    <button className="quant-btn" onClick={loadQuant}><Icon name="spark" size={14} /> 生成操作建议</button>
                    <span className="quant-cta-hint">{myHold ? '结合你的持仓，告诉你该加仓 / 减仓 / 持有做T' : '结合量化+技术+历史规律+当日盘面，先给结论(买入/回调再买/观望/不建议)，再给对应买点与止损'}</span>
                  </div>
                )}
                {quantState && quantState.loading && (
                  <div className="advice-skeleton">
                    <div className="sk-hint"><Icon name="refresh" size={13} className="spin" /> {quantState.phase || '量化模型 + AI 计算中…'}（首次冷启动约需几秒）</div>
                    {/* 数据源采集清单:每个源 settle 时后端推 source 事件,这里实时勾选(✓ 成功 / — 无数据) */}
                    {quantState.sources && quantState.sources.length > 0 && (
                      <div className="adv-sources">
                        {quantState.sources.map((s, i) => (
                          <span className={'adv-src' + (s.ok ? ' ok' : ' none')} key={s.label + i}>
                            <Icon name={s.ok ? 'check' : 'close'} size={11} /> {s.label}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* 量化模型结论:后端量化打分完成后推 quant 事件,先于军师推理展示"量化模型给了什么" */}
                    {quantState.quant && (
                      <div className="adv-quant">
                        <div className="adv-quant-head"><Icon name="activity" size={12} /> 量化模型结论</div>
                        <div className="adv-quant-body">{quantState.quant.summary || '已完成打分'}</div>
                      </div>
                    )}
                    {/* 模型思维链:开启「深度思考」时后端把 reasoning_content 增量推来,这里滚动展示"军师在想什么" */}
                    {quantState.reasoning && (
                      <div className="adv-reasoning">
                        <div className="adv-reasoning-head"><Icon name="brain" size={12} /> 军师推理过程</div>
                        <div className="adv-reasoning-body" ref={(el) => { if (el) el.scrollTop = el.scrollHeight }}>{quantState.reasoning}</div>
                      </div>
                    )}
                    {(!quantState.sources || !quantState.sources.length) && !quantState.reasoning && !quantState.quant && (
                      <>
                        <div className="sk-line sk-verdict" />
                        <div className="sk-line sk-timing" />
                        <div className="sk-cells"><div className="sk-cell" /><div className="sk-cell" /><div className="sk-cell" /></div>
                      </>
                    )}
                  </div>
                )}
                {quantState && quantState.error && (
                  <div className="quant-err">{quantState.error} <span className="expand-btn" onClick={loadQuant}>重试</span></div>
                )}
                {quantState && !quantState.loading && !quantState.error && (quantState.result || quantState.advice) && (() => {
                  const q = quantState.result || {}
                  const adv = quantState.advice
                  const dec = q.decision || {}
                  const fc = q.forecast
                  // 有 LLM 操作建议时以它为主结论；否则回退到量化规则决策
                  const verdict = adv
                    ? { tone: adv.tone || 'muted', title: adv.title || adv.action || '—', detail: adv.actionPlan || adv.reason || '' }
                    : { tone: dec.tone || 'muted', title: dec.title || '—', detail: dec.detail || '' }
                  // 结论徽标（未持仓四态 / 持仓动作）
                  const actionLabel = adv && adv.action
                  const cachedStr = quantState.cachedAt ? new Date(quantState.cachedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
                  const noOpText = adv && myHold && !hasVal(adv.opQty) && !hasVal(adv.opAmount)
                    ? (adv.action === '持有' ? '本次无需加仓/减仓，按当前仓位继续持有；等触发价或失效信号出现再动。' : adv.action === '观望' ? '本次无需操作，先观察关键价位和量能变化。' : '')
                    : ''
                  return (
                    <>
                      {/* 决策结论（最大最醒目；结论徽标随 买入/回调/观望/不建议 变色）*/}
                      <div className={'decide-verdict ' + verdict.tone}>
                        <div className="dv-head">
                          {actionLabel && <span className={'dv-badge ' + verdict.tone}>{actionLabel}</span>}
                          <div className="dv-action">{verdict.title}</div>
                        </div>
                        <div className="dv-detail"><HL text={verdict.detail} /></div>
                      </div>

                      {/* ReAct 研判思路：模型先于结论生成的推理链，让"为什么这么建议"透明可核对 */}
                      {adv && adv.reasoning && (
                        <Reasoning text={adv.reasoning} />
                      )}

                      {/* 可信度条：综合信任分 + 共振灯（让"能信多少"透明化）*/}
                      {(() => {
                        const meta = quantState.meta || {}
                        const ts = meta.trustScore, rez = meta.resonance, env = meta.marketEnv, bt = meta.backtest
                        if (!ts && !rez) return null
                        const tband = ts ? (ts.score >= 68 ? 'red' : ts.score >= 48 ? 'gold' : 'green') : 'muted'
                        return (
                          <div className="trust-bar">
                            {ts && (
                              <div className="trust-main">
                                <span className="trust-k">可信度</span>
                                <span className={'trust-score ' + tband}>{ts.score}</span>
                                <span className="trust-band">{ts.band}</span>
                                <div className="trust-track"><div className={'trust-fill ' + tband} style={{ width: ts.score + '%' }} /></div>
                              </div>
                            )}
                            <div className="trust-tags">
                              {meta.todayQuote && (meta.todayQuote.isLimitUp || meta.todayQuote.isLimitDown || meta.todayQuote.bigMove) && (
                                <span className={'trust-tag ' + (meta.todayQuote.pct >= 0 ? 'on' : 'warn')} title="今日实时行情(优先于历史指标)">
                                  今日{meta.todayQuote.isLimitUp ? '涨停' : meta.todayQuote.isLimitDown ? '跌停' : (meta.todayQuote.pct >= 0 ? '+' : '') + meta.todayQuote.pct + '%'}
                                </span>
                              )}
                              {rez && <span className={'trust-tag ' + (rez.score >= 2 ? 'on' : '')} title={(rez.hits || []).join('、')}>共振 {rez.score}/{rez.max}</span>}
                              {env && <span className={'trust-tag ' + (env.weak ? 'warn' : '')} title={env.suggestPosition ? ('建议仓位 ' + env.suggestPosition) : ''}>{env.level}</span>}
                              {meta.counterTrend && meta.counterTrend.isStrong && <span className="trust-tag on" title={(meta.counterTrend.flags || []).join('、')}>逆势强票</span>}
                              {bt && bt.hitRate != null && <span className="trust-tag" title={bt.note}>回测 {bt.hitRate}%</span>}
                              {meta.lhb && meta.lhb.smartMoney && <span className="trust-tag on">游资/机构</span>}
                              {meta.dailyReport && <span className="trust-tag" title={'已结合' + (meta.dailyReport.sessionCn || '今日日报') + '的外部市场环境判断'}>📋 已结合日报</span>}
                              {meta.hasNegNews && <span className="trust-tag warn">消息有雷</span>}
                            </div>
                          </div>
                        )
                      })()}

                      {/* 未持仓但 AI 建议没返回 → 提示重试（避免只给模糊量化结论）*/}
                      {quantState.adviceMissing && !adv && (
                        <div className="advice-retry">
                          <Icon name="spark" size={13} /> AI 操作建议(结论/买点/时机/止损)生成超时，
                          <span className="expand-btn" onClick={loadQuant}>点此重试</span>
                        </div>
                      )}

                      {/* AI 输出被长度截断(内容不全) → 明确提示 + 一键重新生成，避免用户以为"卡住/只显示了一半" */}
                      {quantState.truncated && adv && (
                        <div className="advice-retry">
                          <Icon name="spark" size={13} /> 本次分析内容较长被截断，下方可能不完整，
                          <span className="expand-btn" onClick={loadQuant}>重新生成完整版</span>
                        </div>
                      )}

                      {/* LLM 具体操作价位（按结论差异化：观望给"关注价"，不建议买则不给买价）*/}
                      {adv && (
                        <>
                          {adv.timing && <div className="advice-timing"><Icon name="clock" size={13} /> <b>{myHold ? '操作时机' : '买入时机'}</b>：<HL text={adv.timing} /></div>}
                          {/* 两段式指导：下个开盘时段怎么做 + 未来后续路径（今天买不了不必硬买）*/}
                          {(adv.nextOpenPlan || adv.futurePlan) && (
                            <div className="advice-horizon">
                              {adv.nextOpenPlan && <div className="ah-row now"><span className="ah-k">下个开盘</span><span className="ah-v"><HL text={adv.nextOpenPlan} /></span></div>}
                              {adv.futurePlan && <div className="ah-row future"><span className="ah-k">未来</span><span className="ah-v"><HL text={adv.futurePlan} /></span></div>}
                            </div>
                          )}
                          {(adv.buyPrice != null || adv.buyZone || adv.watchPrice || adv.addPrice != null || adv.reducePrice != null || adv.stopPrice != null || adv.targetPrice != null) && (
                            <div className="advice-prices">
                              {adv.buyPrice != null && <div className="ap-cell"><span className="ap-k">建议买入价</span><span className="ap-v red">{adv.buyPrice}</span></div>}
                              {adv.buyZone && <div className="ap-cell"><span className="ap-k">买入区间</span><span className="ap-v red">{adv.buyZone}</span></div>}
                              {adv.watchPrice && <div className="ap-cell wide"><span className="ap-k">关注 / 触发价</span><span className="ap-v muted">{adv.watchPrice}</span></div>}
                              {adv.addPrice != null && <div className="ap-cell"><span className="ap-k">加仓参考</span><span className="ap-v red">{adv.addPrice}</span></div>}
                              {adv.reducePrice != null && <div className="ap-cell"><span className="ap-k">减仓参考</span><span className="ap-v green">{adv.reducePrice}</span></div>}
                              {adv.stopPrice != null && <div className="ap-cell"><span className="ap-k">止损价</span><span className="ap-v green">{adv.stopPrice}</span></div>}
                              {adv.targetPrice != null && <div className="ap-cell"><span className="ap-k">目标价</span><span className="ap-v red">{adv.targetPrice}</span></div>}
                            </div>
                          )}
                          {adv.serverAdjust && (
                            <div className="advice-adjust"><Icon name="shield" size={12} /> 已按合规校正：{adv.serverAdjust}</div>
                          )}
                          {/* 触价后怎么确认才动手：把"见价即砍"升级为"到价→看信号确认→再执行"，避免被瞬时插针骗出局 */}
                          {adv.exitTiming && (
                            <div className="advice-exit-timing key-block"><span className="ket-tag"><Icon name="shield" size={12} /> 到价后怎么做</span><span className="ket-body"><HL text={adv.exitTiming} /></span></div>
                          )}
                          {/* 买入计划(未持仓·按账户全景算的手数/资金/占比) —— 一眼看清怎么下手 */}
                          {!myHold && (hasVal(adv.planQty) || hasVal(adv.planAmount) || hasVal(adv.planWeight)) && (
                            <div className="op-calc">
                              <div className="oc-grid">
                                {hasVal(adv.planQty) && <div className="oc-cell"><span className="oc-k">买入手数</span><b className="red">{adv.planQty}</b></div>}
                                {hasVal(adv.planAmount) && <div className="oc-cell"><span className="oc-k">约需资金</span><b>{adv.planAmount}</b></div>}
                                {hasVal(adv.riskReward) && <div className="oc-cell"><span className="oc-k">盈亏比</span><b>{adv.riskReward}</b></div>}
                              </div>
                              {hasVal(adv.planWeight) && <div className="oc-line"><span className="oc-k">买入依据</span><span><HL text={adv.planWeight} /></span></div>}
                              {hasVal(adv.positionNote) && <div className="oc-line"><span className="oc-k">资金约束</span><span><HL text={adv.positionNote} /></span></div>}
                            </div>
                          )}
                          {/* 算账条：预期赚整行 hero + 短标量 chip + 仓位整句独行 —— 不截断不出血。
                              持有/观望时 opQty/opAmount 为 0，经 hasVal 过滤后不渲染，避免出现迷惑的"00"。 */}
                          {(hasVal(adv.opQty) || hasVal(adv.opAmount) || hasVal(adv.expReturn) || hasVal(adv.riskReward) || hasVal(adv.posAfter)) && (
                            <div className="op-calc">
                              {hasVal(adv.expReturn) && <div className="oc-exp"><span className="oc-k">预期收益</span><b>{adv.expReturn}</b></div>}
                              {(hasVal(adv.opQty) || hasVal(adv.opAmount) || hasVal(adv.newCost) || hasVal(adv.riskReward)) && (
                                <div className="oc-grid">
                                  {hasVal(adv.opQty) && <div className="oc-cell"><span className="oc-k">操作</span><b>{opText(adv.opQty, adv.action)}</b></div>}
                                  {hasVal(adv.opAmount) && <div className="oc-cell"><span className="oc-k">资金</span><b>{adv.opAmount}</b></div>}
                                  {hasVal(adv.newCost) && <div className="oc-cell"><span className="oc-k">新成本</span><b>{adv.newCost}</b></div>}
                                  {hasVal(adv.riskReward) && <div className="oc-cell"><span className="oc-k">盈亏比</span><b>{adv.riskReward}</b></div>}
                                </div>
                              )}
                              {hasVal(adv.posAfter) && <div className="oc-line"><span className="oc-k">仓位</span><span><HL text={adv.posAfter} /></span></div>}
                            </div>
                          )}
                          {/* 无需操作也要明确告诉用户，而不是空着 */}
                          {noOpText && (
                            <div className="op-calc noop-calc">
                              <div className="oc-exp noop"><span className="oc-k">本次操作</span><b>无需操作</b></div>
                              {hasVal(adv.posAfter) && <div className="oc-line"><span className="oc-k">当前仓位</span><span><HL text={adv.posAfter} /></span></div>}
                              <div className="oc-line"><span className="oc-k">怎么做</span><span><HL text={adv.actionPlan || noOpText} /></span></div>
                            </div>
                          )}
                          {adv.pnlNote && <div className="advice-line">💰 <HL text={adv.pnlNote} /></div>}
                          {adv.reason && <div className="advice-line muted"><HL text={adv.reason} /></div>}

                          {/* 深度分析(依据+风险+信心)默认折叠：先给关键结论(结论/价位/到价后怎么做)，
                              想深究再展开，避免信息一次性倾泻。有内容才显示折叠入口。 */}
                          {(() => {
                            const hasBasis = adv.techNote || adv.fundNote || adv.newsNote || adv.macroNote || adv.seatNote || adv.quantNote || adv.theoryNote
                            const hasRisk = adv.bearCase || adv.invalidation || adv.risk
                            const hasConf = !!adv.confidenceReason
                            if (!hasBasis && !hasRisk && !hasConf) return null
                            const n = (hasBasis ? 1 : 0) + (hasRisk ? 1 : 0)
                            return (
                              <div className="advice-deep">
                                <button className="advice-deep-toggle" onClick={() => setShowBasis((v) => !v)} aria-expanded={showBasis}>
                                  <span className="adt-label"><Icon name="layers" size={12} /> 深度分析 · 依据与风险{n > 0 ? ` (${n})` : ''}</span>
                                  <Icon name={showBasis ? 'chevronDown' : 'chevronRight'} size={13} />
                                </button>
                                {showBasis && (
                                  <div className="advice-deep-body">
                                    {/* 分析依据：把技术/资金/消息/宏观/席位/量化归为一组带标签的结构化清单 */}
                                    {hasBasis && (
                                      <div className="advice-basis">
                                        <div className="advice-basis-title">分析依据</div>
                                        {adv.techNote && <div className="ab-row"><span className="ab-k tech">技术</span><span className="ab-v"><HL text={adv.techNote} /></span></div>}
                                        {adv.fundNote && <div className="ab-row"><span className="ab-k fund">资金</span><span className="ab-v"><HL text={adv.fundNote} /></span></div>}
                                        {adv.newsNote && <div className="ab-row"><span className="ab-k news">消息</span><span className="ab-v"><HL text={adv.newsNote} /></span></div>}
                                        {adv.macroNote && <div className="ab-row"><span className="ab-k macro">宏观</span><span className="ab-v"><HL text={adv.macroNote} /></span></div>}
                                        {adv.seatNote && <div className="ab-row"><span className="ab-k seat">席位</span><span className="ab-v"><HL text={adv.seatNote} /></span></div>}
                                        {adv.quantNote && <div className="ab-row"><span className="ab-k quant">量化</span><span className="ab-v"><HL text={adv.quantNote} /></span></div>}
                                        {adv.theoryNote && <div className="ab-row"><span className="ab-k theory">理论</span><span className="ab-v"><HL text={adv.theoryNote} /></span></div>}
                                      </div>
                                    )}
                                    {/* 风险区：反方观点/失效信号/风险 归为一组，与依据区分开 */}
                                    {hasRisk && (
                                      <div className="advice-risk">
                                        {adv.bearCase && <div className="ab-row"><span className="ab-k rev">反方</span><span className="ab-v"><HL text={adv.bearCase} /></span></div>}
                                        {adv.invalidation && <div className="ab-row"><span className="ab-k warn">失效</span><span className="ab-v"><HL text={adv.invalidation} /></span></div>}
                                        {adv.risk && <div className="ab-row"><span className="ab-k warn">风险</span><span className="ab-v"><HL text={adv.risk} /></span></div>}
                                      </div>
                                    )}
                                    {hasConf && <div className="advice-line muted" style={{ fontSize: 11 }}>信心：{adv.confidence}（{adv.confidenceReason}）</div>}
                                  </div>
                                )}
                              </div>
                            )
                          })()}
                        </>
                      )}

                      {/* 走势预测 + 量化：默认折叠为一行概览，点开看蒙特卡洛细节 */}
                      {(fc || q.score != null) && (
                        <div className="fc-fold-wrap">
                          <button className="fc-fold" onClick={() => setShowForecast((v) => !v)}>
                            <span className="fc-fold-summary">
                              {fc && <span className={'fc-dir-inline ' + (fc.direction === '看涨' ? 'red' : fc.direction === '看跌' ? 'green' : 'muted')}>量化{fc.days}日{fc.direction}·概率{fc.upProb}%</span>}
                              {q.score != null && <span className={'quant-chip sm ' + (q.score >= 62 ? 'red' : q.score <= 38 ? 'green' : 'gold')}>量化 {q.score}·{q.bias}</span>}
                            </span>
                            <Icon name={showForecast ? 'chevronDown' : 'chevronRight'} size={13} />
                          </button>
                          {showForecast && (
                            <>
                              {fc && (
                                <div className="forecast-box">
                                  <div className="fc-row1">
                                    <span className={'fc-dir ' + (fc.direction === '看涨' ? 'red' : fc.direction === '看跌' ? 'green' : 'muted')}>
                                      未来{fc.days}日 {fc.direction}
                                    </span>
                                    <span className="fc-conf">预测信心 {fc.confidence}</span>
                                  </div>
                                  <div className="fc-grid">
                                    <div className="fc-cell"><span className="fc-k">上涨概率</span><span className={'fc-v ' + (fc.upProb >= 55 ? 'red' : fc.upProb <= 45 ? 'green' : '')}>{fc.upProb}%</span></div>
                                    <div className="fc-cell"><span className="fc-k">预期涨跌</span><span className={'fc-v ' + (fc.expRet >= 0 ? 'red' : 'green')}>{fc.expRet >= 0 ? '+' : ''}{fc.expRet}%</span></div>
                                    <div className="fc-cell"><span className="fc-k">目标区间</span><span className="fc-v"><b className="green">{fc.targetLow}</b> ~ <b className="red">{fc.targetHigh}</b></span></div>
                                    <div className="fc-cell"><span className="fc-k">中枢价</span><span className="fc-v">{fc.targetMid}</span></div>
                                  </div>
                                </div>
                              )}
                              {q.highConfSignal && q.highConfSignal.fired && (() => {
                                const hcs = q.highConfSignal;
                                // 即时赔率 = (止盈-买入)/(买入-止损)；用现价替代买入价算“照现价追”的真实赔率，更贴用户实际处境
                                const curPx = (overview && overview.price != null) ? overview.price : (q.price != null ? q.price : hcs.buyPrice);
                                const refPx = curPx != null ? curPx : hcs.buyPrice;
                                const up = hcs.takeProfit != null && refPx != null ? (hcs.takeProfit - refPx) : null;
                                const dn = hcs.stopLoss != null && refPx != null ? (refPx - hcs.stopLoss) : null;
                                const rr = (up != null && dn != null && dn > 0) ? up / dn : null;
                                // 赔率<1.5:1 视为“胜率好但赔率差”，触发警示，引导看军师结论
                                const poor = rr != null && rr < 1.5;
                                const chased = curPx != null && hcs.buyPrice != null && curPx > hcs.buyPrice; // 现价已高于建议买入价=在追高
                                return (
                                <div className="hcs-box">
                                  <div className="hcs-head">
                                    <span className="hcs-star">⭐</span>
                                    <span className="hcs-title">高把握买点</span>
                                    <span className="hcs-cred">胜率把握 {hcs.credibility}%</span>
                                  </div>
                                  <div className="hcs-grid">
                                    <div className="hcs-cell"><span className="hcs-k">买入价</span><span className="hcs-v gold">{hcs.buyPrice}</span></div>
                                    <div className="hcs-cell"><span className="hcs-k">止盈价</span><span className="hcs-v red">{hcs.takeProfit}</span></div>
                                    <div className="hcs-cell"><span className="hcs-k">止损价</span><span className="hcs-v green">{hcs.stopLoss}</span></div>
                                  </div>
                                  {rr != null && (
                                    <div className={'hcs-rr ' + (poor ? 'bad' : 'ok')}>
                                      <span className="hcs-rr-k">{chased ? '按现价追的赔率' : '即时赔率'}</span>
                                      <span className="hcs-rr-v">{rr.toFixed(2)} : 1</span>
                                      <span className="hcs-rr-tag">{poor ? '赚少亏多·不划算' : '赔率合适'}</span>
                                    </div>
                                  )}
                                  {poor && (
                                    <div className="hcs-warn">
                                      ⚠️ 这是「高胜率」信号，只说 5 日内摸到止盈的概率高，<b>不代表现在这个价位值得买</b>。当前赔率仅 {rr.toFixed(2)}:1（赢一次赚得少、输一次亏得多），<b>请以下方「军师」结论为准</b>，通常需等回调到更好的价位再出手。
                                    </div>
                                  )}
                                  <div className="hcs-foot">{hcs.label} · 样本外命中率约 {hcs.holdoutPrecision}%（闸门 {hcs.gate}）· 胜率信号，非买卖指令</div>
                                </div>
                                );
                              })()}
                              {q.score != null && (q.reads || []).length > 0 && (
                                <div className="quant-line">
                                  {(q.reads || []).slice(-1).map((r, i) => <span className="quant-line-read" key={i}>{r}</span>)}
                                  <span className="expand-btn" style={{ marginLeft: 'auto' }} onClick={loadQuant}>刷新</span>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {/* 生成时间 + 重新生成（结果已缓存，关闭再进/刷新仍可见）*/}
                      <div className="advice-foot">
                        {cachedStr && <span className="advice-cached"><Icon name="history" size={11} /> {cachedStr} 生成，已保留</span>}
                        <span className="expand-btn" style={{ marginLeft: 'auto' }} onClick={loadQuant}>重新生成</span>
                      </div>
                      <div className="dq-hint">{adv ? (myHold ? 'AI 操作建议由大模型结合量化预测/技术面/你的持仓成本生成' : 'AI 操作建议由大模型结合量化走势预测/技术面/历史规律/当日盘面生成') : '走势预测=基于历史波动的蒙特卡洛模拟，量化=多因子打分'}；均为统计口径，仅供参考，非投资建议</div>
                    </>
                  )
                })()}
              </div>

              {/* 均线技术参考（精简为可折叠的次要信息）*/}
              {tech && (
                <div className="tech-box">
                  <div className="tech-fold" onClick={() => setShowTech((v) => !v)}>
                    <span><Icon name="pulse" size={13} /> 技术面细节
                      {tech.verdict && <span className={'tech-verdict-inline ' + (tech.vtone || 'muted')}>{tech.verdict}</span>}
                    </span>
                    <Icon name={showTech ? 'chevronDown' : 'chevronRight'} size={14} />
                  </div>
                  {showTech && (
                    <>
                      {/* 买卖价位 */}
                      {tech.priceHints && (
                        <div className="tech-prices">
                          {tech.priceHints.buyZone && <div className="tech-price-cell buy"><span className="tpc-k">建议低吸区</span><span className="tpc-v red">{tech.priceHints.buyZone.low} ~ {tech.priceHints.buyZone.high}</span></div>}
                          {tech.priceHints.sellZone && <div className="tech-price-cell sell"><span className="tpc-k">建议高抛区</span><span className="tpc-v green">{tech.priceHints.sellZone.low} ~ {tech.priceHints.sellZone.high}</span></div>}
                          {tech.priceHints.stopLoss != null && <div className="tech-price-cell"><span className="tpc-k">参考止损</span><span className="tpc-v green">{tech.priceHints.stopLoss}</span></div>}
                          {tech.priceHints.takeProfit != null && <div className="tech-price-cell"><span className="tpc-k">参考止盈</span><span className="tpc-v red">{tech.priceHints.takeProfit}</span></div>}
                        </div>
                      )}
                      {tech.reads && tech.reads.length > 0 && (
                        <div className="tech-reads">
                          {tech.reads.map((r, i) => (
                            <div className={'tech-read ' + (r.tone || 'muted')} key={r.key || i}>
                              <div className="tech-read-top">
                                <span className={'tech-read-tag ' + (r.tone || 'muted')}>{r.tag}</span>
                                <span className="tech-read-val">{r.value}</span>
                              </div>
                              <div className="tech-read-plain">{r.plain}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="dq-hint">ATR=一天正常波动幅度 · 布林下轨=低吸区/上轨=高抛区 · RSI/KDJ 超买该抛超卖可吸 · 本地测算，仅供参考</div>
                    </>
                  )}
                </div>
              )}

              {/* 开高低量 + 均线（决策价值低，默认折叠）*/}
              <div className="ma-fold-wrap">
                <button className="ma-fold" onClick={() => setShowMa((v) => !v)}>
                  <span><Icon name="chart" size={13} /> 开高低量 · 均线</span>
                  <Icon name={showMa ? 'chevronDown' : 'chevronRight'} size={13} />
                </button>
                {showMa && (
                  <>
                    <div className="dq-ohlc">
                      <span>开 <b>{fmtRaw(overview.last.open)}</b></span>
                      <span>高 <b className="red">{fmtRaw(overview.last.high)}</b></span>
                      <span>低 <b className="green">{fmtRaw(overview.last.low)}</b></span>
                      <span>量 <b>{fmtVol(overview.last.volume)}</b></span>
                    </div>
                    <div className="dq-ma">
                      {overview.mas.map((m) => (
                        <div className={'dq-ma-cell' + (m.v == null ? ' na' : m.above ? ' above' : ' below')} key={m.n}>
                          <span className="dq-ma-k">MA{m.n}</span>
                          <span className="dq-ma-v">{m.v == null ? '--' : fmtRaw(m.v)}</span>
                          {m.diff != null && <span className={'dq-ma-d ' + (m.above ? 'red' : 'green')}>{m.diff >= 0 ? '+' : ''}{m.diff}%</span>}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* 分时 / K线 */}
          <div className="detail-kline">
            <div className="detail-kline-head">
              <div className="tabs">
                <div className={'tab' + (mode === 'trend' ? ' active' : '')} onClick={() => setMode('trend')}>分时</div>
                <div className={'tab' + (mode === 'kline' ? ' active' : '')} onClick={() => setMode('kline')}>K线</div>
              </div>
              {mode === 'kline' ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <div className="tabs">
                    <div className={'tab' + (chartType === 'candle' ? ' active' : '')} onClick={() => setChartType('candle')}>蜡烛图</div>
                    <div className={'tab' + (chartType === 'line' ? ' active' : '')} onClick={() => setChartType('line')}>折线图</div>
                  </div>
                  <div className="tabs">
                    {[['101', '日K'], ['102', '周K'], ['103', '月K']].map(([v, t]) => (
                      <div key={v} className={'tab' + (klt === v ? ' active' : '')} onClick={() => setKlt(v)}>{t}</div>
                    ))}
                  </div>
                </div>
              ) : (
                <span className="sub-name">当日分时 · 蓝=价格 金=均价 虚线=昨收</span>
              )}
            </div>
            {mode === 'trend' ? (
              (loading && !data) ? (
                <div className="loading">加载分时中…</div>
              ) : trendOption ? (
                <ReactECharts
                  key={`${stock.code}-trend-${trends.length}`}
                  option={trendOption}
                  style={{ height: 340, width: '100%' }}
                  notMerge lazyUpdate={false}
                  opts={{ renderer: 'canvas' }}
                  onChartReady={(chart) => { setTimeout(() => chart.resize(), 60) }}
                />
              ) : (
                <div className="empty">暂无分时数据（非交易时段或数据源繁忙）。可切到「K线」查看，或点右上刷新。</div>
              )
            ) : (loading && !data) || retrying ? (
              <div className="loading">{retrying ? '数据源繁忙，正在重试加载 K 线…' : '加载 K 线中…'}</div>
            ) : option ? (
              <ReactECharts
                key={`${stock.code}-${klt}-${chartType}-${candles.length}`}
                option={option}
                style={{ height: 340, width: '100%' }}
                notMerge lazyUpdate={false}
                opts={{ renderer: 'canvas' }}
                onChartReady={(chart) => { setTimeout(() => chart.resize(), 60) }}
              />
            ) : (
              <div className="empty">
                {error ? '数据源繁忙，K线暂时没取到' : '未获取到 K 线数据'}
                <button className="btn" style={{ marginLeft: 10 }} disabled={refreshing} onClick={doRefresh}>
                  <Icon name="refresh" size={13} className={refreshing ? 'spin' : ''} /> {refreshing ? '重试中…' : '重试'}
                </button>
              </div>
            )}
          </div>

          {/* 盯盘预警表单（点底栏「预警」展开）*/}
          {showAlert && (
            <div className="detail-alert-box">
              <AlertForm stock={{ code: stock.code, name: (profile && profile.name) || stock.name }} onDone={() => setShowAlert(false)} />
              <div className="sub-name" style={{ fontSize: 11, marginTop: 4 }}>命中后会通过预警中心（顶部铃铛）+ 浏览器通知提醒你</div>
            </div>
          )}

          {/* 公司简介（放最下，默认折叠——决策时不占屏，想看再展开）*/}
          {profile && (profile.fullName || profile.industry || profile.website || profile.business || profile.intro) && (
            <div className="info-fold-wrap">
              <button className="info-fold" onClick={() => setShowInfo((v) => !v)}>
                <span><Icon name="building" size={13} /> 公司简介 · 主营{profile.industry ? ` · ${profile.industry}` : ''}</span>
                <Icon name={showInfo ? 'chevronDown' : 'chevronRight'} size={13} />
              </button>
              {showInfo && (
                <div className="detail-info">
                  {profile.fullName && <div className="detail-full">{profile.fullName}</div>}
                  <div className="detail-meta">
                    {profile.industry && <span className="detail-chip"><Icon name="building" size={12} /> {profile.industry}</span>}
                    {normalizeUrl(profile.website) && (
                      <a className="detail-chip detail-link" href={normalizeUrl(profile.website)} target="_blank" rel="noopener noreferrer" title="打开公司官网">
                        <Icon name="compass" size={12} /> {profile.website} <Icon name="chevronRight" size={11} />
                      </a>
                    )}
                  </div>
                  {profile.business && (
                    <div className="detail-block">
                      <div className="detail-label">主营业务</div>
                      <div className="detail-text"><Linkify text={profile.business} /></div>
                    </div>
                  )}
                  {profile.intro && (
                    <div className="detail-block">
                      <div className="detail-label">公司简介</div>
                      <div className="detail-text detail-intro"><Linkify text={profile.intro} /></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="ai-disclaimer" style={{ padding: '10px 4px 0' }}>
            数据来源：东方财富公开接口 · 仅供研究参考，非投资建议
          </div>
        </div>

        {/* 固定底部动作栏：AI 助手 / 预警，随详情始终可点 */}
        <div className="detail-footbar">
          <button
            className="btn btn-primary footbar-main"
            onClick={() => {
              const nm = (profile && profile.name) || stock.name
              const cur = overview ? `当前价 ${fmtRaw(overview.price)}（${fmtPct(overview.pct)}）` : ''
              const trend = overview && overview.trend ? `，均线${overview.trend.label}` : ''
              const text =
                `帮我分析一下 ${nm}(${stock.code})。${cur}${trend}。\n` +
                `想了解：\n` +
                `1. 现在的资金面和量价配合怎么样？主力是在进还是在出？\n` +
                `2. 结合均线（MA5/10/20/60）和当前位置，短线是偏多还是偏空？\n` +
                `3. 有没有值得关注的消息面或所属板块的催化？\n` +
                `4. 如果做短线，买点、止盈、止损大概怎么设？`
              aiStore.prefillStock({ code: stock.code, name: nm }, text)
              onClose()
            }}
          >
            <Icon name="spark" size={14} /> AI 助手分析
          </button>
          <button className={'btn footbar-alert' + (showAlert ? ' on' : '')} onClick={() => setShowAlert((v) => !v)}>
            <Icon name="bell" size={14} /> {showAlert ? '收起预警' : '盯盘预警'}
          </button>
        </div>

        {/* 端点已满弹窗:并发数=承接 advisor 角色的 AI 端点数;当前端点全部在生成时触发。
            列出正在生成的股票名(可点击直接跳转到对应个股详情),等有端点腾空再来生成本股。*/}
        {busyModal && (
          <div className="busy-modal-mask" onClick={() => setBusyModal(null)}>
            <div className="busy-modal" onClick={(e) => e.stopPropagation()}>
              <div className="busy-modal-head">
                <span className="busy-modal-title"><Icon name="gauge" size={15} /> AI 端点已满</span>
                <button className="icon-btn" onClick={() => setBusyModal(null)} title="关闭"><Icon name="close" size={15} /></button>
              </div>
              <div className="busy-modal-desc">
                当前 {busyModal.concurrency || busyModal.busy.length} 个 AI 端点已全部占用（并发数=已配置端点数）。
                下列个股正在生成，完成后会自动腾出端点，届时可再次点击生成。
              </div>
              <div className="busy-modal-list">
                {busyModal.busy.map((x) => (
                  <button
                    key={x.code}
                    className="busy-modal-item"
                    onClick={() => { detailStore.open({ code: x.code, name: x.name }); setBusyModal(null) }}
                    title="查看该股详情与生成进度"
                  >
                    <span className="busy-item-name">{x.name}</span>
                    <span className="busy-item-code">{x.code}</span>
                    <Icon name="refresh" size={12} className="spin" />
                    <Icon name="chevronRight" size={13} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- 复盘结论卡：已下线（复盘统一在「持仓·做T」卡片上自动展示，个股详情不再单独提供复盘）----------

