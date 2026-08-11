import { useState, useRef, useEffect, lazy, Suspense } from 'react'
import Icon from './components/Icon'
import StockDetail from './components/StockDetail'
import ErrorBoundary from './components/ErrorBoundary'
import AuthGate, { AccountMenu } from './components/AuthGate'
import { usePolling, isTradingHours, useCountdown, triggerRefresh, useRefreshTick } from './hooks'
import { usePlanStore, planStore } from './planStore'
import { useAIStore, aiStore } from './aiStore'
import { useAuthStore, authStore, startCloudSync } from './authStore'
import { useTheme, themeStore } from './themeStore'
import { useDetailStore, detailStore } from './detailStore'
import { alertStore, useAlertStore } from './alertStore'
import { useLLMConfigOpen } from './llmConfigStore'
import { useQuantReportOpen } from './quantReportUiStore'
import { useQuantModelStore } from './quantModelStore'
import { timeStr } from './format'
import { api } from './apiBase'
import { accountRequestHeaders } from './quantModel'
import { chunkReloadKey, shouldReloadChunk } from './chunkError'

// 按需分包：四个主 Tab 与 AI 助手拆成独立 chunk，首屏只加载当前 Tab，
// 切换时才拉取对应 chunk（配合 Rolldown codeSplitting），缩短首屏体积与白屏时间。
function lazyWithReload(loader, name) {
  return lazy(async () => {
    try {
      const module = await loader()
      try { sessionStorage.removeItem(chunkReloadKey(name)) } catch { /* ignore */ }
      return module
    } catch (error) {
      if (shouldReloadChunk(error, name)) {
        window.location.reload()
        return new Promise(() => {})
      }
      throw error
    }
  })
}
const TodayTab = lazyWithReload(() => import('./components/TodayTab'), 'today')
const PlanTab = lazyWithReload(() => import('./components/PlanTab'), 'plan')
const ResearchTab = lazyWithReload(() => import('./components/ResearchTab'), 'research')
const AccountHub = lazyWithReload(() => import('./components/AccountHub'), 'account-hub')
const AIAssistant = lazyWithReload(() => import('./components/AIAssistant'), 'assistant')
const LLMConfig = lazyWithReload(() => import('./components/LLMConfig'), 'llm-config')
const QuantReport = lazyWithReload(() => import('./components/QuantReport'), 'quant-report')
const QuantModelControl = lazyWithReload(() => import('./components/QuantModelControl'), 'quant-model-control')

// Tab 切换时的轻量骨架占位（避免 Suspense fallback 空白闪一下）
function TabSkeleton() {
  return (
    <div className="tab-skeleton" style={{ padding: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh', color: 'var(--muted, #888)' }}>
      <Icon name="refresh" size={16} className="spin" />
      <span style={{ marginLeft: 8 }}>正在加载…</span>
    </div>
  )
}

const TABS = [
  { key: 'today', label: '今日选股', icon: 'radar' },
  { key: 'plan', label: '持仓·做T', icon: 'wallet' },
  { key: 'hub', label: '账户·交易', icon: 'gauge' },
  { key: 'research', label: '盘面研究', icon: 'layers' },
]

export default function App() {
  const { user, booting } = useAuthStore()
  useEffect(() => {
    authStore.boot(); startCloudSync()   // 启动时尝试恢复会话 + 开启跨设备同步轮询
    import('./adviceBatch').then((m) => m.startBatchStatusSync()).catch(() => {})
  }, [])
  useEffect(() => {
    if (!user) return
    // 预置并发上限=承接 advisor 角色的端点数(首屏即可门控;之后随云端 batchProgress.concurrency 覆盖为权威值)
    fetch(api('/api/llm_config'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...accountRequestHeaders(),
      },
      body: JSON.stringify({ action: 'get' }),
    })
      .then((r) => r.json()).then((j) => { if (j && j.ok && Number(j.concurrency) > 0) import('./adviceBatch').then((m) => m.seedConcurrency(Number(j.concurrency))).catch(() => {}) })
      .catch(() => { /* 拿不到就用默认 1,不阻断 */ })
  }, [user])
  if (booting) return (
    <div className="auth-gate"><div className="auth-card" style={{ textAlign: 'center' }}>
      <div className="auth-brand"><span className="nav-logo"><Icon name="logo" size={20} /></span><span>短线操盘台</span></div>
      <div className="play-hint"><Icon name="refresh" size={14} className="spin" /> 正在恢复登录…</div>
    </div></div>
  )
  if (!user) return <AuthGate />   // 未登录 → 全屏登录/注册门户
  return <MainApp key={user} />    // key=user：切换账号时整树重挂
}

function MainApp() {
  const [tab, setTab] = useState('today')
  const [hubSub, setHubSub] = useState('account') // 账户·交易 融合页的子页
  const [hubNonce, setHubNonce] = useState(0)      // 每次外部要求跳预警时自增，强制生效
  // D-15 PWA 快捷方式:manifest shortcuts 带 ?tab=hub&sub=alert 直达对应子页
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search)
      const t = sp.get('tab')
      const sub = sp.get('sub')
      if (t) setTab(t)
      if (sub) { setHubSub(sub); setHubNonce((n) => n + 1) }
    } catch { /* ignore */ }
  }, [])
  const { open: aiOpen } = useAIStore()
  const theme = useTheme()
  const { stock: detailStock } = useDetailStore()
  const llmConfigOpen = useLLMConfigOpen()
  const quantReportOpen = useQuantReportOpen()
  const quantModelState = useQuantModelStore()
  const trading = isTradingHours()
  const interval = trading ? 20000 : 120000

  // 主流程共享数据（今日选股 / 复盘 / 助手 用）
  const market = usePolling('/api/market', interval)
  const sectors = usePolling('/api/sectors?type=industry&sort=main', interval)
  const ztPool = usePolling('/api/board?type=limitup&kind=zt', interval)
  const moversData = usePolling('/api/board?type=movers&kind=inflow', interval)
  const speedData = usePolling('/api/board?type=movers&kind=speed', interval)

  const refreshTick = useRefreshTick()
  const remain = useCountdown(interval, (market.data && market.data.updatedAt) + refreshTick)
  const book = usePlanStore()
  const planCount = book.plan.length + book.holding.length

  // ===== 盯盘预警：轮询所有“启用中预警”涉及的个股报价 → 逐条判断命中 =====
  const alertCodes = [...new Set((book.alerts || []).filter((a) => a.enabled).map((a) => a.code))]
  const alertInterval = trading ? 15000 : 60000
  const alertQuotes = usePolling(
    alertCodes.length ? `/api/quote?codes=${alertCodes.join(',')}` : null,
    alertInterval,
    [alertCodes.join(',')]
  )
  useEffect(() => {
    const list = (alertQuotes.data && alertQuotes.data.list) || []
    if (!list.length) return
    const map = {}
    list.forEach((q) => { map[q.code] = q })
    alertStore.evaluate(map)
  }, [alertQuotes.data])

  // ===== 每日自动重生成 AI 操作建议：作为复盘/主行动/止盈止损的唯一数据源 =====
  // 拉持仓股+自选股实时报价供算浮盈亏；每分钟检查一次是否到点（内部按天/按间隔去重）
  const holdCodes = [...new Set(book.holding.map((x) => x.code))]
  const watchCodes = [...new Set((book.plan || []).map((x) => x.code))]
  const schedCodes = [...new Set([...holdCodes, ...watchCodes])]
  const reviewQuotes = usePolling(
    schedCodes.length ? `/api/quote?codes=${schedCodes.join(',')}` : null,
    60000,
    [schedCodes.join(',')]
  )
  // ===== AI建议事后回测（短线实战口径）：对≥1天前未核验建议，拉近期日K线 =====
  // 判定"3日窗口内最高价是否触及目标价"，比单看隔日收盘更贴合短线，故取日K而非现价。
  const DAY_MS = 24 * 3600 * 1000
  const ripeCodes = [...new Set(
    (book.adviceLog || [])
      .filter((r) => !r.verified && (Date.now() - r.at) >= DAY_MS)
      .map((r) => r.code)
  )].slice(0, 12) // 逐只拉K线，限流保护，一轮最多12只
  const ripeKey = ripeCodes.join(',')
  useEffect(() => {
    if (!ripeCodes.length) return
    let cancelled = false
    const run = async () => {
      const candleMap = {}
      // 并发拉每只的近8根日K（覆盖3日窗口+缓冲），复用 stock_detail（不新增函数）
      await Promise.all(ripeCodes.map(async (code) => {
        try {
          const res = await fetch(api(`/api/stock_detail?code=${code}&klt=101&lmt=8`))
          const j = await res.json()
          if (j && j.ok && Array.isArray(j.candles) && j.candles.length) {
            candleMap[code] = j.candles.map((c) => ({
              date: c.date, open: c.open, close: c.close, high: c.high, low: c.low,
            }))
          }
        } catch { /* 单只失败忽略，其余照常核验 */ }
      }))
      if (!cancelled && Object.keys(candleMap).length) planStore.verifyAdvice(candleMap)
    }
    run()
    const id = setInterval(run, 300000) // 5分钟一轮
    return () => { cancelled = true; clearInterval(id) }
  }, [ripeKey])


  // 数据快照给 AI（避免频繁重建）
  const dataRef = useRef({})
  dataRef.current = {
    market: market.data,
    sectors: sectors.data,
    limitPool: ztPool.data,
    movers: moversData.data,
    speed: speedData.data,
    quotes: (reviewQuotes.data && reviewQuotes.data.list) || [],
  }
  const snapshot = () => dataRef.current

  // ===== 键盘快捷键：1-4 切换主 Tab；ESC 关闭详情/助手；/ 或 A 唤起助手 =====
  useEffect(() => {
    const onKey = (e) => {
      // 在输入框/文本域/可编辑元素里打字时不拦截
      const el = e.target
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        // 优先关最上层：详情弹窗 → 助手抽屉
        if (detailStore.get().stock) { detailStore.close(); return }
        aiStore.close()
        return
      }
      if (typing) return
      const idx = { '1': 0, '2': 1, '3': 2, '4': 3 }[e.key]
      if (idx != null && TABS[idx]) { setTab(TABS[idx].key); return }
      if (e.key === '/' || e.key === 'a' || e.key === 'A') { e.preventDefault(); aiStore.toggle() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={'app' + (aiOpen ? ' with-ai' : '')}>
      {/* 顶部导航 */}
      <header className="nav">
        <div className="nav-inner">
          <div className="nav-brand">
            <span className="nav-logo"><Icon name="logo" size={18} /></span>
            <span className="nav-name">短线操盘台</span>
          </div>
          <nav className="nav-tabs">
            {TABS.map((t) => (
              <button key={t.key} className={'nav-tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
                <Icon name={t.icon} size={16} />
                <span>{t.label}</span>
                {t.key === 'plan' && planCount > 0 && <span className="nav-badge">{planCount}</span>}
              </button>
            ))}
          </nav>
          <div className="nav-meta">
            <span className={'nav-status ' + (trading ? 'on' : 'off')}>
              <span className="status-dot" />{trading ? '交易中' : '休市'}
            </span>
            <button className="nav-refresh" onClick={triggerRefresh} title="立即刷新数据">
              <Icon name="refresh" size={13} /><span>{remain}s</span>
            </button>
            <UndoButton />
            <AlertBell onOpen={() => { setHubSub('alert'); setHubNonce((n) => n + 1); setTab('hub') }} />
            <button className="icon-btn nav-theme" onClick={themeStore.toggle} title={theme === 'dark' ? '切到白天模式' : '切到夜间模式'}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
            </button>
            <AccountMenu />
          </div>
        </div>
      </header>

      <main className="main">
        <ErrorBoundary key={tab} label="页面">
          <Suspense fallback={<TabSkeleton />}>
            {tab === 'today' && <TodayTab interval={interval} market={market.data} sectors={sectors.data} snapshot={snapshot} />}
            {tab === 'plan' && <PlanTab interval={interval} />}
            {tab === 'hub' && <AccountHub interval={interval} snapshot={snapshot} initialSub={hubSub} jumpNonce={hubNonce} />}
            {tab === 'research' && <ResearchTab interval={interval} />}
          </Suspense>
        </ErrorBoundary>
      </main>

      <footer className="footer">
        数据来源：东方财富公开接口 · AI 分析由大模型基于实时数据生成，仅供研究参考，非投资建议 · 资金流为已发生数据，追高有滞后风险，注意止损
      </footer>

      <ErrorBoundary label="AI 助手">
        <Suspense fallback={null}>
          <AIAssistant snapshot={snapshot} />
        </Suspense>
      </ErrorBoundary>

      {/* 全局个股详情弹窗：任意页面点击股票名都会打开。用 ErrorBoundary 兜底，
          任一渲染异常只降级为"重试"占位，绝不再黑屏拖垮整个应用 */}
      {detailStock && (
        <ErrorBoundary label="个股详情">
          <StockDetail stock={detailStock} onClose={() => detailStore.close()} />
        </ErrorBoundary>
      )}

      {/* AI 模型配置向导:低频操作,入口藏在账号菜单;懒加载,仅打开时挂载 */}
      {llmConfigOpen && (
        <ErrorBoundary label="AI 模型配置">
          <Suspense fallback={null}>
            <LLMConfig />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* 量化汇报弹窗:入口在账号菜单,与「AI 模型配置」并列;懒加载,仅打开时挂载 */}
      {quantReportOpen && (
        <ErrorBoundary label="量化汇报">
          <Suspense fallback={null}>
            <QuantReport />
          </Suspense>
        </ErrorBoundary>
      )}

      {quantModelState.open && (
        <ErrorBoundary label="量化模型配置">
          <Suspense fallback={null}>
            <QuantModelControl />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  )
}

// 导航栏预警铃铛：显示未读数，点击跳到「账户·交易 → 盯盘预警」子页
function AlertBell({ onOpen }) {
  const { unread } = useAlertStore()
  return (
    <button className="icon-btn nav-bell" onClick={onOpen} title="盯盘预警">
      <Icon name="bell" size={15} />
      {unread > 0 && <span className="nav-bell-dot">{unread > 9 ? '9+' : unread}</span>}
    </button>
  )
}

// 导航栏「撤回」按钮：一步步撤销买入/清仓/做T等交易操作（本次会话内的后悔药）
function UndoButton() {
  usePlanStore() // 订阅：交易操作后重渲染，刷新可撤回状态
  const [toast, setToast] = useState('')
  const can = planStore.canUndo()
  const label = planStore.lastUndoLabel()
  const n = planStore.undoCount()
  const doUndo = () => {
    const restored = planStore.undo()
    if (restored) {
      setToast(`已撤回：${restored}`)
      setTimeout(() => setToast(''), 2200)
    }
  }
  return (
    <div className="undo-wrap">
      <button className="icon-btn nav-undo" onClick={doUndo} disabled={!can}
        title={can ? `撤回上一步：${label}（还可撤回 ${n} 步）` : '暂无可撤回的操作'}>
        <Icon name="refresh" size={15} className="flip-x" />
        {n > 0 && <span className="nav-undo-dot">{n > 9 ? '9+' : n}</span>}
      </button>
      {toast && (
        <span className="undo-toast" key={toast + Date.now()}>
          {toast}
          <span className="ut-bar" />
        </span>
      )}
    </div>
  )
}
