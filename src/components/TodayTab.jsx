import { useState, useMemo, useEffect, useRef } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import LimitPool from './LimitPool'
import { usePolling, isTradingHours } from '../hooks'
import { callAI } from '../ai'
import { api } from '../apiBase'
import { planStore, usePlanStore } from '../planStore'
import { aiStore } from '../aiStore'
import DailyReport from './DailyReport'
import { fmtPct, pctClass, fmtInflow, fmtNum , fmtRaw } from '../format'
import { rerankQuantCandidates } from '../../shared/stockRanking.js'

// ============ 今日选股 Tab：今天买什么 ============
export default function TodayTab({ interval, market, sectors, snapshot }) {
  const zt = usePolling('/api/board?type=limitup&kind=zt', interval)
  const zb = usePolling('/api/board?type=limitup&kind=zb', interval)
  const movers = usePolling('/api/board?type=movers&kind=inflow', interval)
  const speed = usePolling('/api/board?type=movers&kind=speed', interval)

  return (
    <div className="today">
      <MarketLight market={market} sectors={sectors} snapshot={snapshot} />
      <SentimentGauge zt={zt.data} zb={zb.data} market={market} />
      <DailyPlay snapshot={snapshot} />
      <CandidatePool zt={zt.data} movers={movers.data} speed={speed.data} sectors={sectors} />
      <LimitPool interval={interval} />
    </div>
  )
}

// ---------- 市场情绪温度计（用涨停/炸板池本地计算，不占接口）----------
function SentimentGauge({ zt, zb, market }) {
  const g = useMemo(() => {
    const ztList = (zt && zt.list) || []
    const zbList = (zb && zb.list) || []
    const ztCount = ztList.length
    const zbCount = zbList.length
    // 炸板率 = 炸板数 /(涨停数+炸板数)
    const breakRate = (ztCount + zbCount) ? Math.round(zbCount / (ztCount + zbCount) * 100) : null
    // 连板梯队：按 lbc(连板数) 分布
    const tiers = {}
    let maxBoard = 0
    ztList.forEach((s) => {
      const lb = s.lbc || 1
      if (lb > maxBoard) maxBoard = lb
      const key = lb >= 2 ? lb : 1
      tiers[key] = (tiers[key] || 0) + 1
    })
    const lianban = ztCount - (tiers[1] || 0) // 连板数(>=2板)
    const b = (market && market.breadth) || {}
    // 情绪温度分：涨停多、炸板率低、连板高 → 高分
    let score = 50
    if (ztCount >= 60) score += 15; else if (ztCount >= 30) score += 8; else if (ztCount < 15) score -= 12
    if (breakRate != null) { if (breakRate <= 15) score += 12; else if (breakRate >= 35) score -= 15 }
    if (maxBoard >= 5) score += 10; else if (maxBoard >= 3) score += 5
    if (b.limitDown > 10) score -= 10
    score = Math.max(0, Math.min(100, score))
    const level = score >= 70 ? { t: '情绪火热', c: 'red' } : score >= 55 ? { t: '情绪偏暖', c: 'gold' } : score >= 40 ? { t: '情绪中性', c: 'muted' } : { t: '情绪偏冷', c: 'green' }
    return { ztCount, zbCount, breakRate, maxBoard, lianban, score, level, b }
  }, [zt, zb, market])

  if (!zt) return null
  return (
    <div className="panel senti-gauge">
      <div className="sg-head">
        <div className="panel-title"><Icon name="fire" size={16} /> 市场情绪温度计</div>
        <span className={'sg-level ' + g.level.c}>{g.level.t} · {g.score}分</span>
      </div>
      <div className="sg-bar"><span className={'sg-bar-fill ' + g.level.c} style={{ width: g.score + '%' }} /></div>
      <div className="sg-cells">
        <div className="sg-cell"><span className="sg-k">涨停</span><span className="sg-v red">{g.ztCount}</span></div>
        <div className="sg-cell"><span className="sg-k">炸板</span><span className="sg-v">{g.zbCount}</span></div>
        <div className="sg-cell"><span className="sg-k">炸板率</span><span className={'sg-v ' + (g.breakRate != null && g.breakRate >= 35 ? 'green' : g.breakRate != null && g.breakRate <= 15 ? 'red' : '')}>{g.breakRate != null ? g.breakRate + '%' : '--'}</span></div>
        <div className="sg-cell"><span className="sg-k">最高板</span><span className="sg-v gold">{g.maxBoard || '--'}板</span></div>
        <div className="sg-cell"><span className="sg-k">连板数</span><span className="sg-v">{g.lianban}</span></div>
        <div className="sg-cell"><span className="sg-k">跌停</span><span className="sg-v green">{g.b.limitDown || 0}</span></div>
      </div>
      <div className="legend" style={{ padding: '6px 2px 0' }}>
        炸板率低+连板高=接力意愿强、赚钱效应好；炸板率高+跌停多=情绪退潮，谨慎追高。综合评分仅供参考。
      </div>
    </div>
  )
}

// ---------- 大盘盘面（指数全景 + 情绪红绿灯 + 今日操作建议）----------
function MarketLight({ market, sectors, snapshot }) {
  const b = (market && market.breadth) || {}
  const idx = (market && market.indices) || []
  const ratio = b.down ? b.up / b.down : (b.up ? 9 : 1)
  // 简单情绪判定
  let light = 'yellow', text = '多空胶着，轻仓试探'
  const zt = b.limitUp || 0, dt = b.limitDown || 0
  if (ratio >= 1.5 && zt > dt * 3) { light = 'green'; text = '情绪偏暖，可积极参与' }
  else if (ratio < 0.7 || dt > zt) { light = 'red'; text = '情绪转弱，控制仓位' }
  const topSector = (sectors && sectors.list && sectors.list[0]) || null

  // AI 动态盘前建议：结合指数/板块/涨停梯队/异动，不只看红绿灯
  const [advice, setAdvice] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [reportOpen, setReportOpen] = useState(false) // 策略日报抽屉

  const runAdvice = async () => {
    setLoading(true); setErr(null)
    try {
      const s = snapshot()
      const payload = {
        breadth: s.market?.breadth || {},
        indices: (s.market?.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
        topSectors: (s.sectors?.list || []).slice(0, 8).map((x) => ({ name: x.name, pct: x.pct, mainInflowYi: +(x.mainInflow / 1e8).toFixed(2), lead: x.leadName })),
        limitUp: (s.limitPool?.list || []).slice(0, 8).map((x) => ({ name: x.name, code: x.code, lbc: x.lbc, sector: x.sector })),
        movers: (s.movers?.list || []).slice(0, 8).map((x) => ({ name: x.name, code: x.code, pct: x.pct, mainInflowYi: +(x.mainInflow / 1e8).toFixed(2) })),
      }
      const r = await callAI('daily', payload)
      if (r.ok) setAdvice(r.result)
      else setErr(r.error || 'AI 调用失败')
    } catch (e) { setErr(String(e.message || e)) }
    finally { setLoading(false) }
  }

  return (
    <div className="panel market-board">
      <div className="panel-head">
        <div className="panel-title"><Icon name="pulse" size={16} /> 大盘盘面 <span className="sub-name">开盘先看势，定今日仓位</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => setReportOpen(true)}>
            <Icon name="clipboard" size={13} />
            策略日报
          </button>
          <div className={'mb-light ' + light}><span className="orb-dot" />{light === 'green' ? '可以做' : light === 'red' ? '谨慎/空仓' : '轻仓试探'} · {text}</div>
        </div>
      </div>
      {reportOpen && <DailyReport onClose={() => setReportOpen(false)} />}

      {/* 今日操作建议：AI 动态建议优先；没有时再退回规则版建议 */}
      {(() => {
        const fallback = light === 'green'
          ? { icon: 'target', title: '今日可积极做短线', sub: '顺势选强势主线龙头开新仓；持仓正常做T滚成本', tone: 'green' }
          : light === 'red'
          ? { icon: 'shield', title: '今日不宜开新仓', sub: '暂停短线建仓，空仓观望；仅在已有持仓上谨慎做T降成本', tone: 'red' }
          : { icon: 'gauge', title: '今日轻仓 + 以做T为主', sub: '短线只试仓最强龙头、控制仓位；重点在持仓上高抛低吸做T', tone: 'yellow' }
        const plan = advice
          ? {
              icon: advice.light === 'green' ? 'target' : advice.light === 'red' ? 'shield' : 'gauge',
              title: advice.verdict || advice.canTrade || fallback.title,
              sub: `主攻 ${advice.direction || '--'}${advice.position ? ' · 仓位 ' + advice.position : ''}${advice.risk ? ' · 风险 ' + advice.risk : ''}`,
              tone: advice.light || fallback.tone,
            }
          : fallback
        return (
          <div className={'mb-plan ' + plan.tone}>
            <span className="mb-plan-icon"><Icon name={plan.icon} size={18} /></span>
            <div className="mb-plan-txt">
              <div className="mb-plan-title">{plan.title}</div>
              <div className="mb-plan-sub">{plan.sub}</div>
              {err && <div className="err" style={{ marginTop: 3 }}>{err}</div>}
            </div>
          </div>
        )
      })()}

      <div className="mb-body">
        {/* 指数全景：上证/深证/创业板/北证 */}
        <div className="mb-indices">
          {idx.map((i) => (
            <div className="mb-idx" key={i.code}>
              <div className="mb-idx-name">{i.name}</div>
              <div className={'mb-idx-price ' + pctClass(i.pct)}>{i.price ? fmtRaw(i.price) : '--'}</div>
              <div className={'mb-idx-pct ' + pctClass(i.pct)}>{fmtPct(i.pct)}</div>
            </div>
          ))}
        </div>
        {/* 情绪指标 */}
        <div className="mb-stats">
          <div className="mb-stat">
            <div className="mb-stat-label">涨/跌停</div>
            <div className="mb-stat-val"><span className="red">{zt}</span><span className="sep">/</span><span className="green">{dt}</span></div>
          </div>
          <div className="mb-stat">
            <div className="mb-stat-label">涨/跌家数</div>
            <div className="mb-stat-val"><span className="red">{b.up || 0}</span><span className="sep">/</span><span className="green">{b.down || 0}</span></div>
          </div>
          <div className="mb-stat">
            <div className="mb-stat-label">涨跌比</div>
            <div className={'mb-stat-val ' + (ratio >= 1 ? 'red' : 'green')}>{ratio.toFixed(2)}</div>
          </div>
          {topSector && (
            <div className="mb-stat">
              <div className="mb-stat-label">最强板块</div>
              <div className="mb-stat-val gold" style={{ fontSize: 14 }}>{topSector.name}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- AI 选股（量化模型 + LLM 结合，精选今日3只 + 怎么买）----------
// 交易时段=「AI 选股」，结果本地持久化(刷新不丢);收盘后按钮=「看明日计划」，展示当日盘中选出的、供次日开盘参考
const PICK_KEY = 'ai_pick_v1'
function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000) }
// 当日交易场次:9:15–15:01(含午间 11:30–13:00 休市)整体算“盘中/当日”，午休不切到“明日计划”，只有收盘后(15:01 之后)/盘前/周末才算收盘
function isTradingNow() { const d = nowBJ(); if (d.getDay() === 0 || d.getDay() === 6) return false; const hm = d.getHours() * 60 + d.getMinutes(); return hm >= 555 && hm <= 901 } // 9:15-15:01(含午休)
function todayKey() { const d = nowBJ(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
// AI 每日精选结果 & 自动开关：随账号跨设备同步(planStore.settings)，localStorage 仅作离线镜像。
// 读:云端优先→本地兜底；写:双写(云端触发防抖回存 + 本地即时镜像)。这样手机选出的名单/开关，电脑登录也能看到。
function loadPick() {
  try {
    const cloud = planStore.getSetting && planStore.getSetting(PICK_KEY, undefined)
    if (cloud !== undefined && cloud !== null) return cloud
  } catch { /* ignore */ }
  try { return JSON.parse(localStorage.getItem(PICK_KEY) || 'null') } catch { return null }
}
function savePick(obj) {
  try { planStore.setSetting && planStore.setSetting(PICK_KEY, obj) } catch { /* ignore */ }
  try { localStorage.setItem(PICK_KEY, JSON.stringify(obj)) } catch { /* ignore */ }
}
const AUTO_KEY = 'ai_pick_auto_v1'
const AUTO_MIN = 20 // 自动刷新间隔(分钟)
function loadAuto() {
  try {
    const cloud = planStore.getSetting && planStore.getSetting(AUTO_KEY, undefined)
    if (cloud !== undefined && cloud !== null) return !!cloud
  } catch { /* ignore */ }
  try { return localStorage.getItem(AUTO_KEY) === '1' } catch { return false }
}
function saveAuto(v) {
  try { planStore.setSetting && planStore.setSetting(AUTO_KEY, !!v) } catch { /* ignore */ }
  try { localStorage.setItem(AUTO_KEY, v ? '1' : '0') } catch { /* ignore */ }
}

async function fetchJsonWithTimeout(url, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return output
}

function DailyPlay({ snapshot }) {
  const [loading, setLoading] = useState(false)
  const [stage, setStage] = useState('') // 进度文案
  const saved = loadPick()
  const [res, setRes] = useState(saved && saved.result ? saved.result : null)
  const [savedAt, setSavedAt] = useState(saved && saved.at ? saved.at : null)
  const [savedDay, setSavedDay] = useState(saved && saved.day ? saved.day : null)
  const [funnel, setFunnel] = useState(saved && saved.funnel ? saved.funnel : null)
  const [err, setErr] = useState(null)
  const [auto, setAuto] = useState(loadAuto())
  const book = usePlanStore()
  const trading = isTradingNow()

  // 登录/切换账号后云端设置到达 → 回灌 AI 精选结果与自动开关(以云端更新时间较新者为准)。
  // 依赖 book(planStore 快照):setData 灌入 settings 时会触发一次重渲染，从而拉到跨设备同步的名单。
  useEffect(() => {
    const p = loadPick()
    if (p && p.at && p.at !== savedAt) {
      setRes(p.result || null); setSavedAt(p.at || null); setSavedDay(p.day || null); setFunnel(p.funnel || null)
    } else if (!p && savedAt) {
      // 云端被清空(登出/切换到空账号) → 清掉本地展示
      setRes(null); setSavedAt(null); setSavedDay(null); setFunnel(null)
    }
    const a = loadAuto()
    if (a !== auto) setAuto(a)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book])

  const run = async (silent = false) => {
    setLoading(true); setErr(null); if (!silent) setRes(null)
    try {
      const s = snapshot()
      // ① 全市场确定性初筛；失败时仍可回退原热点池。
      setStage('正在扫描全市场可交易股票…')
      let broad = { universeCount: null, eligibleCount: null, list: [] }
      try {
        const json = await fetchJsonWithTimeout(api(`/api/screen?limit=30&_t=${Date.now()}`), 30000)
        if (json && json.ok) broad = json
      } catch { /* 回退热点池 */ }

      // ② 多来源合并：全市场排序 + 涨停/连板 + 主力抢筹 + 涨速 + 板块龙头。
      const cand = new Map()
      const add = (x, tag, extra) => {
        if (!x || !x.code) return
        if (!cand.has(x.code)) cand.set(x.code, { code: x.code, name: x.name, tags: [], ...extra })
        const o = cand.get(x.code)
        Object.entries(extra || {}).forEach(([k, v]) => { if (o[k] == null && v != null) o[k] = v }) // 补齐缺失字段
        if (tag && !o.tags.includes(tag)) o.tags.push(tag)
      }
      ;(broad.list || []).forEach((x) => add(x, `全市场${x.marketScore}分`, {
        price: x.price, pct: x.pct, speed: x.speed,
        turnover: x.turnover, volRatio: x.volRatio,
        mainInflow: x.mainInflow, amount: x.amount,
        marketScore: x.marketScore, marketReasons: x.reasons,
      }))
      ;(s.limitPool?.list || []).slice(0, 10).forEach((x) => add(x, x.lbc >= 2 ? `${x.lbc}连板` : '涨停', { pct: x.pct, turnover: x.turnover, mainInflow: x.fundAmount }))
      ;(s.movers?.list || []).slice(0, 10).forEach((x) => add(x, '主力抢筹', { pct: x.pct, turnover: x.turnover, volRatio: x.volRatio, mainInflow: x.mainInflow }))
      ;(s.speed?.list || []).slice(0, 8).forEach((x) => add(x, '涨速', { pct: x.pct, speed: x.speed }))
      // 强势板块的领涨龙头：拓宽题材面，纳入非涨停但当日领涨主线的核心票
      ;(s.sectors?.list || []).slice(0, 6).forEach((sec) => {
        if (sec && sec.leadCode) add({ code: sec.leadCode, name: sec.leadName }, `${sec.name}领涨`, { pct: sec.leadPct })
      })
      const codes = [...cand.values()]
        .sort((a, b) => (b.marketScore || 0) - (a.marketScore || 0) || b.tags.length - a.tags.length)
        .slice(0, 20)
      if (!codes.length) { setErr('暂无候选数据，开盘后再试（休市时段候选池为空）'); setLoading(false); return }

      // ③ 最多 5 路并发量化，避免 20 只同时冲击 FC/量化冷启动。
      setStage(`量化模型正在给 ${codes.length} 只候选打分…`)
      const scored = await mapWithConcurrency(codes, 5, async (c) => {
        try {
          const j = await fetchJsonWithTimeout(api(`/api/stock_detail?code=${c.code}&klt=101&lmt=60&quant=1&_t=${Date.now()}`), 25000)
          const q = j.quant, fc = q && q.forecast
          return {
            code: c.code, name: c.name, tags: c.tags,
            marketScore: c.marketScore, marketReasons: c.marketReasons,
            price: c.price, pct: c.pct, turnover: c.turnover, volRatio: c.volRatio,
            mainInflowYi: c.mainInflow != null ? +(c.mainInflow / 1e8).toFixed(2) : null,
            quant: q ? {
              score: q.score, bias: q.bias,
              upProb: fc && fc.upProb, expRet: fc && fc.expRet,
              targetLow: fc && fc.targetLow, targetHigh: fc && fc.targetHigh,
              highConfFired: !!(q.highConfSignal && q.highConfSignal.fired),
              credibility: q.highConfSignal && q.highConfSignal.credibility,
              buyPrice: q.highConfSignal && q.highConfSignal.buyPrice,
              takeProfit: q.highConfSignal && q.highConfSignal.takeProfit,
              stopLoss: q.highConfSignal && q.highConfSignal.stopLoss,
            } : null,
          }
        } catch { return { code: c.code, name: c.name, tags: c.tags, quant: null } }
      })
      const withQuant = scored.filter((x) => x.quant) // 优先把打上分的交给 LLM
      // 量化服务全挂时不再交白卷:退化为"仅盘面信号"名单,让 AI 基于资金/题材/涨速排序,并如实说明量化缺失
      const forLLM = rerankQuantCandidates(withQuant.length ? withQuant : scored, { limit: 12 })
      const quantMissing = withQuant.length === 0
      const funnelMeta = {
        universeCount: broad.universeCount,
        scannedCount: broad.scannedCount,
        isComplete: broad.isComplete,
        eligibleCount: broad.eligibleCount,
        quantCount: withQuant.length,
        shortlistCount: forLLM.length,
      }

      // ③ 带量化分 + 盘面 → LLM 精选 3 只
      setStage('AI 正在结合量化与盘面精选 3 只…')
      const payload = {
        market: {
          breadth: s.market?.breadth || {},
          indices: (s.market?.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
        },
        sectors: (s.sectors?.list || []).slice(0, 8).map((x) => ({ name: x.name, pct: x.pct, mainInflowYi: +(x.mainInflow / 1e8).toFixed(2), lead: x.leadName })),
        candidates: forLLM,
        quantMissing,
        funnel: funnelMeta,
      }
      const r = await callAI('scan_pick', payload)
      if (r.ok) {
        const at = Date.now(), day = todayKey()
        setRes(r.result); setSavedAt(at); setSavedDay(day); setFunnel(funnelMeta)
        savePick({ result: r.result, at, day, funnel: funnelMeta })
      } else setErr(r.error || 'AI 选股失败')
    } catch (e) { setErr(String(e.message || e)) }
    finally { setLoading(false); setStage('') }
  }

  // 定时自动刷新:开启后每 AUTO_MIN 分钟在交易时段内静默重选一次(结果保留、不清屏),下班/周末自动停。
  // 【修复】原实现用 setInterval(20分) 固定倒计时——但本 Tab 是条件挂载(切走即卸载、切回即重挂),
  //   每次重挂都会清掉旧 interval、重新从 0 计时,导致除非停在本页 20 分钟不动否则永远不触发="没启动"。
  //   改为:以上次选股时间 savedAt 为锚,用 60 秒轻量轮询判断"是否已过间隔",并在挂载/切回时立即补检一次。
  //   这样跨切页/重挂天然存活,开启后若已超过间隔会立刻补刷,不再"看着不动"。
  const runRef = useRef(run); runRef.current = run
  const loadingRef = useRef(loading); loadingRef.current = loading
  const savedAtRef = useRef(savedAt); savedAtRef.current = savedAt
  const lastAttemptRef = useRef(0) // 上次"尝试"时间(不论成败),失败时 savedAt 不变,用它防止每60秒狂刷
  useEffect(() => {
    if (!auto) return
    const tick = () => {
      if (!isTradingNow() || loadingRef.current) return
      const last = Math.max(savedAtRef.current || 0, lastAttemptRef.current || 0)
      if (Date.now() - last >= AUTO_MIN * 60000) { lastAttemptRef.current = Date.now(); runRef.current(true) } // 距上次选股/尝试已满间隔→静默补刷
    }
    tick() // 挂载/开启/切回本页时立即检查一次:超时则马上刷新,不必再干等一个完整间隔
    const id = setInterval(tick, 60000) // 每分钟检查(轻量),真正是否刷新由"距上次时间"决定,跨重挂存活
    return () => clearInterval(id)
  }, [auto])

  // 开关:开启即写入设置;是否立即刷新交给上面的 effect 首检(超时才刷、结果新则等到点),避免重复触发
  const toggleAuto = () => { const v = !auto; setAuto(v); saveAuto(v) }

  // 每分钟自增一个计数,驱动"下次自动刷新倒计时"文案重渲染,让用户直观看到自动刷新确实在待命/运行
  const [, forceMin] = useState(0)
  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => forceMin((n) => n + 1), 60000)
    return () => clearInterval(id)
  }, [auto])
  // 距下次自动刷新的剩余分钟(仅交易时段有意义):基于上次选股时间 savedAt 推算
  const nextRefreshMin = (() => {
    if (!auto || !trading) return null
    const elapsed = Date.now() - (savedAt || 0)
    const remain = Math.ceil((AUTO_MIN * 60000 - elapsed) / 60000)
    return remain > 0 ? remain : 0
  })()

  const savedTimeStr = savedAt ? new Date(savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
  const isToday = savedDay === todayKey()

  return (
    <div className="play-card">
      <div className="play-head">
        <div className="play-title">
          <Icon name="radar" size={18} />
          <span>{trading ? 'AI 选股' : '明日计划入选'}</span>
          <span className="play-sub">{trading ? '全市场过滤 + 量化复排 + AI 决策，没优势时明确不出手' : '盘中决策结果，供下一交易日开盘参考'}</span>
        </div>
        <div className="play-actions">
          <button className={'play-auto' + (auto ? ' on' : '')} onClick={toggleAuto} title={`开启后每 ${AUTO_MIN} 分钟在交易时段自动重选一次并保留结果，休市自动停`}>
            <Icon name={auto ? 'refresh' : 'clock'} size={13} className={auto && loading ? 'spin' : ''} />
            {auto
              ? (trading
                  ? (loading ? '刷新中…' : nextRefreshMin > 0 ? `自动刷新·${nextRefreshMin}分后` : '自动刷新·即将')
                  : `自动刷新·休市待命`)
              : '定时刷新'}
          </button>
          <button className="btn btn-primary" onClick={() => run(false)} disabled={loading || !trading} title={!trading ? '仅交易时段(9:15–15:00)可重新选股;当前展示的是最近一次盘中结果' : ''}>
            <Icon name={loading ? 'refresh' : 'spark'} size={15} className={loading ? 'spin' : ''} />
            {loading ? '选股中' : (trading ? (res ? '重新选股' : 'AI 选股') : '休市·看盘中结果')}
          </button>
        </div>
      </div>

      <div className="play-body">
        {err && <div className="err">{err}</div>}
        {!res && !err && !loading && (
          <div className="play-hint">{trading
            ? '扫描全市场并过滤不可交易标的，再经量化复排与 AI 把握/赔率闸门，输出 1~3 只可行动标的；没有优势机会时会明确提示「今日不出手」。'
            : '当前为休市时段，暂无盘中选股结果。开盘后(9:15起)点「AI 选股」，收盘后这里会保留结果供次日参考。'}</div>
        )}
        {loading && <div className="play-hint"><Icon name="refresh" size={13} className="spin" /> {stage || '正在选股…'}</div>}
        {res && (
          <>
            {savedTimeStr && (
              <div className="pick-savedat">
                <Icon name="history" size={12} />
                {isToday ? (trading ? `本次选股 ${savedTimeStr}，结果已保留` : `今日盘中 ${savedTimeStr} 选出，供明天开盘参考`) : `${savedTimeStr} 选出(非今日，仅供参考)`}
              </div>
            )}
            {funnel && funnel.universeCount != null && (
              <div className="pick-savedat">
                全市场 {funnel.universeCount} 只{funnel.isComplete === false ? `（本轮扫描 ${funnel.scannedCount} 只）` : ''} → 可交易 {funnel.eligibleCount} 只 → 量化成功 {funnel.quantCount} 只 → 决策短名单 {funnel.shortlistCount} 只
              </div>
            )}
            {res.marketNote && <div className="pick-market"><Icon name="pulse" size={13} /> <span className="pick-market-note">{res.marketNote}</span>{res.confidence && <span className={'pick-conf ' + (/高/.test(res.confidence) ? 'hi' : /低/.test(res.confidence) ? 'lo' : 'mid')}>把握度 {res.confidence}</span>}</div>}
            {(res.noTrade || !Array.isArray(res.picks) || res.picks.length === 0) && (
              <div className="play-risk"><Icon name="shield" size={14} /><span><b>今日不出手</b> · {res.noTradeReason || '当前候选没有同时通过把握与赔率要求，保留现金等待更清晰机会。'}</span></div>
            )}
            {Array.isArray(res.picks) && res.picks.length > 0 && (
              <div className="pick-list">
                {res.picks.map((c, i) => {
                  const added = book.plan.some((x) => x.code === c.code)
                  const gcls = c.grade === '强' ? 'strong' : c.grade === '弱' ? 'weak' : 'mid'
                  return (
                    <div className="pick-card" key={c.code || i}>
                      <div className="pick-top">
                        <span className="pick-rank">{c.rank || i + 1}</span>
                        <div className="pick-name">
                          <StockName code={c.code} name={c.name}><span>{c.name}<span className="cand-code">{c.code}</span></span></StockName>
                        </div>
                        {c.grade && <span className={'pick-grade ' + gcls}>{c.grade}</span>}
                        {c.quantScore != null && <span className={'pick-score ' + (c.quantScore >= 60 ? 'red' : c.quantScore <= 40 ? 'green' : 'gold')}>量化 {c.quantScore}</span>}
                        <button className={'chip-btn' + (added ? ' done' : '')} disabled={added} style={{ marginLeft: 'auto' }}
                          onClick={() => planStore.addPlan({ code: c.code, name: c.name }, c.reason)}>
                          <Icon name={added ? 'check' : 'plus'} size={13} />{added ? '已加入' : '加自选'}
                        </button>
                      </div>
                      <div className="pick-reason">{c.reason}</div>
                      <div className="pick-rows">
                        {c.buyPoint && <div className="pick-row"><span className="pick-k buy">买点</span>{c.buyPoint}</div>}
                        {c.buyZone && <div className="pick-row"><span className="pick-k">买入区</span><b className="red">{c.buyZone}</b></div>}
                        <div className="pick-foot">
                          {c.target && <span className="cand-expect">目标 {c.target}</span>}
                          {c.stop && <span className="cand-stop">止损 {c.stop}</span>}
                        </div>
                        {c.risk && <div className="pick-row"><span className="pick-k risk">风险</span>{c.risk}</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {res.note && <div className="play-risk"><Icon name="shield" size={14} /><span>{res.note}</span></div>}
            <div className="play-disclaimer">量化打分(多因子)+ AI 综合研判，基于实时数据，仅供研究参考，非投资建议</div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- 精选候选池（涨停/异动/涨速/资金 合成带标签列表） ----------
function CandidatePool({ zt, movers, speed, sectors }) {
  const [tab, setTab] = useState('hot') // hot(综合) | limit | inflow | speed
  const [colSort, setColSort] = useState(null) // { key, dir } 表头点击排序；null=用默认榜单排序
  const book = usePlanStore()

  const clickHead = (key) => setColSort((c) => {
    if (!c || c.key !== key) return { key, dir: 'desc' }
    if (c.dir === 'desc') return { key, dir: 'asc' }
    return null
  })
  const Th = ({ label, k }) => (
    <th className={'th-sort' + (colSort && colSort.key === k ? ' active' : '')} onClick={() => clickHead(k)}>
      <span className="th-inner">{label}
        <span className="th-arrow">{colSort && colSort.key === k ? (colSort.dir === 'asc' ? '↑' : '↓') : '⇅'}</span>
      </span>
    </th>
  )

  const rows = useMemo(() => {
    const map = new Map()
    const push = (s, tag) => {
      if (!s.code) return
      if (!map.has(s.code)) map.set(s.code, { code: s.code, name: s.name, price: s.price, pct: s.pct, tags: [], mainInflow: s.mainInflow || 0, lbc: s.lbc, speed: s.speed })
      const o = map.get(s.code)
      if (!o.tags.includes(tag)) o.tags.push(tag)
      if (s.price) o.price = s.price
      if (s.mainInflow) o.mainInflow = s.mainInflow
      if (s.lbc) o.lbc = s.lbc
      if (s.speed !== undefined) o.speed = s.speed
    }
    ;(zt?.list || []).slice(0, 20).forEach((s) => push({ ...s, mainInflow: s.fundAmount }, s.lbc >= 2 ? `${s.lbc}连板` : '涨停'))
    ;(movers?.list || []).slice(0, 20).forEach((s) => push(s, '主力抢筹'))
    ;(speed?.list || []).slice(0, 15).forEach((s) => push(s, '涨速'))

    let arr = [...map.values()]
    if (tab === 'limit') arr = arr.filter((x) => x.tags.some((t) => t.includes('板') || t === '涨停'))
    else if (tab === 'inflow') arr = arr.filter((x) => x.tags.includes('主力抢筹')).sort((a, b) => b.mainInflow - a.mainInflow)
    else if (tab === 'speed') arr = arr.filter((x) => x.tags.includes('涨速')).sort((a, b) => (b.speed || 0) - (a.speed || 0))
    else arr = arr.sort((a, b) => b.tags.length - a.tags.length || b.mainInflow - a.mainInflow) // 综合：多标签优先
    arr = arr.slice(0, 30)
    // 表头点击排序（覆盖默认榜单排序）
    if (colSort) {
      const { key, dir } = colSort
      arr = [...arr].sort((a, b) => {
        const va = Number(a[key]) || 0, vb = Number(b[key]) || 0
        return dir === 'asc' ? va - vb : vb - va
      })
    }
    return arr
  }, [zt, movers, speed, tab, colSort])

  const tabs = [['hot', '综合精选'], ['limit', '涨停连板'], ['inflow', '主力抢筹'], ['speed', '涨速异动']]

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="fire" size={16} /> 今日精选候选池</div>
        <div className="tabs">
          {tabs.map(([k, t]) => (
            <div key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => { setTab(k); setColSort(null) }}>{t}</div>
          ))}
        </div>
      </div>
      <div className="scroll" style={{ maxHeight: 520 }}>
        <table className="tbl">
          <thead>
            <tr><th>名称</th><Th label="现价" k="price" /><Th label="涨幅" k="pct" /><th>信号</th><Th label="主力/封资" k="mainInflow" /><th style={{ textAlign: 'center' }}>操作</th></tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const added = book.plan.some((x) => x.code === s.code)
              return (
                <tr key={s.code}>
                  <td>
                    <StockName code={s.code} name={s.name}><span>{s.name}<span className="sub-name">{s.code}</span></span></StockName>
                  </td>
                  <td className={pctClass(s.pct)}>{s.price ? fmtRaw(s.price) : '--'}</td>
                  <td className={pctClass(s.pct)}>{fmtPct(s.pct)}</td>
                  <td>
                    {s.tags.slice(0, 3).map((t, i) => (
                      <span key={i} className={'sig-tag' + (t.includes('板') || t === '涨停' ? ' lu' : t === '主力抢筹' ? ' in' : ' sp')}>{t}</span>
                    ))}
                  </td>
                  <td className={s.mainInflow >= 0 ? 'red' : 'green'}>{s.mainInflow ? fmtInflow(s.mainInflow) : '--'}</td>
                  <td style={{ textAlign: 'center' }}>
                    <button className={'chip-btn' + (added ? ' done' : '')} disabled={added} onClick={() => planStore.addPlan({ code: s.code, name: s.name })}>
                      <Icon name={added ? 'check' : 'plus'} size={13} />{added ? '已加' : '加自选'}
                    </button>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && <tr><td colSpan={6} className="empty">暂无数据，开盘后逐步更新</td></tr>}
          </tbody>
        </table>
        <div className="legend" style={{ padding: '8px 14px' }}>
          综合精选按信号重叠度排序 · 点表头「现价/涨幅/主力」切换正倒序 · 点名称看详情K线 · 点「加自选」进入计划
        </div>
      </div>
    </div>
  )
}
