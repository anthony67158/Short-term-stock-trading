import { useState, useMemo, useEffect, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import Icon from './Icon'
import StockTags from './StockTags'
import AdviceGenerationStatus from './AdviceGenerationStatus'
import AdvicePresentation from './AdvicePresentation'
import { usePolling } from '../hooks'
import { fmtPct, pctClass, fmtRaw, fmtNum } from '../format'
import { api } from '../apiBase'
import { usePlanStore, planStore, computePortfolio, livePositionOf, t1StatusOf } from '../planStore'
import { nextTradingDayLabel } from '../../shared/tradingCalendar.js'
import { getAdvice, subscribeAdvice } from '../adviceCache'
import { subscribeRunner, isRunning, getRunning, getResult } from '../adviceRunner'
import { tryStartAdvice, generatingList } from '../adviceGate'
import { subscribeBatch, getBatchState } from '../adviceBatch'
import { detailStore } from '../detailStore'
import {
  currentQuantModelVersion,
  quantModelHeaders,
  quantModelQuery,
} from '../quantModel'
import {
  cloudAdviceLoadingState,
  mergeAdviceRefreshState,
  newestAdviceResult,
  shouldShowAdviceResult,
} from '../../shared/adviceUiState.js'
import { latestKnowledgeActionReview } from '../../shared/knowledgeAction.js'
import {
  adviceGenerationActions,
  adviceModeGuidance,
  stockWatchAction,
} from '../../shared/stockDetailActions.js'
import { AlertForm } from './AlertCenter'
import { portfolioExposureContext } from '../../shared/portfolioExposure.js'
import { isAdviceReviewEnabled } from '../../shared/adviceReviewPolicy.js'
import { useAiSearchConfig } from '../aiSearchConfigStore'
import { trustCalibrationText } from '../../shared/advicePresentation.js'
import { adviceTrustBands } from '../../shared/adviceIntelligence.js'
import { tradeActivityContext } from '../../shared/portfolioAccounting.js'
import {
  selectPrimaryProductionForecast,
  shouldRefreshProductionForecast,
} from '../../shared/productionForecastWindow.js'

// 把公司网址补全为可点击的绝对 URL（东财 F10 常给不带协议的裸域名）
function normalizeUrl(raw) {
  if (!raw) return null
  let u = String(raw).trim().split(/[,;，、\s]+/)[0] // 只取第一个
  if (!u || u === '-' || u === '--') return null
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u
  try { new URL(u); return u } catch { return null }
}

function adviceDisplayState(entry) {
  if (!entry || typeof entry !== 'object') return null
  return {
    result: entry.result,
    advice: entry.advice,
    meta: entry.meta,
    news: entry.news,
    adviceMissing: entry.adviceMissing,
    truncated: entry.truncated,
    generationMetrics: entry.generationMetrics || null,
    cachedAt: entry.cachedAt || entry.at,
  }
}

// 成交量（手）友好显示
function fmtVol(v) {
  if (v == null || isNaN(v)) return '--'
  const a = Math.abs(v)
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿手'
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万手'
  return Math.round(v) + '手'
}

function formatQuantAsOf(value) {
  const match = String(value || '').match(
    /(?:\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/,
  )
  return match ? `${match[1]}/${match[2]} ${match[3]}:${match[4]}` : String(value || '')
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
  const [busyModal, setBusyModal] = useState(null) // 端点已满提示:{ busy:[{code,name}], concurrency } | null
  const quantRefreshRef = useRef('')
  const searchConfig = useAiSearchConfig()
  const book = usePlanStore()
  const reviewEnabled = isAdviceReviewEnabled(
    book.settings,
    stock && stock.code,
  )
  const knowledgeActionReview = useMemo(
    () => latestKnowledgeActionReview(
      book.decisionLog,
      stock && stock.code,
    ),
    [book.decisionLog, stock && stock.code],
  )
  // 账户全景(总资产/可用现金/总仓位/单票占比)——供 AI 按资金和仓位算具体手数。
  // ★不要依赖 overview(它在后面才定义，提前引用会触发 TDZ 报错导致弹窗白屏)；
  //   computePortfolio 对无实时报价的持仓会退回其 buyPrice 估值，足够给 AI 做仓位约束。
  const portfolio = useMemo(() => {
    return computePortfolio(book.holding || [], {}, book.account || null)
  }, [book.holding, book.account])
  // 个股详情与持仓卡共用实时仓位及有效成本口径，避免做T收益只在其中一侧生效。
  const myHold = useMemo(() => {
    const live = livePositionOf(stock && stock.code)
    if (!live) return null
    return {
      cost: live.costWithFees ?? live.cost,
      qty: live.qty,
      hasOpenT: live.hasOpenT,
      tNetHands: live.tNetHands,
    }
  }, [book.holding, stock && stock.code])
  // 切换股票时：重置各折叠区
  useEffect(() => {
    setShowTech(false); setShowForecast(false); setShowMa(false); setShowInfo(false)
    quantRefreshRef.current = ''
  }, [stock && stock.code])
  // 操作建议状态源（三级优先）：①后台 runner 正在跑 → 展示实时进度；②本会话刚跑完的瞬时结果
  // (含 error/adviceMissing/truncated)；③持久缓存(关闭再进/刷新仍可见)。订阅 runner：即使
  // 关闭弹窗后台仍在生成，重新打开时 sync() 会按当前 code 拉到「后台生成中」或已完成的结果。
  useEffect(() => {
    const code = stock && stock.code
    if (!code) { setQuantState(null); return }
    const sync = () => {
      const expectedMode = myHold ? 'hold_advice' : 'buy_advice'
      const cached = getAdvice(code, expectedMode)
      const cachedState = adviceDisplayState(cached)
      if (isRunning(code)) {
        const r = getRunning(code)
        setQuantState(mergeAdviceRefreshState({
          loading: true,
          stage: r?.stage || 'preparing',
          phase: r && r.phase,
          sources: (r && r.sources) || [],
          reasoning: (r && r.reasoning) || '',
          quant: (r && r.quant) || null,
          deepMode: r?.deepMode === true,
        }, cachedState))
        return
      }
      const selectedResult = newestAdviceResult(getResult(code), cached, expectedMode)
      const res = selectedResult.source === 'runner' ? selectedResult.value : null
      if (res && res.pending) {
        // 本地生成中断→已转云端继续,展示中转 loading,待云端回灌自动切成品
        setQuantState(mergeAdviceRefreshState({
          loading: true,
          cloud: true,
          phase: (res.error && String(res.error)) || '云端继续生成中,稍候自动刷新…',
          sources: [],
          reasoning: '',
          quant: null,
        }, cachedState))
        return
      }
      if (res) {
        setQuantState(res.error
          ? mergeAdviceRefreshState({ error: res.error }, cachedState)
          : adviceDisplayState(res))
        return
      }
      // 服务端(云端)批量/按需生成:该股在 FC 上生成,本机 isRunning 为 false。
      // 若它出现在批量进度的 current(正在跑)或仍是 pending/running 项 → 展示「云端生成中」,
      // 待结果经 authStore.pull 回灌 adviceCache 后自动切成品(见下方 subscribeAdvice)。
      try {
        const bs = getBatchState()
        if (bs && bs.serverMode) {
          const c = String(code)
          const it = (bs.items || []).find((x) => String(x.code) === c)
          const cloudLoading = cloudAdviceLoadingState(bs, c)
          if (cloudLoading) {
            setQuantState(mergeAdviceRefreshState(cloudLoading, cachedState))
            return
          }
          // 云端已把该股标记为失败 → 如实提示生成失败(不做假成功)
          if (it && it.status === 'fail') {
            setQuantState(mergeAdviceRefreshState({
              error: (it.error && String(it.error)) || '生成失败,请重试',
            }, cachedState))
            return
          }
        }
      } catch { /* ignore */ }
      const latestCache = selectedResult.source === 'cache' ? selectedResult.value : cached
      setQuantState(adviceDisplayState(latestCache))
    }
    sync()
    const unRunner = subscribeRunner(sync)
    const unBatch = subscribeBatch(sync)   // 服务端批量进度回灌 → 云端生成中/失败态实时反映
    const unAdvice = subscribeAdvice(sync) // 云端结果回灌 adviceCache → 自动切成品
    return () => { unRunner(); unBatch(); unAdvice() }
  }, [stock && stock.code, !!myHold])
  const loadQuant = async (deepMode = false) => {
    if (!stock) return
    quantRefreshRef.current = ''
    const expectedMode = myHold ? 'hold_advice' : 'buy_advice'
    const previousState = adviceDisplayState(getAdvice(stock.code, expectedMode))
    setQuantState(mergeAdviceRefreshState({
      loading: true,
      cloud: true,
      stage: 'preparing',
      deepMode,
      phase: '正在提交云端生成任务…',
      sources: [],
      reasoning: '',
      quant: null,
    }, previousState))
    const quantModelVersion = currentQuantModelVersion()
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
          const tg = (t && t.groups || []).filter((x) => x.total >= 8)
          if (tg.length) theoryScores = tg.map((x) => ({ theory: x.theory, winRate: x.winRate, total: x.total, avgPct: x.avgPct }))
        } catch { /* ignore */ }
        const actionScores = (s.actions || [])
          .filter((x) => x.total >= 5)
          .map((x) => ({
            kind: x.kind,
            label: x.label,
            winRate: x.winRate,
            total: x.total,
            avgPct: x.avgPct,
          }))
        return {
          overallWinRate: s.winRate, overallAvgPct: s.avgPct, overallTotal: s.total,
          modeWinRate: g ? g.winRate : null, modeAvgPct: g ? g.avgPct : null, modeTotal: g ? g.total : 0,
          actionScores,
          theoryScores,
          trustBands: adviceTrustBands(s),
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
      ...portfolioExposureContext(portfolio),
    }
    // 持仓 → LLM 给"加/减/持有/清仓 + 具体价位"；未持仓 → LLM 给"买入/等回调/观望 结论 + 对应建议"
    const aiPayload = myHold
      ? {
          code: stock.code,
          name: (profile && profile.name) || stock.name,
          quantModelVersion,
          holdCost: myHold.cost,
          holdQty: myHold.qty,
          openTNet: myHold.hasOpenT ? myHold.tNetHands : 0,
          tradeContext: tradeActivityContext(
            book.closed || [],
            stock.code,
          ),
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
              const positions = portfolio && portfolio.positions
                ? portfolio.positions.filter((x) => x.code === stock.code)
                : []
              if (!positions.length) return null
              return +positions.reduce((sum, position) => sum + (Number(position.weight) || 0), 0).toFixed(1)
            })(),
          },
        }
      : {
          code: stock.code,
          name: (profile && profile.name) || stock.name,
          quantModelVersion,
          advisorTrack,
          account,
        }
    const priceHint = (overview && overview.price) || myHold?.cost || null
    // ★关键★ 生成流程交给模块级后台 runner：关闭弹窗也照跑完、落缓存、记决策；
    // 本组件仅订阅 runner + 缓存来展示进度/结果（见下方 useEffect）。
    // 经门控层触发:并发已满 → 不启动,弹「端点已满 + 正在生成清单」;该股已在生成 → 复用进度不重复触发。
    const r = await tryStartAdvice({
      code: stock.code,
      mode: myHold ? 'hold_advice' : 'buy_advice',
      name: (profile && profile.name) || stock.name,
      myHold: !!myHold,
      aiPayload,
      priceHint,
      deepMode,
    })
    if (r?.mode === 'server') {
      const acceptedState = cloudAdviceLoadingState({
        ...(r.progress || {}),
        serverMode: true,
      }, stock.code)
      setQuantState(mergeAdviceRefreshState({
        loading: true,
        cloud: true,
        stage: acceptedState?.stage || 'queued',
        deepMode: acceptedState?.deepMode ?? deepMode,
        phase: r.status === 'queued'
          ? (r.error || '任务已排队，等待云端Worker恢复')
          : r.status === 'already'
            ? '云端已有同一任务，正在恢复实时进度'
            : (
                acceptedState?.phase
                || '云端已受理，刷新或切到后台也会继续生成'
              ),
        sources: acceptedState?.sources || [],
        reasoning: acceptedState?.reasoning || '',
        quant: acceptedState?.quant || null,
      }, previousState))
    }
    if (r && r.status === 'full') {
      setBusyModal({ busy: r.busy || [], concurrency: r.concurrency || 0 })
      setQuantState(previousState)
    }
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
    quantRefreshRef.current = ''
    retryRef.current = 0
    const started = Date.now()
    try { await reload() } catch { /* usePolling 内部已兜底 */ }
    const wait = Math.max(0, 600 - (Date.now() - started))
    setTimeout(() => { setRefreshing(false); setRefreshedAt(Date.now()) }, wait)
  }

  const profile = data && data.profile
  const candles = (data && data.candles) || []
  const latestCandleDate = candles.length
    ? String(candles[candles.length - 1]?.date || '')
    : ''
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

  // 收盘后详情K线已更新、但建议缓存仍保留上一交易日量化结果时，
  // 单独刷新量化，不必等待整套军师LLM生成完成。
  useEffect(() => {
    const code = stock && stock.code
    const resultAsOf = quantState?.result?.asOf
    if (
      !code
      || klt !== '101'
      || !quantState?.result
      || !shouldRefreshProductionForecast({
        asOf: resultAsOf,
        latestCandleDate,
      })
    ) return undefined

    const version = currentQuantModelVersion()
    const refreshKey = `${code}:${version}:${latestCandleDate}`
    if (quantRefreshRef.current === refreshKey) return undefined
    quantRefreshRef.current = refreshKey

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    const holdQuery = myHold
      ? `&holdCost=${encodeURIComponent(myHold.cost)}&holdQty=${encodeURIComponent(myHold.qty)}`
      : ''
    const url = api(
      `/api/stock_detail?code=${encodeURIComponent(code)}&klt=101&lmt=60&quant=1`
      + `${quantModelQuery(version)}${holdQuery}&_t=${Date.now()}`,
    )
    fetch(url, {
      signal: controller.signal,
      headers: quantModelHeaders(version),
    })
      .then((response) => response.json())
      .then((payload) => {
        const nextQuant = payload?.ok ? payload.quant : null
        if (
          !nextQuant
          || !nextQuant.asOf
          || shouldRefreshProductionForecast({
            asOf: nextQuant.asOf,
            latestCandleDate,
          })
        ) return
        setQuantState((current) => current
          ? {
              ...current,
              result: nextQuant,
              quantRefreshedAt: Date.now(),
            }
          : current)
      })
      .catch(() => {})
      .finally(() => clearTimeout(timeout))
    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [
    stock && stock.code,
    klt,
    latestCandleDate,
    quantState?.result?.asOf,
    myHold?.cost,
    myHold?.qty,
    book.settings?.quantModelVersion,
    refreshedAt,
  ])

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
  const inWatchlist = (book.plan || []).some(
    (item) => item.code === stock.code,
  )
  const isHeldStock = (book.holding || []).some(
    (item) => item.code === stock.code,
  )
  const watchAction = stockWatchAction({
    inWatchlist,
    isHeld: isHeldStock,
  })
  const adviceActions = adviceGenerationActions({
    loading: Boolean(quantState?.loading),
    deepMode: quantState?.deepMode === true,
  })
  const modeGuidance = adviceModeGuidance({
    hasAdvice: Boolean(quantState?.advice),
  })

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="detail-panel" role="dialog" aria-modal="true" aria-label={`${stock.name || stock.code} 个股详情`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-bar detail-header">
          <div className="detail-title-block">
            <div className="detail-title-primary">
              <span className="detail-stock-name">
                {(profile && profile.name) || stock.name}
              </span>
              <span className="detail-code">{stock.code}</span>
            </div>
            <div className="detail-title-meta">
              {profile?.market && (
                <span className="detail-market">{profile.market}</span>
              )}
              <StockTags
                code={stock.code}
                fallbackIndustry={profile?.industry}
                variant="detail"
                className="detail-title-tags"
              />
            </div>
          </div>
          <div className="modal-actions">
            <button
              className={
                'detail-watch-btn'
                + (watchAction.active ? ' active' : '')
              }
              type="button"
              aria-label={watchAction.label}
              title={
                isHeldStock
                  ? '持仓股票已纳入持续关注，无需重复加入自选'
                  : watchAction.label
              }
              disabled={watchAction.disabled}
              onClick={() => {
                if (inWatchlist) planStore.removePlan(stock.code)
                else planStore.addPlan({
                  code: stock.code,
                  name: (profile && profile.name) || stock.name,
                })
              }}
            >
              <Icon name={watchAction.icon} size={14} />
            </button>
            <button
              className="icon-btn detail-refresh"
              title="刷新最新价格 / K线"
              aria-label={refreshing ? '刷新中' : '刷新最新价格和K线'}
              disabled={refreshing || loading}
              onClick={doRefresh}
            >
              <Icon name="refresh" size={15} className={refreshing || loading ? 'spin' : ''} />
            </button>
            <button type="button" className="modal-close" aria-label="关闭个股详情" onClick={onClose}><Icon name="close" size={16} /></button>
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
                  <div className="decide-primary">
                    <div className="decide-title">
                      <Icon name="target" size={14} />
                      <span>军师 · AI 操作建议</span>
                    </div>
                    {myHold ? <span className="decide-hold">持仓 {myHold.qty}手 · 成本{fmtRaw(myHold.cost)}</span>
                            : <span className="decide-hold none">未持仓</span>}
                  </div>
                  <div className="decide-status">
                    {quantState && quantState.result && quantState.result.asOf
                      ? (
                        <span className="quant-asof">
                          <Icon name="clock" size={12} />
                          量化信号 · {formatQuantAsOf(quantState.result.asOf)}
                        </span>
                      )
                      : <span className="quant-asof muted">等待量化信号</span>}
                    <button
                      type="button"
                      className={'advice-review-toggle' + (reviewEnabled ? ' on' : '')}
                      aria-pressed={reviewEnabled}
                      title={reviewEnabled
                        ? '关闭后停止该股事件监控与军师派生预警'
                        : '开启该股事件监控'}
                      onClick={() => planStore.setAdviceReviewEnabled(
                        stock.code,
                        !reviewEnabled,
                      )}
                    >
                      <span className="advice-review-toggle-track" aria-hidden="true">
                        <span />
                      </span>
                      <span>{reviewEnabled ? '事件监控' : '仅手动'}</span>
                    </button>
                  </div>
                </div>

                {!quantState && (
                  <div className="quant-cta" role="status">
                    <Icon name="spark" size={14} />
                    <span>尚无操作建议</span>
                  </div>
                )}
                {quantState && quantState.loading && (
                  <AdviceGenerationStatus
                    code={stock.code}
                    variant="detail"
                    detailState={quantState}
                    searchEnabled={searchConfig.enabled}
                  />
                )}
                {quantState && quantState.error && (
                  <div className="quant-err">{quantState.error}
                    <button type="button" className="advice-regenerate-btn" onClick={() => loadQuant(false)}>
                      <Icon name="refresh" size={13} />重新生成
                    </button>
                  </div>
                )}
                {shouldShowAdviceResult(quantState) && (() => {
                  const q = quantState.result || {}
                  const adv = quantState.advice
                  const dec = q.decision || {}
                  const fc = q.forecast
                  const isV21 = q.modelVersion === 'v2.1' && !!q.v21
                  const isV2 = q.modelVersion === 'v2' && !!q.v2
                  const isMinuteModel = isV21 || isV2
                  const nextFc = !isMinuteModel
                    ? q.nextTradeDayForecast
                    : null
                  const currentDayFc = !isMinuteModel
                    ? q.currentTradingDayForecast
                    : null
                  const primarySelection = selectPrimaryProductionForecast({
                    currentTradingDayForecast: currentDayFc,
                    nextTradeDayForecast: nextFc,
                    nextSignalAsOf: q.asOf,
                    latestCandleDate,
                  })
                  const primaryFc = primarySelection.forecast
                  const primaryWindow = primarySelection.window
                  const fallbackVerdict = {
                    tone: dec.tone || 'muted',
                    title: dec.title || '—',
                    detail: dec.detail || '',
                  }
                  const meta = quantState.meta || {}
                  const trust = meta.trustScore
                  const trustCalibration = trustCalibrationText(trust)
                  const resonance = meta.resonance
                  const marketEnv = meta.marketEnv
                  const generationMetrics = quantState.generationMetrics
                  const cachedStr = quantState.cachedAt ? new Date(quantState.cachedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
                  return (
                    <>
                      {adv ? (
                        <AdvicePresentation
                          advice={adv}
                          knowledgeActionReview={knowledgeActionReview}
                          reviewEnabled={reviewEnabled}
                          executionPlanState={
                            (book.executionPlans || []).find(
                              (plan) =>
                                plan.planId === adv.executionPlan?.planId,
                            ) || null
                          }
                          onArmExecutionPlan={() =>
                            planStore.armExecutionPlan(
                              adv.executionPlan,
                              Date.now(),
                              overview?.price,
                            )
                          }
                        />
                      ) : (
                        <div className={'decide-verdict ' + fallbackVerdict.tone}>
                          <div className="dv-action">{fallbackVerdict.title}</div>
                          <div className="dv-detail">{fallbackVerdict.detail}</div>
                        </div>
                      )}

                      {(trust || resonance || marketEnv || generationMetrics || cachedStr) && (
                        <div className="advice-context-strip">
                          {trust && <span>可信度 <b>{trust.score}</b> · {trust.band}</span>}
                          {trustCalibration && (
                            <span className="calibrated">{trustCalibration}</span>
                          )}
                          {resonance && <span>共振 <b>{resonance.score}/{resonance.max}</b></span>}
                          {marketEnv && <span>{marketEnv.level}</span>}
                          {generationMetrics?.durationMs > 0 && (
                            <span className="generation-proof">
                              <Icon name="check" size={10} />
                              完整结果 · {generationMetrics.profile === 'DEEP' ? '深度生成' : '快速生成'}
                              {' · '}
                              {(generationMetrics.durationMs / 1000).toFixed(1)}秒
                            </span>
                          )}
                          {cachedStr && <span className="saved"><Icon name="history" size={10} /> {cachedStr} 已保存</span>}
                        </div>
                      )}

                      {/* 未持仓但 AI 建议没返回 → 提示重试（避免只给模糊量化结论）*/}
                      {quantState.adviceMissing && !adv && (
                        <div className="advice-retry">
                          <Icon name="spark" size={13} /> AI 操作建议(结论/买点/时机/止损)生成超时，
                          <button type="button" className="advice-regenerate-btn" onClick={() => loadQuant(false)}>
                            <Icon name="refresh" size={13} />重新生成
                          </button>
                        </div>
                      )}

                      {/* AI 输出被长度截断(内容不全) → 明确提示 + 一键重新生成，避免用户以为"卡住/只显示了一半" */}
                      {quantState.truncated && adv && (
                        <div className="advice-retry">
                          <Icon name="spark" size={13} /> 本次分析内容较长被截断，下方可能不完整，
                          <button type="button" className="advice-regenerate-btn" onClick={() => loadQuant(false)}>
                            <Icon name="refresh" size={13} />重新生成完整版
                          </button>
                        </div>
                      )}

                      {/* 走势预测 + 量化：默认折叠为一行概览，点开看蒙特卡洛细节 */}
                      {(fc || q.score != null) && (
                        <div className="fc-fold-wrap">
                          <button className="fc-fold" onClick={() => setShowForecast((v) => !v)}>
                            <span className="fc-fold-summary">
                              {primaryFc && (
                                <span className={'fc-dir-inline production ' + (primaryFc.direction === '看涨' ? 'red' : primaryFc.direction === '看跌' ? 'green' : 'muted')}>
                                  {primaryWindow.shortLabel}{primaryFc.direction}·概率{primaryFc.upProb}%·{fmtRaw(primaryFc.targetLow)}~{fmtRaw(primaryFc.targetHigh)}
                                </span>
                              )}
                              {fc && <span className={'fc-dir-inline ' + (fc.direction === '看涨' ? 'red' : fc.direction === '看跌' ? 'green' : 'muted')}>量化{isMinuteModel ? (fc.horizon || '下一交易日') : `${fc.days || 5}日`}{fc.direction}·概率{fc.upProb}%</span>}
                              {q.score != null && <span className={'quant-chip sm ' + (q.score >= 62 ? 'red' : q.score <= 38 ? 'green' : 'gold')}>量化 {q.score}·{q.bias}</span>}
                            </span>
                            <Icon name={showForecast ? 'chevronDown' : 'chevronRight'} size={13} />
                          </button>
                          {showForecast && (
                            <>
                              {fc && (
                                <div className="forecast-box">
                                  <div className="fc-row1">
                                    <span className={'fc-dir ' + ((primaryFc || fc).direction === '看涨' ? 'red' : (primaryFc || fc).direction === '看跌' ? 'green' : 'muted')}>
                                      {primaryFc
                                        ? `${primaryWindow.label} ${primaryFc.direction}`
                                        : `${isMinuteModel ? (fc.horizon || '下一交易日') : `未来${fc.days || 5}日`} ${fc.direction}`}
                                    </span>
                                    <span className="fc-conf">预测信心 {(primaryFc || fc).confidence}</span>
                                  </div>
                                  {isV21 ? (
                                    <div className="v21-heads">
                                      <div className="v21-asof">
                                        <b>V2.1 盘中双头</b>
                                        <span>信号 {q.asOf || '—'} · {q.v21.session || '盘中'} · 当前采用{q.v21.activeHead === 'sessionClose' ? '截至收盘' : '未来30分钟'}</span>
                                      </div>
                                      {[
                                        ['next30m', '未来30分钟'],
                                        ['sessionClose', '截至今日收盘'],
                                      ].map(([key, label]) => {
                                        const head = q.v21.heads?.[key]
                                        if (!head) return null
                                        const probabilities = head.probabilities || {}
                                        return (
                                          <div className={'v21-head ' + (q.v21.activeHead === key ? 'active' : '')} key={key}>
                                            <div className="v2-price-head">
                                              <span>{label}</span>
                                              <small>{head.predictedClass || '待判断'}{q.v21.activeHead === key ? ' · 当前采用' : ''}</small>
                                            </div>
                                            <div className="fc-grid v2">
                                              <div className="fc-cell"><span className="fc-k">止盈概率</span><span className="fc-v red">{Math.round((probabilities.takeProfit || 0) * 100)}%</span></div>
                                              <div className="fc-cell"><span className="fc-k">止损概率</span><span className="fc-v green">{Math.round((probabilities.stopLoss || 0) * 100)}%</span></div>
                                              <div className="fc-cell"><span className="fc-k">震荡概率</span><span className="fc-v">{Math.round((probabilities.timeout || 0) * 100)}%</span></div>
                                              <div className="fc-cell"><span className="fc-k">障碍期望</span><span className={'fc-v ' + ((head.outlook?.expectedBarrierReturnPct || 0) >= 0 ? 'red' : 'green')}>{head.outlook?.expectedBarrierReturnPct ?? '—'}%</span></div>
                                            </div>
                                          </div>
                                        )
                                      })}
                                      {q.v21.priceReferences && (
                                        <div className="v2-price-refs">
                                          <div className="v2-price-head">
                                            <span>盘中价格锚点</span>
                                            <small>截至信号时点，不是保证目标价</small>
                                          </div>
                                          <div className="v2-price-grid">
                                            <span>锚点 <b>{q.v21.priceReferences.anchorPrice ?? '—'}</b></span>
                                            <span>支撑 <b className="red">{q.v21.priceReferences.supportPrice ?? '—'}</b></span>
                                            <span>压力 <b className="green">{q.v21.priceReferences.resistancePrice ?? '—'}</b></span>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  ) : isV2 ? (
                                    <>
                                      <div className="fc-grid v2">
                                        <div className="fc-cell"><span className="fc-k">止盈概率</span><span className="fc-v red">{fc.upProb}%</span></div>
                                        <div className="fc-cell"><span className="fc-k">止损概率</span><span className="fc-v green">{fc.downProb}%</span></div>
                                        <div className="fc-cell"><span className="fc-k">超时概率</span><span className="fc-v">{fc.timeoutProb}%</span></div>
                                        <div className="fc-cell"><span className="fc-k">概率优势</span><span className="fc-v">{q.v2.outlook?.probabilityEdgePct ?? '—'}%</span></div>
                                        <div className="fc-cell"><span className="fc-k">障碍期望</span><span className={'fc-v ' + (fc.expRet >= 0 ? 'red' : 'green')}>{fc.expRet >= 0 ? '+' : ''}{fc.expRet}%</span></div>
                                        <div className="fc-cell"><span className="fc-k">确定度 / 不确定性</span><span className="fc-v">{q.v2.outlook?.convictionScore ?? '—'} / {q.v2.outlook?.uncertaintyLevel || '—'}</span></div>
                                        <div className="fc-cell"><span className="fc-k">30分钟动量</span><span className="fc-v">{q.v2.marketContext?.momentum30mPct ?? '—'}%</span></div>
                                        <div className="fc-cell"><span className="fc-k">波动 / 量能比</span><span className="fc-v">{q.v2.marketContext?.realizedVolPct ?? '—'}% / {q.v2.marketContext?.volumeRatio20 ?? '—'}</span></div>
                                        <div className="fc-cell"><span className="fc-k">收盘位置</span><span className="fc-v">{q.v2.marketContext?.closeLocationPct ?? '—'}%</span></div>
                                        <div className="fc-cell"><span className="fc-k">风险 / 强度</span><span className="fc-v">{q.v2.outlook?.riskLevel || '—'} / {q.v2.outlook?.signalStrength || '—'}</span></div>
                                      </div>
                                      {q.v2.executionReference && (
                                        <div className="v2-execution-ref">
                                          <div className="v2-price-head">
                                            <span>当前时段执行参考</span>
                                            <small>{q.v2.executionReference.horizon} · 不计入V2正确率</small>
                                          </div>
                                          <div className="v2-price-grid">
                                            <span>实时锚点 <b>{q.v2.executionReference.anchorPrice}</b></span>
                                            <span>VWAP <b>{q.v2.executionReference.vwap}</b></span>
                                            <span>动态下沿 <b className="green">{q.v2.executionReference.rangeLow}</b></span>
                                            <span>动态上沿 <b className="red">{q.v2.executionReference.rangeHigh}</b></span>
                                            <span>30分钟动量 <b>{q.v2.executionReference.momentum30mPct}%</b></span>
                                          </div>
                                        </div>
                                      )}
                                      {q.v2.v21FallbackReason && (
                                        <div className="qmc-error">V2.1 暂不可用，已回退上一收盘日 V2：{q.v2.v21FallbackReason}</div>
                                      )}
                                      {q.v2.priceReferences && (
                                        <div className="v2-price-refs">
                                          <div className="v2-price-head">
                                            <span>价格参考</span>
                                            <small>{q.v2.executionReference ? '模型原始锚点，盘中执行以上方实时区间为准' : '信号收盘近似，下个交易时段开盘后需修正'}</small>
                                          </div>
                                          <div className="v2-price-grid">
                                            <span>锚点 <b>{q.v2.priceReferences.anchorPrice ?? '—'}</b></span>
                                            <span>支撑 <b className="red">{q.v2.priceReferences.supportPrice ?? '—'}</b></span>
                                            <span>压力 <b className="green">{q.v2.priceReferences.resistancePrice ?? '—'}</b></span>
                                            <span>参考止盈 <b className="red">{q.v2.priceReferences.indicativeTakeProfitPrice ?? '—'}</b></span>
                                            <span>参考止损 <b className="green">{q.v2.priceReferences.indicativeStopLossPrice ?? '—'}</b></span>
                                          </div>
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      {primaryFc && (
                                        <div className="production-next-forecast">
                                          <div className="fc-grid">
                                            <div className="fc-cell"><span className="fc-k">上涨概率</span><span className={'fc-v ' + (primaryFc.upProb >= 55 ? 'red' : primaryFc.upProb <= 45 ? 'green' : '')}>{primaryFc.upProb}%</span></div>
                                            <div className="fc-cell"><span className="fc-k">预期涨跌</span><span className={'fc-v ' + (primaryFc.expRet >= 0 ? 'red' : 'green')}>{primaryFc.expRet >= 0 ? '+' : ''}{primaryFc.expRet}%</span></div>
                                            <div className="fc-cell"><span className="fc-k">P10-P90 价格区间</span><span className="fc-v"><b className="green">{fmtRaw(primaryFc.targetLow)}</b> ~ <b className="red">{fmtRaw(primaryFc.targetHigh)}</b></span></div>
                                            <div className="fc-cell"><span className="fc-k">价格中枢</span><span className="fc-v">{fmtRaw(primaryFc.targetMid)}</span></div>
                                          </div>
                                          <div className="production-forecast-note">
                                            <Icon name="info" size={12} />
                                            {primaryWindow?.note || '不是当前时点到收盘的剩余时段预测'}；统计区间，不是保证价格
                                          </div>
                                        </div>
                                      )}
                                      {primaryFc && (
                                        <div className="fc-subhead">
                                          <span>未来{fc.days || 5}日预测</span>
                                          <b className={fc.direction === '看涨' ? 'red' : fc.direction === '看跌' ? 'green' : ''}>{fc.direction} · {fc.upProb}%</b>
                                        </div>
                                      )}
                                      <div className="fc-grid">
                                        <div className="fc-cell"><span className="fc-k">上涨概率</span><span className={'fc-v ' + (fc.upProb >= 55 ? 'red' : fc.upProb <= 45 ? 'green' : '')}>{fc.upProb}%</span></div>
                                        <div className="fc-cell"><span className="fc-k">预期涨跌</span><span className={'fc-v ' + (fc.expRet >= 0 ? 'red' : 'green')}>{fc.expRet >= 0 ? '+' : ''}{fc.expRet}%</span></div>
                                        <div className="fc-cell"><span className="fc-k">P10-P90 价格区间</span><span className="fc-v"><b className="green">{fmtRaw(fc.targetLow)}</b> ~ <b className="red">{fmtRaw(fc.targetHigh)}</b></span></div>
                                        <div className="fc-cell"><span className="fc-k">价格中枢</span><span className="fc-v">{fmtRaw(fc.targetMid)}</span></div>
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}
                              {q.highConfSignal && q.highConfSignal.fired && !isMinuteModel && (() => {
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
                                    <span className="hcs-star"><Icon name="starFill" size={14} /></span>
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
                                      <Icon name="info" size={14} /> 这是「高胜率」信号，只说 5 日内摸到止盈的概率高，<b>不代表现在这个价位值得买</b>。当前赔率仅 {rr.toFixed(2)}:1（赢一次赚得少、输一次亏得多），<b>请以下方「军师」结论为准</b>，通常需等回调到更好的价位再出手。
                                    </div>
                                  )}
                                  <div className="hcs-foot">{hcs.label} · 样本外命中率约 {hcs.holdoutPrecision}%（闸门 {hcs.gate}）· 胜率信号，非买卖指令</div>
                                </div>
                                );
                              })()}
                              {q.score != null && (q.reads || []).length > 0 && (
                                <div className="quant-line">
                                  {(q.reads || []).slice(-1).map((r, i) => <span className="quant-line-read" key={i}>{r}</span>)}
                                  <button type="button" className="expand-btn push-end" onClick={() => loadQuant(false)}>刷新</button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      <div className="dq-hint">{adv ? (myHold ? 'AI 操作建议由大模型结合量化预测/技术面/你的持仓成本生成' : 'AI 操作建议由大模型结合量化走势预测/技术面/历史规律/当日盘面生成') : '走势预测=基于历史波动的蒙特卡洛模拟，量化=多因子打分'}；均为统计口径，仅供参考，非投资建议</div>
                    </>
                  )
                })()}
              </div>

              {/* 均线技术参考（精简为可折叠的次要信息）*/}
              {tech && (
                <div className="tech-box">
                  <button type="button" className="tech-fold" aria-expanded={showTech} onClick={() => setShowTech((v) => !v)}>
                    <span><Icon name="pulse" size={13} /> 技术面细节
                      {tech.verdict && <span className={'tech-verdict-inline ' + (tech.vtone || 'muted')}>{tech.verdict}</span>}
                    </span>
                    <Icon name={showTech ? 'chevronDown' : 'chevronRight'} size={14} />
                  </button>
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
                <button type="button" className={'tab' + (mode === 'trend' ? ' active' : '')} aria-pressed={mode === 'trend'} onClick={() => setMode('trend')}>分时</button>
                <button type="button" className={'tab' + (mode === 'kline' ? ' active' : '')} aria-pressed={mode === 'kline'} onClick={() => setMode('kline')}>K线</button>
              </div>
              {mode === 'kline' ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <div className="tabs">
                    <button type="button" className={'tab' + (chartType === 'candle' ? ' active' : '')} aria-pressed={chartType === 'candle'} onClick={() => setChartType('candle')}>蜡烛图</button>
                    <button type="button" className={'tab' + (chartType === 'line' ? ' active' : '')} aria-pressed={chartType === 'line'} onClick={() => setChartType('line')}>折线图</button>
                  </div>
                  <div className="tabs">
                    {[['101', '日K'], ['102', '周K'], ['103', '月K']].map(([v, t]) => (
                      <button type="button" key={v} className={'tab' + (klt === v ? ' active' : '')} aria-pressed={klt === v} onClick={() => setKlt(v)}>{t}</button>
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
                  onChartReady={(chart) => {
                    setTimeout(() => {
                      if (!chart.isDisposed()) chart.resize()
                    }, 60)
                  }}
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
                onChartReady={(chart) => {
                  setTimeout(() => {
                    if (!chart.isDisposed()) chart.resize()
                  }, 60)
                }}
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

        {/* 固定底部动作栏：快速建议 / 深度建议 / 预警 */}
        <div className="detail-footbar">
          <div
            id="advice-mode-guide"
            className={
              'advice-mode-guide'
              + (modeGuidance.firstGeneration ? ' first-generation' : '')
            }
            role="note"
            aria-label="AI 建议使用顺序"
          >
            {modeGuidance.items.map((item) => (
              <div
                key={item.key}
                className={
                  `advice-mode-guide-item ${item.key}`
                  + (
                    modeGuidance.firstGeneration && item.key === 'deep'
                      ? ' recommended'
                      : ''
                  )
                }
              >
                <Icon name={item.icon} size={13} />
                <span>
                  <b>{item.label}</b>
                  <small>{item.purpose}</small>
                </span>
              </div>
            ))}
          </div>
          <button
            className="btn btn-primary footbar-generate footbar-quick"
            type="button"
            disabled={adviceActions.quick.disabled}
            aria-busy={adviceActions.quick.active}
            aria-describedby="advice-mode-guide"
            title="关闭深度思考，直接生成单模型操作建议"
            onClick={() => loadQuant(false)}
          >
            <Icon
              name={adviceActions.quick.icon}
              size={14}
              className={adviceActions.quick.active ? 'spin' : ''}
            />
            <span className="footbar-action-copy">
              <span>{adviceActions.quick.label}</span>
            </span>
          </button>
          <button
            className="btn footbar-generate footbar-deep"
            type="button"
            disabled={adviceActions.deep.disabled}
            aria-busy={adviceActions.deep.active}
            aria-describedby="advice-mode-guide"
            data-recommended={
              modeGuidance.firstGeneration ? 'true' : undefined
            }
            title={modeGuidance.deepTitle}
            onClick={() => loadQuant(true)}
          >
            <span className="footbar-action-main">
              <Icon
                name={adviceActions.deep.icon}
                size={14}
                className={adviceActions.deep.active ? 'spin' : ''}
              />
              <span>{adviceActions.deep.label}</span>
              {modeGuidance.deepBadge && (
                <small className="footbar-mode-badge">
                  {modeGuidance.deepBadge}
                </small>
              )}
            </span>
            <small className="footbar-mode-usecase">
              {modeGuidance.deepUseCase}
            </small>
          </button>
          <button
            className={'btn footbar-alert' + (showAlert ? ' on' : '')}
            aria-describedby="advice-mode-guide"
            onClick={() => setShowAlert((v) => !v)}
          >
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
                    <StockTags code={x.code} variant="inline" />
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
