import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { usePolling } from '../hooks'
import Icon from './Icon'
import { openStockDetail } from '../detailStore'

// ============ 板块资金流向 · Canvas 动画（贝塞尔曲线 + 发光粒子）============
// 左栏=资金流出板块(绿) → 中枢 → 右栏=资金流入板块(红)；连线粗细∝金额，粒子从左向右流。
// 顶部时间轴按"打开时刻所处交易时段"展示：开盘→当前段末，午休灰显、指针跳过。

// ---- 北京时间 & 交易时段 ----
function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000) }
function isWeekday(d) { const g = d.getDay(); return g !== 0 && g !== 6 }
// 一天的关键分钟锚点（相对 0:00）
const T_OPEN = 9 * 60 + 30      // 9:30 开盘
const T_LBRK = 11 * 60 + 30     // 11:30 午间休市
const T_AOPEN = 13 * 60         // 13:00 午盘开盘
const T_CLOSE = 15 * 60         // 15:00 收盘

// 计算时间轴上下文：range=[start,end] 分钟；nowMin=当前指针分钟(午休/盘后会 clamp)；phase 文案
function timelineCtx() {
  const d = nowBJ()
  const hm = d.getHours() * 60 + d.getMinutes()
  const weekday = isWeekday(d)
  // 非交易日 / 盘后 / 晚间 → 展示整个交易日 9:30→15:00 全程回放
  if (!weekday) return { start: T_OPEN, end: T_CLOSE, cursor: T_CLOSE, phase: '休市 · 回放上一交易日全程', live: false }
  if (hm < T_OPEN) return { start: T_OPEN, end: T_OPEN, cursor: T_OPEN, phase: '盘前 · 未开盘', live: false }
  if (hm <= T_LBRK) return { start: T_OPEN, end: T_LBRK, cursor: hm, phase: '早盘交易中', live: true }
  if (hm < T_AOPEN) return { start: T_OPEN, end: T_LBRK, cursor: T_LBRK, phase: '午间休市', live: false }
  if (hm <= T_CLOSE) return { start: T_OPEN, end: T_CLOSE, cursor: hm, phase: '午盘交易中', live: true }
  return { start: T_OPEN, end: T_CLOSE, cursor: T_CLOSE, phase: '已收盘 · 回放全天', live: false }
}
function minToLabel(m) { const h = Math.floor(m / 60); const mm = m % 60; return `${h}:${String(mm).padStart(2, '0')}` }
// 把分钟映射到进度条 0~1（午休段 11:30-13:00 压缩为一个很窄的"休市"区间，不占实际时间比例）
function minToProgress(m, start, end) {
  if (end <= start) return 0
  const clamp = (v) => Math.max(0, Math.min(1, v))
  // 若跨越午休：把 [start,11:30] 与 [13:00,end] 两段真实交易时间线性排布，午休占固定 8% 视觉宽度
  const spansNoon = start < T_LBRK && end > T_AOPEN
  if (!spansNoon) return clamp((m - start) / (end - start))
  const amWidth = T_LBRK - start
  const pmWidth = end - T_AOPEN
  const total = amWidth + pmWidth
  const noonFrac = 0.08
  if (m <= T_LBRK) return clamp((m - start) / total * (1 - noonFrac))
  if (m < T_AOPEN) return (amWidth / total) * (1 - noonFrac) // 午休期间指针停在午休段起点
  return clamp((amWidth / total) * (1 - noonFrac) + noonFrac + ((m - T_AOPEN) / total) * (1 - noonFrac))
}

const yiFmt = (v) => (Math.abs(v) / 1e8).toFixed(2)

export default function FundFlowCanvas({ interval }) {
  // 实时快照(兜底 / snapshot 模式用)
  const { data, loading } = usePolling(`/api/sectors?type=industry&sort=main`, interval, [])
  const liveList = (data && data.list) || []

  // 分时快照序列(A+B 真回放的数据底座)：每次轮询顺带 capture 一份，累积当天时间序列
  const { data: snapData } = usePolling(`/api/sector_snapshots?capture=1`, Math.max(interval || 20000, 20000), [])
  const series = (snapData && snapData.series) || []
  // 至少 2 个真实时点才进入"真回放"，否则诚实走"当前快照"模式
  const replay = series.length >= 2

  const [tl, setTl] = useState(timelineCtx)
  useEffect(() => { const id = setInterval(() => setTl(timelineCtx()), 30000); return () => clearInterval(id) }, [])

  const [playing, setPlaying] = useState(true)
  const [prog, setProg] = useState(0)          // 0~1 沿(真回放:快照序列 / 快照模式:静止)
  const rafRef = useRef(0)
  const lastRef = useRef(0)

  // 把某个快照 items(简版 {c,n,p,m,l,lc}, m=百万) 还原成标准板块数组(mainInflow=元)
  const frameToList = (items) => (items || []).map((s) => ({
    code: s.c, name: s.n, pct: s.p, mainInflow: (s.m || 0) * 1e6, leadName: s.l, leadCode: s.lc,
  }))

  // 真回放：按 prog 在快照序列里定位"当前帧"（取最接近的快照，排名随之真实换位）
  const replayFrame = useMemo(() => {
    if (!replay) return null
    const idx = Math.min(series.length - 1, Math.floor(prog * (series.length - 1) + 1e-6))
    return series[idx]
  }, [replay, series, prog])

  // 当前用于绘制的板块列表：真回放用当前帧，否则用实时快照
  const list = replay && replayFrame ? frameToList(replayFrame.items) : liveList

  // 取两侧 TOP：右=主力净额最强(资金进场)，左=最弱(资金撤离)。普涨/普跌两侧都有内容。
  const { outTop, inTop, totalIn, totalOut, net, maxAmt } = useMemo(() => {
    const sorted = [...list].sort((a, b) => b.mainInflow - a.mainInflow)
    const N = Math.min(8, Math.floor(sorted.length / 2) || sorted.length)
    const inTop = sorted.slice(0, N)
    const outTop = sorted.slice(-N).reverse()
    const totalIn = list.filter((s) => s.mainInflow > 0).reduce((a, s) => a + s.mainInflow, 0)
    const totalOut = list.filter((s) => s.mainInflow < 0).reduce((a, s) => a + s.mainInflow, 0)
    const maxAmt = Math.max(1, ...inTop.map((s) => Math.abs(s.mainInflow)), ...outTop.map((s) => Math.abs(s.mainInflow)))
    return { outTop, inTop, totalIn, totalOut, net: totalIn + totalOut, maxAmt }
  }, [list])
  const hasData = outTop.length > 0 && inTop.length > 0

  // 金额一律显示【真实值】——不再做 20%→100% 的假缩放(方案A:诚实标注，所见即真实)
  const shownAmt = (raw) => raw

  // 播放循环：仅在【真回放】时推进 prog 逐帧回放当天各时点(约 10s 走完一遍再循环)；
  // 快照模式没有时间序列，无需推进(静态展示当前快照，粒子仍流动表现活跃度)。
  useEffect(() => {
    if (!playing || !hasData || !replay) { cancelAnimationFrame(rafRef.current); lastRef.current = 0; return }
    const CYCLE = 10000
    const step = (ts) => {
      if (!lastRef.current) lastRef.current = ts
      const dt = ts - lastRef.current; lastRef.current = ts
      setProg((p) => { let n = p + dt / CYCLE; if (n >= 1) n = 0; return n })
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(rafRef.current); lastRef.current = 0 }
  }, [playing, hasData, replay])

  // 时间轴指针 & 标签：真回放→当前帧的真实时点；快照模式→"当前快照"时点(不回放)
  const cursorMin = replay && replayFrame ? replayFrame.t : tl.cursor
  const cursorLabel = minToLabel(cursorMin)
  // 粒子流速用一个恒定活跃系数(不再依赖假 flowRatio)
  const flowRatio = 0.9

  // ---------- Canvas 绘制：曲线 + 粒子 ----------
  const canvasRef = useRef(null)
  const boxRef = useRef(null)
  const rowsRef = useRef({ out: [], in: [] }) // 记录每行 DOM 的 y 中心，供连线锚点
  const partRef = useRef([])                  // 粒子池
  const drawRafRef = useRef(0)

  // 生成/更新连线配置（左右各若干条汇向中枢）
  const links = useMemo(() => {
    const mk = (arr, side) => arr.map((s, i) => ({
      key: side + s.code, side, name: s.name, amt: Math.abs(s.mainInflow), idx: i,
      w: Math.max(1.2, (Math.abs(s.mainInflow) / maxAmt) * 7), // 线宽∝金额
    }))
    return { out: mk(outTop, 'out'), in: mk(inTop, 'in') }
  }, [outTop, inTop, maxAmt])

  // 初始化粒子：每条线按金额分配粒子数
  useEffect(() => {
    const ps = []
    const push = (lk) => { const n = Math.max(2, Math.round(lk.w * 1.6)); for (let i = 0; i < n; i++) ps.push({ link: lk, t: Math.random(), speed: 0.15 + Math.random() * 0.35 }) }
    links.out.forEach(push); links.in.forEach(push)
    partRef.current = ps
  }, [links])

  const draw = useCallback(() => {
    const cv = canvasRef.current, box = boxRef.current
    if (!cv || !box) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = box.clientWidth, H = box.clientHeight
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px' }
    const ctx = cv.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const hubX = W / 2, hubY = H / 2
    const leftX = W * 0.30, rightX = W * 0.70
    const rows = rowsRef.current

    const GREEN = '#3fb950', RED = '#f4614e'
    // 贝塞尔路径：左行→中枢 / 中枢→右行
    const pathOf = (lk) => {
      const arr = rows[lk.side]; const y = (arr[lk.idx] != null ? arr[lk.idx] : hubY)
      if (lk.side === 'out') return { x0: leftX, y0: y, cx1: leftX + (hubX - leftX) * 0.5, cy1: y, cx2: leftX + (hubX - leftX) * 0.5, cy2: hubY, x1: hubX, y1: hubY }
      return { x0: hubX, y0: hubY, cx1: hubX + (rightX - hubX) * 0.5, cy1: hubY, cx2: hubX + (rightX - hubX) * 0.5, cy2: y, x1: rightX, y1: y }
    }
    const bez = (p, t) => {
      const mt = 1 - t
      const x = mt * mt * mt * p.x0 + 3 * mt * mt * t * p.cx1 + 3 * mt * t * t * p.cx2 + t * t * t * p.x1
      const y = mt * mt * mt * p.y0 + 3 * mt * mt * t * p.cy1 + 3 * mt * t * t * p.cy2 + t * t * t * p.y1
      return { x, y }
    }
    // 画连线（柔和、低透明）
    const drawLink = (lk) => {
      const p = pathOf(lk)
      ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.bezierCurveTo(p.cx1, p.cy1, p.cx2, p.cy2, p.x1, p.y1)
      ctx.strokeStyle = lk.side === 'out' ? 'rgba(63,185,80,.20)' : 'rgba(244,97,78,.20)'
      ctx.lineWidth = lk.w; ctx.stroke()
    }
    links.out.forEach(drawLink); links.in.forEach(drawLink)

    // 中枢光晕
    const g = ctx.createRadialGradient(hubX, hubY, 2, hubX, hubY, 46)
    g.addColorStop(0, 'rgba(124,107,245,.5)'); g.addColorStop(1, 'rgba(124,107,245,0)')
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hubX, hubY, 46, 0, Math.PI * 2); ctx.fill()

    // 粒子：出线 t:0→1 汇入中枢；入线 t:0→1 从中枢流向右
    for (const pt of partRef.current) {
      const lk = pt.link; const p = pathOf(lk)
      pt.t += pt.speed * 0.016 * (0.6 + flowRatio * 0.8)
      if (pt.t > 1) pt.t -= 1
      const pos = bez(p, pt.t)
      const col = lk.side === 'out' ? GREEN : RED
      const r = 1.4 + lk.w * 0.18
      const gg = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r * 3.2)
      gg.addColorStop(0, col); gg.addColorStop(0.4, lk.side === 'out' ? 'rgba(63,185,80,.55)' : 'rgba(244,97,78,.55)'); gg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(pos.x, pos.y, r * 3.2, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2); ctx.fill()
    }
    drawRafRef.current = requestAnimationFrame(draw)
  }, [links, flowRatio])

  useEffect(() => {
    if (!hasData) { cancelAnimationFrame(drawRafRef.current); return }
    drawRafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(drawRafRef.current)
  }, [draw, hasData])

  // 记录每行 y 中心（连线锚点）——布局后测量
  const measure = useCallback(() => {
    const box = boxRef.current; if (!box) return
    const top = box.getBoundingClientRect().top
    const out = [], inn = []
    box.querySelectorAll('.ffc-row.out').forEach((el) => { const r = el.getBoundingClientRect(); out.push(r.top + r.height / 2 - top) })
    box.querySelectorAll('.ffc-row.in').forEach((el) => { const r = el.getBoundingClientRect(); inn.push(r.top + r.height / 2 - top) })
    rowsRef.current = { out, in: inn }
  }, [])
  useEffect(() => { measure(); const on = () => measure(); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on) })

  const today = nowBJ()
  const dateLabel = `${String(today.getMonth() + 1).padStart(2, '0')}月${String(today.getDate()).padStart(2, '0')}日`
  const spansNoon = tl.start < T_LBRK && tl.end > T_AOPEN

  return (
    <div className="panel ffc-panel">
      {/* 顶部标题 + 日期 + 图例 + 行业/概念切换 */}
      <div className="ffc-head">
        <div className="ffc-title-wrap">
          <div className="ffc-sub">板块流速</div>
          <div className="ffc-title">板块资金流向</div>
        </div>
        <div className="ffc-date-wrap">
          <div className="ffc-date">{dateLabel}</div>
          <div className="ffc-session">{tl.phase} · {replay ? `真回放 ${series.length}帧` : '当前快照'}</div>
        </div>
        <div className="ffc-head-right">
          <button className="ffc-play" onClick={() => setPlaying((v) => !v)} disabled={!replay} title={!replay ? '积累到≥2个时点后可回放' : (playing ? '暂停' : '播放')}>
            <Icon name={playing && replay ? 'pause' : 'play'} size={15} />
          </button>
        </div>
      </div>
      <div className="ffc-legend">
        <span className="ffc-lg"><i className="dot out" /> 资金流出（绿）</span>
        <span className="ffc-lg"><i className="dot in" /> 资金流入（红）</span>
        <span className="ffc-lg"><i className="dot exit" /> 市场离场</span>
      </div>

      {/* 时间轴进度条：开盘→当前段末，午休灰显 */}
      <div className="ffc-timeline">
        <div className="ffc-tl-marks">
          <span>{minToLabel(tl.start)}</span>
          {spansNoon && <span className="noon">午休</span>}
          <span>{minToLabel(tl.end)}</span>
        </div>
        <div className="ffc-tl-track">
          {spansNoon && (
            <div className="ffc-tl-noon" style={{ left: (minToProgress(T_LBRK, tl.start, tl.end) * 100) + '%', width: ((minToProgress(T_AOPEN, tl.start, tl.end) - minToProgress(T_LBRK, tl.start, tl.end)) * 100) + '%' }} title="午间休市 11:30–13:00" />
          )}
          <div className="ffc-tl-fill" style={{ width: (minToProgress(cursorMin, tl.start, tl.end) * 100) + '%' }} />
          <div className="ffc-tl-cursor" style={{ left: (minToProgress(cursorMin, tl.start, tl.end) * 100) + '%' }} />
        </div>
        <div className="ffc-tl-now">{cursorLabel}</div>
      </div>

      {loading && !data ? (
        <div className="loading">加载资金流向中…</div>
      ) : !hasData ? (
        <div className="empty">暂无资金流向数据（休市或数据源繁忙时可能为空）</div>
      ) : (
        <div className="ffc-stage" ref={boxRef}>
          <canvas ref={canvasRef} className="ffc-canvas" />
          <div className="ffc-cols">
            {/* 左：流出 */}
            <div className="ffc-col left">
              <div className="ffc-col-head green">资金流出板块（绿色）</div>
              {outTop.map((s) => (
                <div className="ffc-row out" key={s.code} onClick={() => s.leadCode && openStockDetail(s.leadCode, s.leadName)}>
                  <span className="ffc-amt green">{yiFmt(shownAmt(s.mainInflow))}亿</span>
                  <span className="ffc-name">{s.name}</span>
                  <i className="ffc-node green" />
                </div>
              ))}
            </div>
            {/* 右：流入 */}
            <div className="ffc-col right">
              <div className="ffc-col-head red">资金流入方向（红色）</div>
              {inTop.map((s) => (
                <div className="ffc-row in" key={s.code} onClick={() => s.leadCode && openStockDetail(s.leadCode, s.leadName)}>
                  <i className="ffc-node red" />
                  <span className="ffc-name">{s.name}</span>
                  <span className="ffc-amt red">{yiFmt(shownAmt(s.mainInflow))}亿</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 底部汇总 */}
      {hasData && (
        <div className="ffc-summary">
          <span>净流出合计 <b className="green">{(totalOut / 1e8).toFixed(1)}亿</b></span>
          <span>净流入合计 <b className="red">+{(totalIn / 1e8).toFixed(1)}亿</b></span>
          <span>全市场净额 <b className={net >= 0 ? 'red' : 'green'}>{net >= 0 ? '+' : ''}{(net / 1e8).toFixed(1)}亿</b></span>
        </div>
      )}
    </div>
  )
}
