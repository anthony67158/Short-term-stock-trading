import { useState, useMemo, useEffect, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import Icon from './Icon'
import { usePolling } from '../hooks'
import { fmtPct, pctClass, fmtRaw, fmtNum } from '../format'
import { aiStore } from '../aiStore'
import { callAI } from '../ai'
import { usePlanStore, planStore } from '../planStore'
import { generateReview, sessionLabel } from '../review'
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
  const book = usePlanStore()
  // 该股持仓（可能多笔）→ 加权成本，用于给"加/减/做T"建议；未持仓则给"买/观望"
  const myHold = useMemo(() => {
    const hs = (book.holding || []).filter((h) => h.code === (stock && stock.code))
    if (!hs.length) return null
    const qty = hs.reduce((a, h) => a + (h.qty || 0), 0)
    const cost = qty ? hs.reduce((a, h) => a + (h.buyPrice || 0) * (h.qty || 0), 0) / qty : 0
    return { cost: +cost.toFixed(3), qty }
  }, [book.holding, stock && stock.code])
  // 切换股票时重置状态
  useEffect(() => { setQuantState(null); setShowTech(false) }, [stock && stock.code])
  const loadQuant = async () => {
    if (!stock) return
    setQuantState({ loading: true })
    try {
      const hp = myHold ? `&holdCost=${myHold.cost}&holdQty=${myHold.qty}` : ''
      // 量化服务(走势预测/多因子分) 与 LLM 操作建议(带具体价位) 并发
      const quantP = fetch(`/api/stock_detail?code=${stock.code}&klt=101&lmt=60&quant=1${hp}&_t=${Date.now()}`)
        .then((r) => r.json()).catch(() => null)
      // 持仓 → LLM 给"加/减/持有/清仓 + 具体价位"；未持仓 → LLM 给"该不该买/买入时机/买入价 + 止损"
      const adviceP = myHold
        ? callAI('hold_advice', { code: stock.code, name: (profile && profile.name) || stock.name, holdCost: myHold.cost, holdQty: myHold.qty })
            .then((r) => (r && r.ok ? r.result : null)).catch(() => null)
        : callAI('buy_advice', { code: stock.code, name: (profile && profile.name) || stock.name })
            .then((r) => (r && r.ok ? r.result : null)).catch(() => null)
      const [j, advice] = await Promise.all([quantP, adviceP])
      // 未持仓但 LLM 买入建议没返回（超时/冷启动）→ 记一个软提示，允许一键重试，不静默回退到模糊量化结论
      const adviceMissing = !myHold && !advice
      if (j && j.quant) setQuantState({ result: j.quant, advice, adviceMissing })
      else if (advice) setQuantState({ result: null, advice })
      else setQuantState({ error: '量化服务暂不可用（可能冷启动，请稍后重试）' })
    } catch (e) { setQuantState({ error: '获取失败：' + String(e.message || e) }) }
  }
  const [showAlert, setShowAlert] = useState(false) // 设预警表单开关
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
          {/* 公司信息 */}
          {profile && (
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
              {/* ===== AI 操作建议（核心：告诉你该买/加/减/做T + 走势预测）===== */}
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
                    <span className="quant-cta-hint">{myHold ? '结合你的持仓，告诉你该加仓 / 减仓 / 持有做T' : '结合量化预测，告诉你该不该买、何时买'}</span>
                  </div>
                )}
                {quantState && quantState.loading && (
                  <div className="quant-loading"><Icon name="refresh" size={14} className="spin" /> 量化模型计算中…（首次冷启动约需几秒）</div>
                )}
                {quantState && quantState.error && (
                  <div className="quant-err">{quantState.error} <span className="expand-btn" onClick={loadQuant}>重试</span></div>
                )}
                {quantState && !quantState.loading && !quantState.error && (quantState.result || quantState.advice) && (() => {
                  const q = quantState.result || {}
                  const adv = quantState.advice
                  const dec = q.decision || {}
                  const fc = q.forecast
                  // 有 LLM 操作建议(持仓场景)时以它为主结论；否则回退到量化规则决策
                  const verdict = adv
                    ? { tone: adv.tone || 'muted', title: adv.title || adv.action || '—', detail: adv.actionPlan || adv.reason || '' }
                    : { tone: dec.tone || 'muted', title: dec.title || '—', detail: dec.detail || '' }
                  return (
                    <>
                      {/* 决策结论（最大最醒目）*/}
                      <div className={'decide-verdict ' + verdict.tone}>
                        <div className="dv-action">{verdict.title}</div>
                        <div className="dv-detail">{verdict.detail}</div>
                      </div>

                      {/* 未持仓但 AI 买入建议没返回 → 提示重试（避免只给模糊量化结论）*/}
                      {quantState.adviceMissing && !adv && (
                        <div className="advice-retry">
                          <Icon name="spark" size={13} /> AI 买入建议(买点/时机/止损)生成超时，
                          <span className="expand-btn" onClick={loadQuant}>点此重试</span>
                        </div>
                      )}

                      {/* LLM 具体操作价位（持仓=加/减/止损/目标；未持仓=买点/买入区/止损/目标）*/}
                      {adv && (
                        <>
                          {adv.timing && <div className="advice-timing"><Icon name="clock" size={13} /> <b>买入时机</b>：{adv.timing}</div>}
                          <div className="advice-prices">
                            {adv.buyPrice != null && <div className="ap-cell"><span className="ap-k">建议买入价</span><span className="ap-v red">{adv.buyPrice}</span></div>}
                            {adv.buyZone && <div className="ap-cell"><span className="ap-k">买入区间</span><span className="ap-v red">{adv.buyZone}</span></div>}
                            {adv.addPrice != null && <div className="ap-cell"><span className="ap-k">加仓参考</span><span className="ap-v red">{adv.addPrice}</span></div>}
                            {adv.reducePrice != null && <div className="ap-cell"><span className="ap-k">减仓参考</span><span className="ap-v green">{adv.reducePrice}</span></div>}
                            {adv.stopPrice != null && <div className="ap-cell"><span className="ap-k">止损价</span><span className="ap-v green">{adv.stopPrice}</span></div>}
                            {adv.targetPrice != null && <div className="ap-cell"><span className="ap-k">目标价</span><span className="ap-v red">{adv.targetPrice}</span></div>}
                          </div>
                          {adv.pnlNote && <div className="advice-line">💰 {adv.pnlNote}</div>}
                          {adv.reason && <div className="advice-line muted">{adv.reason}</div>}
                          {adv.techNote && <div className="advice-line muted">📈 {adv.techNote}</div>}
                          {adv.quantNote && <div className="advice-line muted">📊 {adv.quantNote}</div>}
                          {adv.risk && <div className="advice-line warn">⚠ {adv.risk}</div>}
                        </>
                      )}

                      {/* 走势预测 */}
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

                      {/* 量化分（一行紧凑）*/}
                      {q.score != null && (
                        <div className="quant-line">
                          <span className={'quant-chip ' + (q.score >= 62 ? 'red' : q.score <= 38 ? 'green' : 'gold')}>量化 {q.score} · {q.bias}</span>
                          {(q.reads || []).slice(-1).map((r, i) => <span className="quant-line-read" key={i}>{r}</span>)}
                          <span className="expand-btn" style={{ marginLeft: 'auto' }} onClick={loadQuant}>刷新</span>
                        </div>
                      )}
                      <div className="dq-hint">{adv ? (myHold ? 'AI 操作建议由大模型结合量化预测/技术面/你的持仓成本生成' : 'AI 买入建议由大模型结合量化走势预测与技术面生成') : '走势预测=基于历史波动的蒙特卡洛模拟，量化=多因子打分'}；均为统计口径，仅供参考，非投资建议</div>
                    </>
                  )
                })()}
              </div>

              {/* ===== 复盘结论（持仓股午间/收盘自动生成并保留最新一条；未持仓可手动生成）===== */}
              <ReviewCard stock={stock} name={(profile && profile.name) || stock.name} myHold={myHold} overview={overview} />

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
                <div style={{ display: 'flex', gap: 8 }}>
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

          {/* 在统一 AI 助手中分析该股：预填到输入框，用户编辑后自行发送 */}
          <div style={{ padding: '12px 4px 4px', textAlign: 'center' }}>
            <button
              className="btn btn-primary"
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
              <Icon name="spark" size={14} /> 在 AI 助手中分析 / 提问这只票
            </button>
            <div className="sub-name" style={{ marginTop: 6, fontSize: 11 }}>会把股票信息和建议问题填入助手输入框，你可编辑后再发送</div>
            <div style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => setShowAlert((v) => !v)}>
                <Icon name="bell" size={13} /> {showAlert ? '收起预警设置' : '设置盯盘预警'}
              </button>
            </div>
            {showAlert && (
              <div style={{ marginTop: 8, textAlign: 'left', maxWidth: 420, marginLeft: 'auto', marginRight: 'auto' }}>
                <AlertForm stock={{ code: stock.code, name: (profile && profile.name) || stock.name }} onDone={() => setShowAlert(false)} />
                <div className="sub-name" style={{ fontSize: 11, marginTop: 4 }}>命中后会通过预警中心（顶部铃铛）+ 浏览器通知提醒你</div>
              </div>
            )}
          </div>

          <div className="ai-disclaimer" style={{ padding: '10px 4px 0' }}>
            数据来源：东方财富公开接口 · 仅供研究参考，非投资建议
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- 复盘结论卡：持仓股午间/收盘自动生成(每只只留最新一条)；未持仓可手动生成 ----------
function ReviewCard({ stock, name, myHold, overview }) {
  const book = usePlanStore()
  const review = (book.reviews || {})[stock.code] || null
  const [gen, setGen] = useState(null) // {loading}|{error}
  const run = async () => {
    setGen({ loading: true })
    let hold = null
    if (myHold && overview) {
      const pnlPct = myHold.cost ? +(((overview.price - myHold.cost) / myHold.cost) * 100).toFixed(2) : null
      hold = { cost: myHold.cost, qty: myHold.qty, pnlPct }
    }
    const r = await generateReview({ code: stock.code, name, session: 'manual', hold })
    if (r && r.error) setGen({ error: r.error })
    else setGen(null)
  }
  const r = review && review.result
  const tone = r ? (r.tone || 'muted') : 'muted'
  const ts = review ? new Date(review.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
  return (
    <div className="review-card">
      <div className="review-head">
        <div className="review-title"><Icon name="history" size={14} /> 复盘结论
          {review && <span className={'review-sess ' + review.session}>{sessionLabel(review.session)}</span>}
          {ts && <span className="review-time">{ts}</span>}
        </div>
        <button className="quant-btn sm" onClick={run} disabled={gen && gen.loading}>
          <Icon name={gen && gen.loading ? 'refresh' : 'spark'} size={13} className={gen && gen.loading ? 'spin' : ''} />
          {gen && gen.loading ? '复盘中' : (review ? '重新复盘' : '生成复盘')}
        </button>
      </div>
      {gen && gen.error && <div className="quant-err">{gen.error} <span className="expand-btn" onClick={run}>重试</span></div>}
      {!review && !(gen && gen.loading) && !(gen && gen.error) && (
        <div className="review-empty">
          {myHold
            ? '持仓股会在午间休市、收盘时各自动生成一条复盘(指导下午 / 次日操作)，这里只保留最新一条；也可点右上「生成复盘」立即生成。'
            : '未持仓股不自动复盘。点右上「生成复盘」让 AI 复盘该股当前状态并给出后续操作建议。'}
        </div>
      )}
      {r && (
        <>
          <div className={'review-verdict ' + tone}>
            <span className={'review-stance ' + tone}>{r.stance || '—'}</span>
            <span className="review-headline">{r.headline || ''}</span>
          </div>
          {r.nextAction && <div className="review-next"><Icon name="target" size={13} /><span className="rn-k">{review.session === 'noon' ? '下午' : review.session === 'close' ? '明天开盘' : '后续'}怎么做</span>{r.nextAction}</div>}
          <div className="review-rows">
            {r.todayRecap && <div className="review-row"><span className="rr-k">今日回顾</span>{r.todayRecap}</div>}
            {r.pnlNote && r.pnlNote !== '未持仓，跳过' && <div className="review-row"><span className="rr-k">盈亏</span>{r.pnlNote}</div>}
            {r.tradeReview && r.tradeReview !== '今日无成交' && <div className="review-row"><span className="rr-k">操作点评</span>{r.tradeReview}</div>}
            {(r.addPrice != null || r.reducePrice != null || r.stopPrice != null) && (
              <div className="review-prices">
                {r.addPrice != null && <span className="rp-cell"><span className="rp-k">回踩加仓</span><b className="red">{r.addPrice}</b></span>}
                {r.reducePrice != null && <span className="rp-cell"><span className="rp-k">反弹减仓</span><b className="green">{r.reducePrice}</b></span>}
                {r.stopPrice != null && <span className="rp-cell"><span className="rp-k">止损</span><b className="green">{r.stopPrice}</b></span>}
              </div>
            )}
            {r.keyLevel && <div className="review-row"><span className="rr-k">盯住</span>{r.keyLevel}</div>}
            {r.quantNote && <div className="review-row"><span className="rr-k quant">量化</span>{r.quantNote}</div>}
            {r.risk && <div className="review-row"><span className="rr-k risk">风险</span>{r.risk}</div>}
          </div>
        </>
      )}
    </div>
  )
}

